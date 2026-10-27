//! Isolated VST3 host for integration tests; no audio interface or DAW settings.
use std::{ffi::c_void, io::{self, BufRead}, ptr, sync::{Arc, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant}};
use vst3::{ComPtr, Interface, Steinberg::*, Steinberg::Vst::*};

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryW(name: *const u16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    fn FreeLibrary(module: *mut c_void) -> i32;
    fn GetModuleHandleW(name: *const u16) -> *mut c_void;
}
#[repr(C)] struct Message { window: *mut c_void, message: u32, w: usize, l: isize, time: u32, x: i32, y: i32, private: u32 }
#[link(name = "user32")]
extern "system" {
    fn CreateWindowExW(ex: u32, class: *const u16, title: *const u16, style: u32, x: i32, y: i32, width: i32, height: i32,
        parent: *mut c_void, menu: *mut c_void, instance: *mut c_void, parameter: *mut c_void) -> *mut c_void;
    fn DestroyWindow(window: *mut c_void) -> i32;
    fn ShowWindow(window: *mut c_void, command: i32) -> i32;
    fn PeekMessageW(message: *mut Message, window: *mut c_void, min: u32, max: u32, remove: u32) -> i32;
    fn TranslateMessage(message: *const Message) -> i32;
    fn DispatchMessageW(message: *const Message) -> isize;
    fn GetWindow(window: *mut c_void, command: u32) -> *mut c_void;
}
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
unsafe fn pump() {
    let mut message: Message = std::mem::zeroed();
    while PeekMessageW(&mut message, ptr::null_mut(), 0, 0, 1) != 0 { TranslateMessage(&message); DispatchMessageW(&message); }
}
fn main() {
    let mut args = std::env::args().skip(1);
    let filename = args.next().expect("VST3 binary path");
    let rate: f64 = args.next().unwrap_or("44100".into()).parse().unwrap();
    let use64 = args.next().as_deref() == Some("64");
    let seconds: u64 = args.next().unwrap_or("120".into()).parse().unwrap();
    let show = args.next().as_deref() == Some("ui");
    let delay: u64 = args.next().unwrap_or("0".into()).parse().unwrap();
    let left_hz: f64 = args.next().unwrap_or("1100".into()).parse().unwrap();
    let right_hz: f64 = args.next().unwrap_or("1650".into()).parse().unwrap();
    let filename_wide = wide(&filename);
    unsafe {
        let parent = CreateWindowExW(0, wide("STATIC").as_ptr(), wide("Maiko isolated DAW host").as_ptr(), 0x00c80000,
            40, 40, 456, 499, ptr::null_mut(), ptr::null_mut(), GetModuleHandleW(ptr::null()), ptr::null_mut());
        assert!(!parent.is_null());
        if show { ShowWindow(parent, 4); }
        println!("{{\"windowReady\":true,\"pid\":{},\"window\":{}}}", std::process::id(), parent as usize);
        let wait = Instant::now();
        while wait.elapsed().as_secs() < delay { pump(); thread::sleep(Duration::from_millis(5)); }
        let library = LoadLibraryW(filename_wide.as_ptr()); assert!(!library.is_null(), "Load VST3 DLL");
        let init: extern "system" fn() -> bool = std::mem::transmute(GetProcAddress(library, b"InitDll\0".as_ptr()));
        assert!(init());
        let factory_fn: extern "system" fn() -> *mut IPluginFactory = std::mem::transmute(GetProcAddress(library, b"GetPluginFactory\0".as_ptr()));
        {
            let factory = ComPtr::from_raw(factory_fn()).unwrap();
            assert_eq!(factory.countClasses(), 2);
            let mut info: PClassInfo = std::mem::zeroed();
            assert_eq!(factory.getClassInfo(0, &mut info), kResultOk);
            let mut raw = ptr::null_mut();
            assert_eq!(factory.createInstance(info.cid.as_ptr().cast(), IComponent::IID.as_ptr().cast(), &mut raw), kResultOk);
            let component = ComPtr::from_raw(raw.cast::<IComponent>()).unwrap();
            assert_eq!(component.initialize(ptr::null_mut()), kResultOk);
            let controller = component.cast::<IEditController>().expect("Single-component controller");
            let view = ComPtr::from_raw(controller.createView(b"editor\0".as_ptr().cast())).expect("Native VST3 editor");
            let mut size: ViewRect = std::mem::zeroed();
            assert_eq!(view.getSize(&mut size), kResultOk);
            assert_eq!((size.right, size.bottom), (440, 460));
            assert_eq!(view.isPlatformTypeSupported(b"HWND\0".as_ptr().cast()), kResultTrue);
            assert_eq!(view.isPlatformTypeSupported(b"X11\0".as_ptr().cast()), kResultFalse);
            assert_eq!(view.attached(parent, b"HWND\0".as_ptr().cast()), kResultOk);
            assert_eq!(view.canResize(), kResultFalse);
            let processor = component.cast::<IAudioProcessor>().unwrap();
            let mut setup: ProcessSetup = std::mem::zeroed();
            setup.sampleRate = rate; setup.maxSamplesPerBlock = 256;
            setup.symbolicSampleSize = if use64 { SymbolicSampleSizes_::kSample64 as i32 } else { SymbolicSampleSizes_::kSample32 as i32 };
            assert_eq!(processor.setupProcessing(&mut setup), kResultOk);
            assert_eq!(component.setActive(1), kResultOk);
            assert_eq!(processor.setProcessing(1), kResultOk);
            let mut left32 = [0.0f32; 256]; let mut right32 = [0.0f32; 256];
            let mut left64 = [0.0f64; 256]; let mut right64 = [0.0f64; 256];
            let mut out_left64 = [0.0f64; 256]; let mut out_right64 = [0.0f64; 256];
            let mut inputs32 = [left32.as_mut_ptr(), right32.as_mut_ptr()];
            let mut inputs64 = [left64.as_mut_ptr(), right64.as_mut_ptr()];
            let mut outputs64 = [out_left64.as_mut_ptr(), out_right64.as_mut_ptr()];
            let mut input: AudioBusBuffers = std::mem::zeroed();
            let mut output: AudioBusBuffers = std::mem::zeroed();
            input.numChannels = 2; output.numChannels = 2;
            if use64 {
                input.__field0.channelBuffers64 = inputs64.as_mut_ptr();
                output.__field0.channelBuffers64 = outputs64.as_mut_ptr();
            } else {
                input.__field0.channelBuffers32 = inputs32.as_mut_ptr();
                output.__field0.channelBuffers32 = inputs32.as_mut_ptr(); // in-place!
            }
            let mut data: ProcessData = std::mem::zeroed();
            data.symbolicSampleSize = setup.symbolicSampleSize;
            data.numSamples = 256; data.numInputs = 1; data.numOutputs = 1;
            data.inputs = &mut input; data.outputs = &mut output;
            println!("{{\"ready\":true,\"pid\":{},\"sampleRate\":{},\"bits\":{},\"editor\":{}}}", std::process::id(), rate, if use64 { 64 } else { 32 }, GetWindow(parent, 5) as usize);
            let paused = Arc::new(AtomicBool::new(false));
            let commands = paused.clone();
            thread::spawn(move || {
                for line in io::stdin().lock().lines().map_while(Result::ok) {
                    if line == "pause" || line == "play" {
                        commands.store(line == "pause", Ordering::Release);
                        println!("{{\"command\":\"{}\"}}", line);
                    }
                }
            });
            let start = Instant::now(); let mut next = start; let mut position = 0;
            while start.elapsed().as_secs() < seconds {
                pump();
                if paused.load(Ordering::Acquire) { thread::sleep(Duration::from_millis(5)); next = Instant::now(); continue; }
                for i in 0..256 {
                    let time = (position + i) as f64 / rate;
                    left64[i] = (time * left_hz * std::f64::consts::TAU).sin() * 0.1;
                    right64[i] = (time * right_hz * std::f64::consts::TAU).sin() * 0.1;
                    left32[i] = left64[i] as f32; right32[i] = right64[i] as f32;
                }
                assert_eq!(processor.process(&mut data), kResultOk);
                if use64 { assert_eq!(left64, out_left64); assert_eq!(right64, out_right64); }
                else {
                    for i in 0..256 { assert_eq!(left32[i], left64[i] as f32); assert_eq!(right32[i], right64[i] as f32); }
                }
                position += 256;
                next += Duration::from_secs_f64(256.0 / rate);
                if let Some(wait) = next.checked_duration_since(Instant::now()) { thread::sleep(wait); }
            }
            assert_eq!(processor.setProcessing(0), kResultOk);
            assert_eq!(component.setActive(0), kResultOk);
            assert_eq!(view.removed(), kResultOk);
            assert_eq!(component.terminate(), kResultOk);
        }
        let exit: extern "system" fn() -> bool = std::mem::transmute(GetProcAddress(library, b"ExitDll\0".as_ptr()));
        assert!(exit()); FreeLibrary(library);
        DestroyWindow(parent);
    }
}
