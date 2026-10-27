//! Maiko DAW Bridge: stereo VST3 passthrough + a local capture tap before ASIO.
#![allow(non_snake_case, non_upper_case_globals)]
mod transport;
#[cfg(windows)]
mod view;
use std::ffi::{c_char, c_void};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use transport::{Transport, FRAMES};
use vst3::{uid, Class, ComWrapper, Steinberg::Vst::*, Steinberg::*};

const NAME: &str = "Maiko DAW Bridge";
pub const PROCESSOR_ID: TUID = uid(0x4D41494B, 0x4F444157, 0x42524944, 0x47453031);
const CONTROLLER_ID: TUID = uid(0x4D41494B, 0x4F444157, 0x4354524C, 0x30303031);
fn text(src: &str, dst: &mut [c_char]) {
    dst.fill(0);
    let count = src.len().min(dst.len().saturating_sub(1));
    for (a, b) in src.bytes().take(count).zip(dst.iter_mut()) { *b = a as c_char; }
}
fn wide(src: &str, dst: &mut [u16]) {
    dst.fill(0);
    let count = dst.len().saturating_sub(1);
    for (a, b) in src.encode_utf16().take(count).zip(dst.iter_mut()) { *b = a; }
}

struct Processor {
    transport: Arc<Transport>, worker: Option<JoinHandle<()>>,
    rate: AtomicU32, sequence: AtomicU32, realtime: AtomicBool,
}
impl Processor {
    fn new() -> Self {
        let (transport, worker) = Transport::start();
        Self { transport, worker, rate: AtomicU32::new(48000),
            sequence: AtomicU32::new(0), realtime: AtomicBool::new(true) }
    }
}
impl Drop for Processor {
    fn drop(&mut self) {
        self.transport.stop();
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}
impl Class for Processor { type Interfaces = (IComponent, IAudioProcessor, IProcessContextRequirements, IEditController); }
impl IPluginBaseTrait for Processor {
    unsafe fn initialize(&self, _: *mut FUnknown) -> tresult { kResultOk }
    unsafe fn terminate(&self) -> tresult { kResultOk }
}
impl IComponentTrait for Processor {
    // SDK SingleComponentEffect model: the host queries IEditController on
    // this component. Each editor therefore sees its own live meter/receiver.
    unsafe fn getControllerClassId(&self, _: *mut TUID) -> tresult { kNotImplemented }
    unsafe fn setIoMode(&self, _: IoMode) -> tresult { kResultOk }
    unsafe fn getBusCount(&self, media: MediaType, direction: BusDirection) -> i32 {
        i32::from(media == MediaTypes_::kAudio as i32 && (direction == 0 || direction == 1))
    }
    unsafe fn getBusInfo(&self, media: MediaType, direction: BusDirection, index: i32, bus: *mut BusInfo) -> tresult {
        if media != MediaTypes_::kAudio as i32 || index != 0 || !(0..=1).contains(&direction) || bus.is_null() { return kInvalidArgument; }
        *bus = std::mem::zeroed();
        (*bus).mediaType = media; (*bus).direction = direction; (*bus).channelCount = 2;
        (*bus).busType = BusTypes_::kMain as i32;
        (*bus).flags = BusInfo_::BusFlags_::kDefaultActive as u32;
        wide(if direction == 0 { "Stereo input" } else { "Stereo output" }, &mut (*bus).name);
        kResultOk
    }
    unsafe fn getRoutingInfo(&self, _: *mut RoutingInfo, _: *mut RoutingInfo) -> tresult { kNotImplemented }
    unsafe fn activateBus(&self, _: MediaType, _: BusDirection, _: i32, _: TBool) -> tresult { kResultOk }
    unsafe fn setActive(&self, _: TBool) -> tresult { kResultOk }
    unsafe fn setState(&self, _: *mut IBStream) -> tresult { kResultOk }
    unsafe fn getState(&self, _: *mut IBStream) -> tresult { kResultOk }
}
impl IAudioProcessorTrait for Processor {
    unsafe fn setBusArrangements(&self, ins: *mut SpeakerArrangement, nins: i32, outs: *mut SpeakerArrangement, nouts: i32) -> tresult {
        if nins == 1 && nouts == 1 && !ins.is_null() && !outs.is_null()
            && *ins == SpeakerArr::kStereo && *outs == SpeakerArr::kStereo { kResultOk } else { kResultFalse }
    }
    unsafe fn getBusArrangement(&self, dir: BusDirection, index: i32, arr: *mut SpeakerArrangement) -> tresult {
        if index != 0 || !(0..=1).contains(&dir) || arr.is_null() { return kInvalidArgument; }
        *arr = SpeakerArr::kStereo; kResultOk
    }
    unsafe fn canProcessSampleSize(&self, size: i32) -> tresult {
        if size == SymbolicSampleSizes_::kSample32 as i32 || size == SymbolicSampleSizes_::kSample64 as i32 { kResultOk } else { kResultFalse }
    }
    unsafe fn getLatencySamples(&self) -> u32 { 0 }
    unsafe fn setupProcessing(&self, setup: *mut ProcessSetup) -> tresult {
        if setup.is_null() || !(*setup).sampleRate.is_finite() || !(8000.0..=384000.0).contains(&(*setup).sampleRate) { return kInvalidArgument; }
        self.rate.store((*setup).sampleRate.round() as u32, Ordering::Relaxed);
        self.realtime.store((*setup).processMode != ProcessModes_::kOffline as i32, Ordering::Relaxed);
        kResultOk
    }
    unsafe fn setProcessing(&self, _: TBool) -> tresult { kResultOk }
    unsafe fn process(&self, data: *mut ProcessData) -> tresult {
        if data.is_null() { return kInvalidArgument; }
        let d = &*data;
        if d.numSamples <= 0 || d.numInputs != 1 || d.numOutputs != 1 || d.inputs.is_null() || d.outputs.is_null() { return kResultOk; }
        let input = &*d.inputs;
        let output = &mut *d.outputs;
        if input.numChannels != 2 || output.numChannels != 2 { return kResultFalse; }
        let n = d.numSamples as usize;
        output.silenceFlags = input.silenceFlags;
        let capture = self.realtime.load(Ordering::Relaxed) && d.processMode != ProcessModes_::kOffline as i32 && self.transport.connected();
        let rate = self.rate.load(Ordering::Relaxed);
        // Raw accesses support the host's normal in-place processing. Local
        // output is bit-for-bit passthrough, including 64-bit DAW processing.
        macro_rules! process_samples {
            ($field:ident, $ty:ty) => {{
                let ins = input.__field0.$field;
                let outs = output.__field0.$field;
                if ins.is_null() || outs.is_null() { return kInvalidArgument; }
                for ch in 0..2 {
                    if (*outs.add(ch)).is_null() { return kInvalidArgument; }
                    let silent = input.silenceFlags & (1 << ch) != 0;
                    if !silent && (*ins.add(ch)).is_null() { return kInvalidArgument; }
                    for i in 0..n { *(*outs.add(ch)).add(i) = if silent { 0.0 } else { *(*ins.add(ch)).add(i) }; }
                }
                let mut peaks = [0.0f32; 2];
                for ch in 0..2 { for i in 0..n {
                    let value = (*(*outs.add(ch)).add(i) as f32).abs();
                    if value.is_finite() { peaks[ch] = peaks[ch].max(value); }
                } }
                self.transport.meter(peaks[0], peaks[1]);
                if capture {
                    for start in (0..n).step_by(FRAMES) {
                        let count = (n - start).min(FRAMES);
                        let seq = self.sequence.fetch_add(1, Ordering::Relaxed);
                        self.transport.push(rate, seq, count, |frame, channel| *(*outs.add(channel)).add(start + frame) as f32);
                    }
                }
            }};
        }
        if d.symbolicSampleSize == SymbolicSampleSizes_::kSample32 as i32 { process_samples!(channelBuffers32, f32); }
        else if d.symbolicSampleSize == SymbolicSampleSizes_::kSample64 as i32 { process_samples!(channelBuffers64, f64); }
        else { return kInvalidArgument; }
        kResultOk
    }
    unsafe fn getTailSamples(&self) -> u32 { 0 }
}
impl IProcessContextRequirementsTrait for Processor { unsafe fn getProcessContextRequirements(&self) -> u32 { 0 } }

impl IEditControllerTrait for Processor {
    unsafe fn setComponentState(&self, _: *mut IBStream) -> tresult { kResultOk }
    unsafe fn setState(&self, _: *mut IBStream) -> tresult { kResultOk }
    unsafe fn getState(&self, _: *mut IBStream) -> tresult { kResultOk }
    unsafe fn getParameterCount(&self) -> i32 { 0 }
    unsafe fn getParameterInfo(&self, _: i32, _: *mut ParameterInfo) -> tresult { kInvalidArgument }
    unsafe fn getParamStringByValue(&self, _: u32, _: f64, _: *mut String128) -> tresult { kInvalidArgument }
    unsafe fn getParamValueByString(&self, _: u32, _: *mut TChar, _: *mut f64) -> tresult { kInvalidArgument }
    unsafe fn normalizedParamToPlain(&self, _: u32, value: f64) -> f64 { value }
    unsafe fn plainParamToNormalized(&self, _: u32, value: f64) -> f64 { value }
    unsafe fn getParamNormalized(&self, _: u32) -> f64 { 0.0 }
    unsafe fn setParamNormalized(&self, _: u32, _: f64) -> tresult { kInvalidArgument }
    unsafe fn setComponentHandler(&self, _: *mut IComponentHandler) -> tresult { kResultOk }
    unsafe fn createView(&self, name: *const c_char) -> *mut IPlugView {
        if name.is_null() || std::ffi::CStr::from_ptr(name).to_bytes() != b"editor" { return ptr::null_mut(); }
        #[cfg(windows)]
        { return ComWrapper::new(view::View::new(self.transport.clone())).to_com_ptr::<IPlugView>().unwrap().into_raw(); }
        #[cfg(not(windows))]
        ptr::null_mut()
    }
}

// Legacy controller class retained for hosts with old factory metadata cached.
// Current hosts query the component directly to get its native editor.
struct Controller;
impl Class for Controller { type Interfaces = (IEditController,); }
impl IPluginBaseTrait for Controller {
    unsafe fn initialize(&self, _: *mut FUnknown) -> tresult { kResultOk }
    unsafe fn terminate(&self) -> tresult { kResultOk }
}
impl IEditControllerTrait for Controller {
    unsafe fn setComponentState(&self, _: *mut IBStream) -> tresult { kResultOk }
    unsafe fn setState(&self, _: *mut IBStream) -> tresult { kResultOk }
    unsafe fn getState(&self, _: *mut IBStream) -> tresult { kResultOk }
    unsafe fn getParameterCount(&self) -> i32 { 0 }
    unsafe fn getParameterInfo(&self, _: i32, _: *mut ParameterInfo) -> tresult { kInvalidArgument }
    unsafe fn getParamStringByValue(&self, _: u32, _: f64, _: *mut String128) -> tresult { kInvalidArgument }
    unsafe fn getParamValueByString(&self, _: u32, _: *mut TChar, _: *mut f64) -> tresult { kInvalidArgument }
    unsafe fn normalizedParamToPlain(&self, _: u32, value: f64) -> f64 { value }
    unsafe fn plainParamToNormalized(&self, _: u32, value: f64) -> f64 { value }
    unsafe fn getParamNormalized(&self, _: u32) -> f64 { 0.0 }
    unsafe fn setParamNormalized(&self, _: u32, _: f64) -> tresult { kInvalidArgument }
    unsafe fn setComponentHandler(&self, _: *mut IComponentHandler) -> tresult { kResultOk }
    unsafe fn createView(&self, _: *const c_char) -> *mut IPlugView { ptr::null_mut() }
}
struct Factory;
impl Class for Factory { type Interfaces = (IPluginFactory, IPluginFactory2); }
impl IPluginFactoryTrait for Factory {
    unsafe fn getFactoryInfo(&self, info: *mut PFactoryInfo) -> tresult {
        if info.is_null() { return kInvalidArgument; }
        *info = std::mem::zeroed(); text("Maiko", &mut (*info).vendor);
        text("https://github.com/Wolframi/Maiko-chat", &mut (*info).url);
        (*info).flags = PFactoryInfo_::FactoryFlags_::kUnicode as i32; kResultOk
    }
    unsafe fn countClasses(&self) -> i32 { 2 }
    unsafe fn getClassInfo(&self, index: i32, info: *mut PClassInfo) -> tresult {
        if !(0..=1).contains(&index) || info.is_null() { return kInvalidArgument; }
        *info = std::mem::zeroed();
        (*info).cid = if index == 0 { PROCESSOR_ID } else { CONTROLLER_ID };
        (*info).cardinality = PClassInfo_::ClassCardinality_::kManyInstances as i32;
        text(if index == 0 { "Audio Module Class" } else { "Component Controller Class" }, &mut (*info).category);
        text(NAME, &mut (*info).name); kResultOk
    }
    unsafe fn createInstance(&self, cid: FIDString, iid: FIDString, obj: *mut *mut c_void) -> tresult {
        if cid.is_null() || iid.is_null() || obj.is_null() { return kInvalidArgument; }
        *obj = ptr::null_mut();
        let id = ptr::read_unaligned(cid.cast::<TUID>());
        let instance = if id == PROCESSOR_ID { ComWrapper::new(Processor::new()).to_com_ptr::<FUnknown>() }
            else if id == CONTROLLER_ID { ComWrapper::new(Controller).to_com_ptr::<FUnknown>() } else { None };
        match instance {
            Some(instance) => { let p = instance.as_ptr(); ((*(*p).vtbl).queryInterface)(p, iid.cast(), obj) }
            None => kNoInterface,
        }
    }
}
impl IPluginFactory2Trait for Factory {
    unsafe fn getClassInfo2(&self, index: i32, info: *mut PClassInfo2) -> tresult {
        if !(0..=1).contains(&index) || info.is_null() { return kInvalidArgument; }
        *info = std::mem::zeroed();
        (*info).cid = if index == 0 { PROCESSOR_ID } else { CONTROLLER_ID };
        (*info).cardinality = PClassInfo_::ClassCardinality_::kManyInstances as i32;
        text(if index == 0 { "Audio Module Class" } else { "Component Controller Class" }, &mut (*info).category);
        text(NAME, &mut (*info).name); text("Fx|Tools", &mut (*info).subCategories);
        text("Maiko", &mut (*info).vendor); text("0.2.1", &mut (*info).version);
        text("vst3-rs 0.3.0", &mut (*info).sdkVersion); kResultOk
    }
}
#[no_mangle]
pub extern "system" fn InitDll() -> bool { true }
#[no_mangle]
pub extern "system" fn ExitDll() -> bool { #[cfg(windows)] view::shutdown(); true }
#[no_mangle]
pub extern "system" fn GetPluginFactory() -> *mut IPluginFactory {
    ComWrapper::new(Factory).to_com_ptr::<IPluginFactory>().unwrap().into_raw()
}
