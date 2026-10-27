//! A native, self-contained VST3 editor. UI polling never touches the DAW audio
//! thread: levels and connection status are read from atomics on a 30 Hz timer.
use crate::transport::Transport;
use std::{cell::Cell, ffi::{c_char, c_void, CStr}, ptr, sync::{Arc, OnceLock}};
use vst3::{Class, Steinberg::*};
use win::*;
const WIDTH: i32 = 440;
const HEIGHT: i32 = 460;
static GDIPLUS: OnceLock<usize> = OnceLock::new();
static MODULE: OnceLock<usize> = OnceLock::new();
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
fn class_name() -> Vec<u16> { wide("MaikoDawBridgeEditor02") }

pub struct View { transport: Arc<Transport>, window: Cell<*mut c_void>, state: Cell<*mut State> }
struct State {
    transport: Arc<Transport>, levels: Cell<[f32; 2]>, last_frame: Cell<u64>, stale: Cell<u32>, phase: Cell<f32>,
}
impl View {
    pub fn new(transport: Arc<Transport>) -> Self { Self { transport, window: Cell::new(ptr::null_mut()), state: Cell::new(ptr::null_mut()) } }
    unsafe fn remove(&self) {
        let window = self.window.replace(ptr::null_mut());
        if !window.is_null() { KillTimer(window, 1); DestroyWindow(window); }
        let state = self.state.replace(ptr::null_mut());
        if !state.is_null() { drop(Box::from_raw(state)); }
    }
}
impl Drop for View { fn drop(&mut self) { unsafe { self.remove(); } } }
impl Class for View { type Interfaces = (IPlugView,); }
impl IPlugViewTrait for View {
    unsafe fn isPlatformTypeSupported(&self, kind: *const c_char) -> tresult {
        if !kind.is_null() && CStr::from_ptr(kind).to_bytes() == b"HWND" { kResultTrue } else { kResultFalse }
    }
    unsafe fn attached(&self, parent: *mut c_void, kind: *const c_char) -> tresult {
        if parent.is_null() || self.isPlatformTypeSupported(kind) != kResultTrue || !self.window.get().is_null() { return kResultFalse; }
        let token = GDIPLUS.get_or_init(|| {
            let input = StartupInput { version: 1, debug: ptr::null_mut(), suppress_thread: 0, suppress_codecs: 0 };
            let mut token = 0; if GdiplusStartup(&mut token, &input, ptr::null_mut()) == 0 { token } else { 0 }
        });
        if *token == 0 { return kResultFalse; }
        let module = *MODULE.get_or_init(|| {
            let mut module = ptr::null_mut(); GetModuleHandleExW(6, window_proc as *const () as *const u16, &mut module); module as usize
        }) as *mut c_void;
        let name = class_name();
        let class = WindowClass { style: 3, procedure: Some(window_proc), class_extra: 0, window_extra: 0,
            instance: module, icon: ptr::null_mut(), cursor: LoadCursorW(ptr::null_mut(), 32512usize as *const u16),
            background: ptr::null_mut(), menu: ptr::null(), name: name.as_ptr() };
        RegisterClassW(&class);
        let state = Box::into_raw(Box::new(State { transport: self.transport.clone(), levels: Cell::new([0.0; 2]),
            last_frame: Cell::new(0), stale: Cell::new(0), phase: Cell::new(0.0) }));
        let window = CreateWindowExW(0, name.as_ptr(), wide("Maiko DAW Bridge").as_ptr(), 0x56000000,
            0, 0, WIDTH, HEIGHT, parent, ptr::null_mut(), module, state.cast());
        if window.is_null() { drop(Box::from_raw(state)); return kResultFalse; }
        self.state.set(state); self.window.set(window); SetTimer(window, 1, 33, ptr::null_mut()); kResultOk
    }
    unsafe fn removed(&self) -> tresult { self.remove(); kResultOk }
    unsafe fn onWheel(&self, _: f32) -> tresult { kResultFalse }
    unsafe fn onKeyDown(&self, _: u16, _: i16, _: i16) -> tresult { kResultFalse }
    unsafe fn onKeyUp(&self, _: u16, _: i16, _: i16) -> tresult { kResultFalse }
    unsafe fn getSize(&self, size: *mut ViewRect) -> tresult {
        if size.is_null() { return kInvalidArgument; }
        *size = ViewRect { left: 0, top: 0, right: WIDTH, bottom: HEIGHT }; kResultOk
    }
    unsafe fn onSize(&self, size: *mut ViewRect) -> tresult {
        if size.is_null() { return kInvalidArgument; }
        if !self.window.get().is_null() { MoveWindow(self.window.get(), 0, 0, (*size).right - (*size).left, (*size).bottom - (*size).top, 1); }
        kResultOk
    }
    unsafe fn onFocus(&self, _: TBool) -> tresult { kResultOk }
    unsafe fn setFrame(&self, _: *mut IPlugFrame) -> tresult { kResultOk }
    unsafe fn canResize(&self) -> tresult { kResultFalse }
    unsafe fn checkSizeConstraint(&self, rect: *mut ViewRect) -> tresult {
        if rect.is_null() { return kInvalidArgument; }
        (*rect).right = (*rect).left + WIDTH; (*rect).bottom = (*rect).top + HEIGHT; kResultOk
    }
}

