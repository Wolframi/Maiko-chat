//! Local-only transport. The DAW's audio callback never waits, allocates, or
//! performs I/O. One worker owns the pipe and drains a bounded SPSC queue.
use std::cell::UnsafeCell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const FRAMES: usize = 256;
const SLOTS: usize = 16;
const SIZE: usize = 16 + FRAMES * 8;
struct Packet { bytes: [u8; SIZE], len: u32 }

pub struct Transport {
    slots: [UnsafeCell<Packet>; SLOTS],
    head: AtomicUsize,
    tail: AtomicUsize,
    connected: AtomicBool,
    stop: AtomicBool,
    peaks: [AtomicU32; 2],
    frames: AtomicU64,
}
// VST calls process() serially. Only that producer writes head/its current
// slot. Only the worker reads the published slot and writes tail. Release /
// acquire prevents either side reusing a slot while the other accesses it.
unsafe impl Sync for Transport {}

impl Transport {
    pub fn start() -> (Arc<Self>, Option<JoinHandle<()>>) {
        let shared = Arc::new(Self {
            slots: std::array::from_fn(|_| UnsafeCell::new(Packet { bytes: [0; SIZE], len: 0 })),
            head: AtomicUsize::new(0), tail: AtomicUsize::new(0),
            connected: AtomicBool::new(false), stop: AtomicBool::new(false),
            peaks: [AtomicU32::new(0), AtomicU32::new(0)], frames: AtomicU64::new(0),
        });
        let worker = shared.clone();
        let handle = thread::Builder::new().name("maiko-daw-pipe".into()).spawn(move || worker.run()).ok();
        (shared, handle)
    }
    pub fn stop(&self) { self.stop.store(true, Ordering::Release); }
    pub fn connected(&self) -> bool { self.connected.load(Ordering::Relaxed) }
    pub fn meter(&self, left: f32, right: f32) {
        self.peaks[0].store(left.to_bits(), Ordering::Relaxed);
        self.peaks[1].store(right.to_bits(), Ordering::Relaxed);
        self.frames.fetch_add(1, Ordering::Release);
    }
    pub fn levels(&self) -> (u64, [f32; 2]) {
        (self.frames.load(Ordering::Acquire), [f32::from_bits(self.peaks[0].load(Ordering::Relaxed)), f32::from_bits(self.peaks[1].load(Ordering::Relaxed))])
    }

    // The caller supplies samples without allocating or constructing slices
    // aliasing the host's in-place input/output buffers.
    pub fn push(&self, rate: u32, sequence: u32, frames: usize, sample: impl Fn(usize, usize) -> f32) {
        if !self.connected() || frames == 0 || frames > FRAMES { return; }
        let head = self.head.load(Ordering::Relaxed);
        let next = (head + 1) % SLOTS;
        if next == self.tail.load(Ordering::Acquire) { return; } // drop capture, never stall DAW
        let packet = unsafe { &mut *self.slots[head].get() };
        packet.bytes[..4].copy_from_slice(b"MKDA");
        packet.bytes[4..8].copy_from_slice(&rate.to_le_bytes());
        packet.bytes[8..10].copy_from_slice(&(frames as u16).to_le_bytes());
        packet.bytes[10..12].copy_from_slice(&2u16.to_le_bytes());
        packet.bytes[12..16].copy_from_slice(&sequence.to_le_bytes());
        for frame in 0..frames {
            for channel in 0..2 {
                let offset = 16 + (frame * 2 + channel) * 4;
                packet.bytes[offset..offset + 4].copy_from_slice(&sample(frame, channel).to_le_bytes());
            }
        }
        packet.len = (16 + frames * 8) as u32;
        self.head.store(next, Ordering::Release);
    }