pub fn shutdown() { unsafe {
    if let Some(module) = MODULE.get() { UnregisterClassW(class_name().as_ptr(), *module as *mut c_void); }
    if let Some(token) = GDIPLUS.get() { if *token != 0 { GdiplusShutdown(*token); } }
} }

unsafe extern "system" fn window_proc(window: *mut c_void, message: u32, w: usize, l: isize) -> isize {
    if message == 0x81 { SetWindowLongPtrW(window, -21, *(l as *const isize)); return 1; }
    let state = GetWindowLongPtrW(window, -21) as *mut State;
    if message == 0x82 { SetWindowLongPtrW(window, -21, 0); }
    if message == 0x14 { return 1; }
    if !state.is_null() {
        if message == 0x113 {
            let state = &*state;
            let (frame, mut levels) = state.transport.levels();
            if frame == state.last_frame.get() { state.stale.set(state.stale.get().saturating_add(1)); } else { state.stale.set(0); }
            state.last_frame.set(frame);
            if state.stale.get() > 6 { levels = [0.0; 2]; }
            let previous = state.levels.get();
            for ch in 0..2 { levels[ch] = previous[ch] * 0.7 + levels[ch].min(1.0) * 0.3; }
            state.levels.set(levels); state.phase.set(state.phase.get() + 0.04);
            InvalidateRect(window, ptr::null(), 0); return 0;
        }
        if message == 0x318 { // WM_PRINTCLIENT: hosts can render the editor offscreen.
            let mut rect: Rect = std::mem::zeroed(); GetClientRect(window, &mut rect);
            draw(w as *mut c_void, rect.right, rect.bottom, &*state); return 0;
        }
        if message == 0x0f {
            let mut paint: Paint = std::mem::zeroed();
            let target = BeginPaint(window, &mut paint);
            let mut rect: Rect = std::mem::zeroed(); GetClientRect(window, &mut rect);
            let dc = CreateCompatibleDC(target);
            let bitmap = CreateCompatibleBitmap(target, rect.right.max(1), rect.bottom.max(1));
            let old = SelectObject(dc, bitmap);
            draw(dc, rect.right, rect.bottom, &*state);
            BitBlt(target, 0, 0, rect.right, rect.bottom, dc, 0, 0, 0x00cc0020);
            SelectObject(dc, old); DeleteObject(bitmap); DeleteDC(dc); EndPaint(window, &paint); return 0;
        }
    }
    DefWindowProcW(window, message, w, l)
}

unsafe fn solid(color: u32) -> *mut c_void { let mut brush = ptr::null_mut(); GdipCreateSolidFill(color, &mut brush); brush }
unsafe fn label(g: *mut c_void, family: *mut c_void, value: &str, x: f32, y: f32, width: f32, size: f32, bold: bool, color: u32, centered: bool) {
    let mut font = ptr::null_mut(); GdipCreateFont(family, size, i32::from(bold), 2, &mut font);
    let mut format = ptr::null_mut(); GdipCreateStringFormat(0, 0, &mut format);
    if centered { GdipSetStringFormatAlign(format, 1); }
    let text = wide(value); let area = RectF { x, y, width, height: size * 2.8 };
    let brush = solid(color);
    GdipDrawString(g, text.as_ptr(), (text.len() - 1) as i32, font, &area, format, brush);
    GdipDeleteBrush(brush); GdipDeleteStringFormat(format); GdipDeleteFont(font);
}
unsafe fn draw(dc: *mut c_void, width: i32, height: i32, state: &State) {
    let mut g = ptr::null_mut(); if GdipCreateFromHDC(dc, &mut g) != 0 { return; }
    GdipSetSmoothingMode(g, 4); GdipSetTextRenderingHint(g, 4);
    GdipScaleWorldTransform(g, width as f32 / WIDTH as f32, height as f32 / HEIGHT as f32, 0);
    GdipGraphicsClear(g, 0xff101117);
    let mut family = ptr::null_mut();
    if GdipCreateFontFamilyFromName(wide("Segoe UI").as_ptr(), ptr::null_mut(), &mut family) != 0 { GdipGetGenericFontFamilySansSerif(&mut family); }
    label(g, family, "Майко", 27.0, 19.0, 180.0, 23.0, true, 0xffeef5ff, false);
    label(g, family, "Мост DAW", 28.0, 52.0, 180.0, 10.5, true, 0xff7a879f, false);
    let connected = state.transport.connected();
    let levels = state.levels.get();
    let peak = levels[0].max(levels[1]);
    let energy = if connected { (peak.sqrt() * 1.8).min(1.0) } else { 0.0 };
    let phase = state.phase.get();
    let radius = 76.0 + energy * 24.0;
    let mut points = [PointF { x: 0.0, y: 0.0 }; 16];
    for (i, point) in points.iter_mut().enumerate() {
        let angle = i as f32 / 16.0 * std::f32::consts::TAU;
        let wobble = if connected { 1.0 + (angle * 3.0 + phase).sin() * 0.035 * energy + (angle * 5.0 - phase * 0.7).cos() * 0.025 * energy } else { 1.0 };
        *point = PointF { x: 220.0 + angle.cos() * radius * wobble, y: 194.0 + angle.sin() * radius * wobble };
    }
    let mut path = ptr::null_mut(); GdipCreatePath(0, &mut path);
    GdipAddPathClosedCurve2(path, points.as_ptr(), points.len() as i32, 0.5);
    if connected {
        for (stroke, alpha) in [(25.0, 11u32), (14.0, 20), (5.0, 35)] {
            let mut pen = ptr::null_mut(); GdipCreatePen1((alpha << 24) | 0x50b8ff, stroke, 2, &mut pen);
            GdipDrawPath(g, pen, path); GdipDeletePen(pen);
        }
    }
    let area = RectF { x: 220.0 - radius * 1.1, y: 194.0 - radius * 1.1, width: radius * 2.2, height: radius * 2.2 };
    let mut gradient = ptr::null_mut();
    GdipCreateLineBrushFromRect(&area, if connected { 0xff8af5ff } else { 0xff465166 },
        if connected { 0xff3c70ee } else { 0xff263046 }, 1, 0, &mut gradient);
    GdipFillPath(g, gradient, path); GdipDeleteBrush(gradient); GdipDeletePath(path);
    if connected {
        let shine = solid(0x258fffff); GdipFillEllipse(g, shine, 220.0 - radius * 0.56, 194.0 - radius * 0.65, radius * 0.85, radius * 0.27); GdipDeleteBrush(shine);
    }
    let active = connected && peak > 0.0003;
    let status = if active { "Звук передаётся" } else if connected { "Подключено · тишина" } else { "Ожидание демонстрации" };
    label(g, family, status, 18.0, 311.0, 404.0, 18.0, true, if connected { 0xffdcefff } else { 0xffadb6c8 }, true);
    label(g, family, if connected { "Майко подключён автоматически" } else { "Включите звук при демонстрации окна DAW или экрана" },
        24.0, 341.0, 392.0, 11.0, false, 0xff8090aa, true);
    for ch in 0..2 {
        let y = 386.0 + ch as f32 * 21.0;
        label(g, family, if ch == 0 { "L" } else { "R" }, 30.0, y - 4.0, 25.0, 10.0, true, 0xff8c9ab2, false);
        let background = solid(0xff242b3a); GdipFillRectangle(g, background, 52.0, y, 283.0, 6.0); GdipDeleteBrush(background);
        let db = if levels[ch] > 0.00001 { 20.0 * levels[ch].log10() } else { -100.0 };
        let amount = ((db + 60.0) / 60.0).clamp(0.0, 1.0);
        let fill = solid(if levels[ch] > 0.99 { 0xffffb16c } else { 0xff73ceff });
        GdipFillRectangle(g, fill, 52.0, y, 283.0 * amount, 6.0); GdipDeleteBrush(fill);
        let value = if db <= -80.0 { "−∞".to_string() } else { format!("{:.1}", db) };
        label(g, family, &value, 348.0, y - 6.0, 68.0, 10.5, false, 0xffadbcd2, false);
    }
    GdipDeleteFontFamily(family); GdipDeleteGraphics(g);
}