    #[cfg(windows)]
    fn run(&self) {
        use win::*;
        static INSTANCE: AtomicUsize = AtomicUsize::new(0);
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() as u64
            ^ INSTANCE.fetch_add(1, Ordering::Relaxed) as u64;
        let name: Vec<u16> = format!(r"\\.\pipe\maiko-daw-v1-{}-{:016x}", std::process::id(), nonce)
            .encode_utf16().chain(Some(0)).collect();
        // Owner + SYSTEM only. The Windows default pipe ACL would also grant
        // read access to other users. Remote clients are explicitly rejected.
        let sddl: Vec<u16> = "D:P(A;;GA;;;SY)(A;;GA;;;OW)".encode_utf16().chain(Some(0)).collect();
        let mut descriptor = std::ptr::null_mut();
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) } == 0 { return; }
        let mut security = SecurityAttributes { length: std::mem::size_of::<SecurityAttributes>() as u32, descriptor, inherit: 0 };
        let pipe = unsafe { CreateNamedPipeW(name.as_ptr(), 3 | 0x00080000,
            4 | 2 | 1 | 8, 1, (SIZE * 8) as u32, 0, 0, (&mut security as *mut SecurityAttributes).cast()) };
        unsafe { LocalFree(descriptor); }
        if pipe == -1isize as *mut c_void { return; }
        let mut connected = false;
        while !self.stop.load(Ordering::Acquire) {
            if !connected {
                let result = unsafe { ConnectNamedPipe(pipe, std::ptr::null_mut()) };
                connected = result != 0 || unsafe { GetLastError() } == 535; // ERROR_PIPE_CONNECTED
                self.connected.store(connected, Ordering::Release);
            } else if unsafe { PeekNamedPipe(pipe, std::ptr::null_mut(), 0, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) } == 0 {
                connected = false;
                self.connected.store(false, Ordering::Release);
                unsafe { DisconnectNamedPipe(pipe); }
            }
            let tail = self.tail.load(Ordering::Relaxed);
            if tail != self.head.load(Ordering::Acquire) {
                let packet = unsafe { &*self.slots[tail].get() };
                if connected {
                    let mut written = 0;
                    let result = unsafe { WriteFile(pipe, packet.bytes.as_ptr().cast(), packet.len, &mut written, std::ptr::null_mut()) };
                    // Message mode + NOWAIT either writes the entire packet or
                    // zero bytes. A slow/disconnected reader never blocks us.
                    if result == 0 {
                        connected = false;
                        self.connected.store(false, Ordering::Release);
                        unsafe { DisconnectNamedPipe(pipe); }
                    }
                }
                self.tail.store((tail + 1) % SLOTS, Ordering::Release);
            } else {
                thread::sleep(Duration::from_millis(if connected { 2 } else { 10 }));
            }
        }
        self.connected.store(false, Ordering::Release);
        unsafe { DisconnectNamedPipe(pipe); CloseHandle(pipe); }
    }
    #[cfg(not(windows))]
    fn run(&self) {}
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    #[repr(C)]
    pub struct SecurityAttributes { pub length: u32, pub descriptor: *mut c_void, pub inherit: i32 }
    #[link(name = "advapi32")]
    extern "system" {
        pub fn ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl: *const u16, revision: u32, descriptor: *mut *mut c_void, size: *mut u32) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateNamedPipeW(name: *const u16, open: u32, mode: u32, max: u32, out: u32, input: u32, timeout: u32, security: *mut c_void) -> *mut c_void;
        pub fn ConnectNamedPipe(pipe: *mut c_void, overlapped: *mut c_void) -> i32;
        pub fn DisconnectNamedPipe(pipe: *mut c_void) -> i32;
        pub fn WriteFile(file: *mut c_void, bytes: *const c_void, size: u32, written: *mut u32, overlapped: *mut c_void) -> i32;
        pub fn CloseHandle(handle: *mut c_void) -> i32;
        pub fn GetLastError() -> u32;
        pub fn LocalFree(memory: *mut c_void) -> *mut c_void;
        pub fn PeekNamedPipe(pipe: *mut c_void, bytes: *mut c_void, size: u32, read: *mut u32, available: *mut u32, left: *mut u32) -> i32;
    }
}