#[allow(non_snake_case)]
mod win {
    use std::ffi::c_void;
    #[repr(C)] pub struct Rect { pub left: i32, pub top: i32, pub right: i32, pub bottom: i32 }
    #[repr(C)] #[derive(Clone, Copy)] pub struct PointF { pub x: f32, pub y: f32 }
    #[repr(C)] pub struct RectF { pub x: f32, pub y: f32, pub width: f32, pub height: f32 }
    #[repr(C)] pub struct StartupInput { pub version: u32, pub debug: *mut c_void, pub suppress_thread: i32, pub suppress_codecs: i32 }
    #[repr(C)] pub struct WindowClass { pub style: u32, pub procedure: Option<unsafe extern "system" fn(*mut c_void, u32, usize, isize) -> isize>,
        pub class_extra: i32, pub window_extra: i32, pub instance: *mut c_void, pub icon: *mut c_void, pub cursor: *mut c_void,
        pub background: *mut c_void, pub menu: *const u16, pub name: *const u16 }
    #[repr(C)] pub struct Paint { pub dc: *mut c_void, pub erase: i32, pub rect: Rect, pub restore: i32, pub update: i32, pub reserved: [u8; 32] }
    #[link(name = "user32")] extern "system" {
        pub fn RegisterClassW(class: *const WindowClass) -> u16;
        pub fn UnregisterClassW(name: *const u16, instance: *mut c_void) -> i32;
        pub fn CreateWindowExW(ex: u32, class: *const u16, title: *const u16, style: u32, x: i32, y: i32, width: i32, height: i32,
            parent: *mut c_void, menu: *mut c_void, instance: *mut c_void, parameter: *mut c_void) -> *mut c_void;
        pub fn DestroyWindow(window: *mut c_void) -> i32;
        pub fn MoveWindow(window: *mut c_void, x: i32, y: i32, width: i32, height: i32, repaint: i32) -> i32;
        pub fn SetTimer(window: *mut c_void, id: usize, ms: u32, callback: *mut c_void) -> usize;
        pub fn KillTimer(window: *mut c_void, id: usize) -> i32;
        pub fn SetWindowLongPtrW(window: *mut c_void, index: i32, value: isize) -> isize;
        pub fn GetWindowLongPtrW(window: *mut c_void, index: i32) -> isize;
        pub fn DefWindowProcW(window: *mut c_void, message: u32, w: usize, l: isize) -> isize;
        pub fn InvalidateRect(window: *mut c_void, rect: *const Rect, erase: i32) -> i32;
        pub fn GetClientRect(window: *mut c_void, rect: *mut Rect) -> i32;
        pub fn BeginPaint(window: *mut c_void, paint: *mut Paint) -> *mut c_void;
        pub fn EndPaint(window: *mut c_void, paint: *const Paint) -> i32;
        pub fn LoadCursorW(instance: *mut c_void, name: *const u16) -> *mut c_void;
    }
    #[link(name = "kernel32")] extern "system" { pub fn GetModuleHandleExW(flags: u32, address: *const u16, module: *mut *mut c_void) -> i32; }
    #[link(name = "gdi32")] extern "system" {
        pub fn CreateCompatibleDC(dc: *mut c_void) -> *mut c_void;
        pub fn CreateCompatibleBitmap(dc: *mut c_void, width: i32, height: i32) -> *mut c_void;
        pub fn SelectObject(dc: *mut c_void, object: *mut c_void) -> *mut c_void;
        pub fn DeleteObject(object: *mut c_void) -> i32;
        pub fn DeleteDC(dc: *mut c_void) -> i32;
        pub fn BitBlt(dc: *mut c_void, x: i32, y: i32, width: i32, height: i32, source: *mut c_void, sx: i32, sy: i32, operation: u32) -> i32;
    }
    #[link(name = "gdiplus")] extern "system" {
        pub fn GdiplusStartup(token: *mut usize, input: *const StartupInput, output: *mut c_void) -> i32;
        pub fn GdiplusShutdown(token: usize);
        pub fn GdipCreateFromHDC(dc: *mut c_void, graphics: *mut *mut c_void) -> i32;
        pub fn GdipDeleteGraphics(g: *mut c_void) -> i32;
        pub fn GdipSetSmoothingMode(g: *mut c_void, mode: i32) -> i32;
        pub fn GdipSetTextRenderingHint(g: *mut c_void, mode: i32) -> i32;
        pub fn GdipScaleWorldTransform(g: *mut c_void, x: f32, y: f32, order: i32) -> i32;
        pub fn GdipGraphicsClear(g: *mut c_void, color: u32) -> i32;
        pub fn GdipCreateSolidFill(color: u32, brush: *mut *mut c_void) -> i32;
        pub fn GdipDeleteBrush(brush: *mut c_void) -> i32;
        pub fn GdipFillEllipse(g: *mut c_void, brush: *mut c_void, x: f32, y: f32, width: f32, height: f32) -> i32;
        pub fn GdipFillRectangle(g: *mut c_void, brush: *mut c_void, x: f32, y: f32, width: f32, height: f32) -> i32;
        pub fn GdipCreatePath(mode: i32, path: *mut *mut c_void) -> i32;
        pub fn GdipDeletePath(path: *mut c_void) -> i32;
        pub fn GdipAddPathClosedCurve2(path: *mut c_void, points: *const PointF, count: i32, tension: f32) -> i32;
        pub fn GdipCreatePen1(color: u32, width: f32, unit: i32, pen: *mut *mut c_void) -> i32;
        pub fn GdipDrawPath(g: *mut c_void, pen: *mut c_void, path: *mut c_void) -> i32;
        pub fn GdipDeletePen(pen: *mut c_void) -> i32;
        pub fn GdipFillPath(g: *mut c_void, brush: *mut c_void, path: *mut c_void) -> i32;
        pub fn GdipCreateLineBrushFromRect(rect: *const RectF, color1: u32, color2: u32, mode: i32, wrap: i32, brush: *mut *mut c_void) -> i32;
        pub fn GdipCreateFontFamilyFromName(name: *const u16, collection: *mut c_void, family: *mut *mut c_void) -> i32;
        pub fn GdipGetGenericFontFamilySansSerif(family: *mut *mut c_void) -> i32;
        pub fn GdipDeleteFontFamily(family: *mut c_void) -> i32;
        pub fn GdipCreateFont(family: *mut c_void, size: f32, style: i32, unit: i32, font: *mut *mut c_void) -> i32;
        pub fn GdipDeleteFont(font: *mut c_void) -> i32;
        pub fn GdipCreateStringFormat(flags: i32, language: u16, format: *mut *mut c_void) -> i32;
        pub fn GdipSetStringFormatAlign(format: *mut c_void, align: i32) -> i32;
        pub fn GdipDeleteStringFormat(format: *mut c_void) -> i32;
        pub fn GdipDrawString(g: *mut c_void, string: *const u16, count: i32, font: *mut c_void, rect: *const RectF, format: *mut c_void, brush: *mut c_void) -> i32;
    }
}
