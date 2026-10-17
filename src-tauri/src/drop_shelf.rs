#![allow(unsafe_op_in_unsafe_fn)]

use std::ffi::c_void;
use std::os::windows::ffi::OsStringExt;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM, RPC_E_CHANGED_MODE};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, ScreenToClient, SetWindowRgn, HBRUSH, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, OleInitialize, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP,
    DROPEFFECT,
    DROPEFFECT_COPY, DROPEFFECT_MOVE, DROPEFFECT_NONE,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx,     CreateWindowExW, DefWindowProcW, EnumChildWindows, GetCursorPos, GetWindowRect, IsWindowVisible,
    KillTimer, LoadCursorW, SetWindowsHookExW, MSLLHOOKSTRUCT, WH_MOUSE_LL,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
    PostMessageW,
    RegisterClassW, SetTimer, SetWindowPos, ShowWindow, EVENT_SYSTEM_DRAGDROPEND,
    EVENT_SYSTEM_DRAGDROPSTART,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
    HICON, HWND_TOPMOST, IDC_ARROW, MA_NOACTIVATE, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, WM_DESTROY,
    WM_ERASEBKGND, WM_MOUSEACTIVATE, WM_PAINT, WM_TIMER, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP,
};
use windows::core::{implement, BOOL, HSTRING, PCWSTR};

use crate::{import_dropped, AppState};

const SHELF_CLASS: PCWSTR = windows::core::w!("FolioDropShelf");
const DRAG_START: u32 = 0x8000 + 1;
const DRAG_END: u32 = 0x8000 + 2;
const SHOW_SHELF: u32 = 0x8000 + 3;
const HIDE_SHELF: u32 = 0x8000 + 4;
const ATTACH_TIMER: usize = 2;
const END_TIMER: usize = 3;

static APP: OnceLock<AppHandle> = OnceLock::new();
static HWND_SLOT: AtomicIsize = AtomicIsize::new(0);
static RAIL_HWND: AtomicIsize = AtomicIsize::new(0);
static PANEL_HWND: AtomicIsize = AtomicIsize::new(0);
static PANEL_OPEN: AtomicBool = AtomicBool::new(false);
static PANEL_SIZE: Mutex<(f64, f64)> = Mutex::new((308.0, 220.0));
static BUTTON_POS: Mutex<(i32, i32)> = Mutex::new((0, 0));
static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
static INTERNAL_DRAG: AtomicBool = AtomicBool::new(false);
static HOT: AtomicBool = AtomicBool::new(false);
static MAIN_FILES: AtomicBool = AtomicBool::new(false);
static REVEALED: AtomicBool = AtomicBool::new(false);
static KEEP_OPEN: AtomicBool = AtomicBool::new(false);
static HOOK: AtomicIsize = AtomicIsize::new(0);
static OUTSIDE_DRAG: AtomicBool = AtomicBool::new(false);
static MOUSE_DRAG: AtomicBool = AtomicBool::new(false);
static FILE_SHOWN: AtomicBool = AtomicBool::new(false);
static DOWN_X: AtomicIsize = AtomicIsize::new(0);
static DOWN_Y: AtomicIsize = AtomicIsize::new(0);

pub fn install(app: &AppHandle) -> Result<(), String> {
    let _ = APP.set(app.clone());
    unsafe {
        if let Err(err) = OleInitialize(None) {
            if err.code() != RPC_E_CHANGED_MODE {
                return Err(format!("无法准备拖放：{err}"));
            }
        }
        let instance = GetModuleHandleW(None).map_err(|err| err.to_string())?;
        let cursor = LoadCursorW(None, IDC_ARROW).unwrap_or_default();
        let class = WNDCLASSW {
            style: Default::default(),
            lpfnWndProc: Some(shelf_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: windows::Win32::Foundation::HINSTANCE(instance.0),
            hIcon: HICON(std::ptr::null_mut()),
            hCursor: cursor,
            hbrBackground: HBRUSH(std::ptr::null_mut()),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: SHELF_CLASS,
        };
        RegisterClassW(&class);
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            SHELF_CLASS,
            &HSTRING::from("放入工作区"),
            WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(windows::Win32::Foundation::HINSTANCE(instance.0)),
            None,
        )
        .map_err(|err| format!("无法创建放入条：{err}"))?;
        HWND_SLOT.store(hwnd.0 as isize, Ordering::SeqCst);
        let target: IDropTarget = ShelfTarget.into();
        RegisterDragDrop(hwnd, &target).map_err(|err| format!("无法接收拖放：{err}"))?;
        std::mem::forget(target);
        let hook = SetWinEventHook(
            EVENT_SYSTEM_DRAGDROPSTART,
            EVENT_SYSTEM_DRAGDROPEND,
            None,
            Some(on_drag_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        if hook.is_invalid() {
            return Err("无法监听系统拖放。".into());
        }
        HOOK.store(hook.0 as isize, Ordering::SeqCst);
        if let Err(err) = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0) {
            eprintln!("无法监听鼠标拖拽：{err}");
        }
        let _ = SetTimer(Some(hwnd), ATTACH_TIMER, 600, None);
    }
    open_rail(app)?;
    Ok(())
}

fn open_rail(app: &AppHandle) -> Result<(), String> {
    let button = open_overlay(app, "rail", 56.0, 56.0)?;
    RAIL_HWND.store(button.0 as isize, Ordering::SeqCst);
    let panel = open_overlay(app, "rail-panel", 308.0, 220.0)?;
    PANEL_HWND.store(panel.0 as isize, Ordering::SeqCst);
    Ok(())
}

fn open_overlay(app: &AppHandle, label: &str, width: f64, height: f64) -> Result<HWND, String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title("拖入")
        .decorations(false)
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .focused(false)
        .visible(false)
        .inner_size(width, height)
        .initialization_script(
            "document.documentElement.dataset.rail='1';for (const node of [document.documentElement, document.body]) { if (node) node.style.background='transparent'; }",
        )
        .disable_drag_drop_handler()
        .build()
        .map_err(|err| err.to_string())?;
    let raw = window.hwnd().map_err(|err| err.to_string())?;
    let hwnd = HWND(raw.0 as *mut c_void);
    round_window(hwnd);
    bind_shelf_tree(hwnd);
    Ok(hwnd)
}

pub fn present() {
    post(SHOW_SHELF);
}

pub fn external_drag() -> bool {
    DRAG_ACTIVE.load(Ordering::SeqCst)
}

pub fn set_internal_drag(active: bool) {
    INTERNAL_DRAG.store(active, Ordering::SeqCst);
}

pub fn hide() {
    post(HIDE_SHELF);
}

pub fn attach_main(raw: isize) {
    if raw == 0 {
        return;
    }
    let hwnd = HWND(raw as *mut c_void);
    bind_drop(hwnd);
    unsafe {
        let _ = EnumChildWindows(Some(hwnd), Some(bind_child), LPARAM(0));
    }
}

pub fn main_hidden() {}

pub fn note_drop() {
    KEEP_OPEN.store(true, Ordering::SeqCst);
}

pub fn clipboard_paths() -> Vec<String> {
    unsafe {
        if OpenClipboard(None).is_err() {
            return Vec::new();
        }
        let paths = GetClipboardData(CF_HDROP.0 as u32)
            .ok()
            .map(|handle| read_hdrop(HDROP(handle.0)))
            .unwrap_or_default();
        let _ = CloseClipboard();
        paths
    }
}

fn shelf_hwnd() -> HWND {
    HWND(HWND_SLOT.load(Ordering::SeqCst) as *mut c_void)
}

fn rail_hwnd() -> HWND {
    HWND(RAIL_HWND.load(Ordering::SeqCst) as *mut c_void)
}

fn panel_hwnd() -> HWND {
    HWND(PANEL_HWND.load(Ordering::SeqCst) as *mut c_void)
}

fn post(message: u32) {
    let hwnd = shelf_hwnd();
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        let _ = PostMessageW(Some(hwnd), message, WPARAM(0), LPARAM(0));
    }
}

fn main_visible() -> bool {
    APP.get()
        .and_then(|app| app.get_webview_window("main"))
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

fn px(scale: i32, value: i32) -> i32 {
    value * scale.max(96) / 96
}

fn monitor_under_cursor() -> Option<(RECT, i32)> {
    unsafe {
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..MONITORINFO::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let mut dpi_x = 96u32;
        let mut dpi_y = 96u32;
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        Some((info.rcWork, dpi_x.max(96) as i32))
    }
}

pub fn place_rail(width_dip: f64, height_dip: f64) {
    if !DRAG_ACTIVE.load(Ordering::SeqCst) || !FILE_SHOWN.load(Ordering::SeqCst) || !PANEL_OPEN.load(Ordering::SeqCst) {
        return;
    }
    if let Ok(mut size) = PANEL_SIZE.lock() {
        *size = (width_dip.max(120.0), height_dip.max(80.0));
    }
    place_panel_now();
}

fn place_rail_now() {
    if !FILE_SHOWN.load(Ordering::SeqCst) {
        return;
    }
    place_button_now();
    if PANEL_OPEN.load(Ordering::SeqCst) {
        place_panel_now();
    }
}

fn place_button_now() {
    let Some((work, scale)) = monitor_under_cursor() else {
        return;
    };
    let size = px(scale, 56).max(1);
    let mut cursor = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut cursor);
    }
    let x = work.right - size;
    let mut y = cursor.y - size / 2;
    if y < work.top + px(scale, 8) {
        y = work.top + px(scale, 8);
    }
    if y + size > work.bottom - px(scale, 8) {
        y = (work.bottom - px(scale, 8) - size).max(work.top);
    }
    if let Ok(mut pos) = BUTTON_POS.lock() {
        *pos = (x, y);
    }
    show_glass(rail_hwnd(), x, y, size, size, px(scale, 16));
}

fn place_panel_now() {
    let Some((work, scale)) = monitor_under_cursor() else {
        return;
    };
    let (width_dip, height_dip) = PANEL_SIZE.lock().map(|size| *size).unwrap_or((308.0, 220.0));
    let width = (width_dip * scale as f64 / 96.0).round().max(1.0) as i32;
    let height = (height_dip * scale as f64 / 96.0).round().max(1.0) as i32;
    let button = px(scale, 56).max(1);
    let (button_x, button_y) = BUTTON_POS.lock().map(|pos| *pos).unwrap_or((work.right - button, work.top));
    let gap = px(scale, 12);
    let mut x = button_x - gap - width;
    let mut y = button_y + button / 2 - height / 2;
    if x < work.left + px(scale, 8) {
        x = work.left + px(scale, 8);
    }
    if y < work.top + px(scale, 8) {
        y = work.top + px(scale, 8);
    }
    if y + height > work.bottom - px(scale, 8) {
        y = (work.bottom - px(scale, 8) - height).max(work.top);
    }
    show_glass(panel_hwnd(), x, y, width, height, px(scale, 28));
}

fn show_glass(hwnd: HWND, x: i32, y: i32, width: i32, height: i32, _radius: i32) {
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        let _ = SetWindowRgn(hwnd, None, false);
    }
    set_acrylic(hwnd, true);
    round_window(hwnd);
}

fn round_window(hwnd: HWND) {
    if hwnd.0.is_null() {
        return;
    }
    let preference = DWMWCP_ROUND.0;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        );
    }
}

fn set_acrylic(hwnd: HWND, enabled: bool) {
    #[repr(C)]
    struct AccentPolicy {
        state: u32,
        flags: u32,
        color: u32,
        animation: u32,
    }
    #[repr(C)]
    struct CompositionData {
        attrib: u32,
        data: *mut c_void,
        size: usize,
    }
    type SetComposition = unsafe extern "system" fn(HWND, *mut CompositionData) -> BOOL;

    unsafe {
        let Ok(module) = GetModuleHandleW(windows::core::w!("user32.dll")) else {
            return;
        };
        let Some(proc) = GetProcAddress(module, windows::core::s!("SetWindowCompositionAttribute")) else {
            return;
        };
        let set_composition: SetComposition = std::mem::transmute(proc);
        let mut policy = AccentPolicy {
            state: if enabled { 4 } else { 0 },
            flags: 0,
            color: if enabled { 0x22FF_FFFF } else { 0 },
            animation: 0,
        };
        let mut data = CompositionData {
            attrib: 0x13,
            data: &mut policy as *mut AccentPolicy as *mut c_void,
            size: std::mem::size_of::<AccentPolicy>(),
        };
        let _ = set_composition(hwnd, &mut data);
    }
}

fn place_strip() {
    let Some((work, scale)) = monitor_under_cursor() else {
        return;
    };
    let width = px(scale, 28).max(12);
    let height = (work.bottom - work.top).max(1);
    let hwnd = rail_hwnd();
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            work.right - width,
            work.top,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        let _ = SetWindowRgn(hwnd, None, false);
    }
    set_acrylic(hwnd, false);
    close_drop_panel();
}

fn current_names() -> Vec<String> {
    APP.get()
        .and_then(|app| app.try_state::<AppState>())
        .and_then(|state| state.names.lock().ok().map(|names| names.clone()))
        .unwrap_or_default()
}

pub fn publish_names() {
    emit_rail("rail-names", current_names());
}

fn show_file_icon() {
    FILE_SHOWN.store(true, Ordering::SeqCst);
    PANEL_OPEN.store(false, Ordering::SeqCst);
    hide_window(panel_hwnd());
    emit_rail("rail-show", current_names());
    place_button_now();
}

fn hide_window(hwnd: HWND) {
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
    set_acrylic(hwnd, false);
}

fn hide_rail() {
    PANEL_OPEN.store(false, Ordering::SeqCst);
    hide_window(rail_hwnd());
    hide_window(panel_hwnd());
}

fn close_drop_panel() {
    if !PANEL_OPEN.swap(false, Ordering::SeqCst) {
        return;
    }
    hide_window(panel_hwnd());
    if let Some(app) = APP.get() {
        let _ = app.emit_to("rail-panel", "rail-leave", ());
    }
}

fn open_drop_panel() {
    if PANEL_OPEN.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(app) = APP.get() {
        let _ = app.emit_to("rail-panel", "rail-open", ());
    }
    place_panel_now();
}

fn emit_rail(event: &str, payload: impl serde::Serialize + Clone) {
    if let Some(app) = APP.get() {
        let _ = app.emit_to("rail", event, payload.clone());
        let _ = app.emit_to("rail-panel", event, payload);
    }
}

fn window_hit(hwnd: HWND, x: i32, y: i32, pad: i32) -> bool {
    if hwnd.0.is_null() {
        return false;
    }
    unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        x >= rect.left - pad && x < rect.right + pad && y >= rect.top - pad && y < rect.bottom + pad
    }
}

fn emit_probe(x: i32, y: i32) {
    if !FILE_SHOWN.load(Ordering::SeqCst) {
        return;
    }
    let on_button = window_hit(rail_hwnd(), x, y, 28);
    let on_panel = PANEL_OPEN.load(Ordering::SeqCst) && window_hit(panel_hwnd(), x, y, 28);
    if on_button {
        open_drop_panel();
    }
    let hwnd = panel_hwnd();
    if !hwnd.0.is_null() && window_hit(hwnd, x, y, 0) {
        let mut point = POINT { x, y };
        unsafe {
            let _ = ScreenToClient(hwnd, &mut point);
        }
        if let Some(app) = APP.get() {
            let _ = app.emit_to("rail-panel", "rail-probe", serde_json::json!({ "x": point.x, "y": point.y }));
        }
    } else if !on_button && !on_panel {
        close_drop_panel();
    }
}

pub fn activate_workspace(name: &str) {
    let Some(app) = APP.get() else {
        return;
    };
    let state = app.state::<AppState>();
    let mut changed = true;
    if let Ok(mut surface) = state.surface.lock() {
        changed = surface.0 != name || !surface.1.is_empty();
        *surface = (name.to_string(), Vec::new());
    }
    if !changed && main_visible() {
        return;
    }
    if !main_visible() {
        REVEALED.store(true, Ordering::SeqCst);
    }
    if changed {
        let _ = app.emit("activate-workspace", name);
    }
    crate::reveal_window(app);
}

fn hdrop_format() -> FORMATETC {
    FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

fn has_hdrop(data: &IDataObject) -> bool {
    unsafe { data.QueryGetData(&hdrop_format()).is_ok() }
}

fn hdrop_paths(data: &IDataObject) -> Vec<String> {
    unsafe {
        let format = hdrop_format();
        let mut medium = match data.GetData(&format) {
            Ok(medium) => medium,
            Err(_) => return Vec::new(),
        };
        let paths = read_hdrop(HDROP(medium.u.hGlobal.0));
        ReleaseStgMedium(&mut medium);
        paths
    }
}

fn read_hdrop(hdrop: HDROP) -> Vec<String> {
    if hdrop.0.is_null() {
        return Vec::new();
    }
    unsafe {
        let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let len = DragQueryFileW(hdrop, index, None) as usize;
            let mut buffer = vec![0u16; len + 1];
            if DragQueryFileW(hdrop, index, Some(&mut buffer)) == 0 {
                continue;
            }
            let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
            let text = std::ffi::OsString::from_wide(&buffer[..end]).to_string_lossy().to_string();
            if !text.is_empty() {
                paths.push(text);
            }
        }
        paths
    }
}

fn preferred_effect(app: &AppHandle) -> DROPEFFECT {
    let state = app.state::<AppState>();
    let mode = state
        .config
        .lock()
        .map(|config| config.drop_mode.clone())
        .unwrap_or_else(|_| "copy".into());
    if mode == "move" {
        DROPEFFECT_MOVE
    } else {
        DROPEFFECT_COPY
    }
}

fn set_hot(hot: bool) {
    HOT.store(hot, Ordering::SeqCst);
}

#[implement(IDropTarget)]
struct ShelfTarget;

impl IDropTarget_Impl for ShelfTarget_Impl {
    fn DragEnter(
        &self,
        pdataobj: windows_core::Ref<'_, IDataObject>,
        _grfkeystate: windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS,
        _pt: &windows::Win32::Foundation::POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows_core::Result<()> {
        let files = pdataobj.as_ref().is_some_and(has_hdrop);
        set_hot(files);
        if files {
            show_file_icon();
            emit_probe(_pt.x, _pt.y);
        }
        unsafe {
            if !pdweffect.is_null() {
                *pdweffect = if files {
                    APP.get().map(preferred_effect).unwrap_or(DROPEFFECT_COPY)
                } else {
                    DROPEFFECT_NONE
                };
            }
        }
        Ok(())
    }

    fn DragOver(
        &self,
        _grfkeystate: windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS,
        pt: &windows::Win32::Foundation::POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows_core::Result<()> {
        if HOT.load(Ordering::SeqCst) {
            emit_probe(pt.x, pt.y);
        }
        unsafe {
            if !pdweffect.is_null() {
                *pdweffect = if HOT.load(Ordering::SeqCst) {
                    APP.get().map(preferred_effect).unwrap_or(DROPEFFECT_COPY)
                } else {
                    DROPEFFECT_NONE
                };
            }
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows_core::Result<()> {
        let mut cursor = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut cursor);
        }
        if window_hit(rail_hwnd(), cursor.x, cursor.y, 28)
            || (PANEL_OPEN.load(Ordering::SeqCst) && window_hit(panel_hwnd(), cursor.x, cursor.y, 28))
        {
            return Ok(());
        }
        set_hot(false);
        close_drop_panel();
        Ok(())
    }

    fn Drop(
        &self,
        pdataobj: windows_core::Ref<'_, IDataObject>,
        _grfkeystate: windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS,
        _pt: &windows::Win32::Foundation::POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows_core::Result<()> {
        set_hot(false);
        let paths = pdataobj.as_ref().map(hdrop_paths).unwrap_or_default();
        let mut effect = DROPEFFECT_NONE;
        if let Some(app) = APP.get() {
            if !paths.is_empty() {
                note_drop();
                match import_dropped(app, &paths) {
                    Ok(()) => effect = preferred_effect(app),
                    Err(err) => {
                        let _ = app.emit("app-error", err);
                    }
                }
            }
        }
        unsafe {
            if !pdweffect.is_null() {
                *pdweffect = effect;
            }
        }
        Ok(())
    }
}

fn emit_drag(active: bool) {
    if let Some(app) = APP.get() {
        let _ = app.emit("external-drag", active);
    }
}

fn register_shelf(hwnd: HWND) {
    if hwnd.0.is_null() {
        return;
    }
    unsafe {
        let _ = RevokeDragDrop(hwnd);
        let target: IDropTarget = ShelfTarget.into();
        if RegisterDragDrop(hwnd, &target).is_ok() {
            std::mem::forget(target);
        }
    }
}

fn bind_shelf_tree(hwnd: HWND) {
    if hwnd.0.is_null() {
        return;
    }
    register_shelf(hwnd);
    unsafe {
        let _ = EnumChildWindows(Some(hwnd), Some(bind_shelf_child), LPARAM(0));
    }
}

unsafe extern "system" fn bind_shelf_child(hwnd: HWND, _lparam: LPARAM) -> BOOL {
    register_shelf(hwnd);
    BOOL(1)
}

fn bind_drop(hwnd: HWND) {
    if hwnd.0.is_null() || hwnd.0 == shelf_hwnd().0 || hwnd.0 == rail_hwnd().0 || hwnd.0 == panel_hwnd().0 {
        return;
    }
    unsafe {
        let _ = RevokeDragDrop(hwnd);
        let target: IDropTarget = MainTarget.into();
        if RegisterDragDrop(hwnd, &target).is_ok() {
            std::mem::forget(target);
        }
    }
}

unsafe extern "system" fn bind_child(hwnd: HWND, _lparam: LPARAM) -> BOOL {
    bind_drop(hwnd);
    BOOL(1)
}

#[implement(IDropTarget)]
struct MainTarget;

impl IDropTarget_Impl for MainTarget_Impl {
    fn DragEnter(
        &self,
        pdataobj: windows_core::Ref<'_, IDataObject>,
        _grfkeystate: windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS,
        _pt: &windows::Win32::Foundation::POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows_core::Result<()> {
        let files = pdataobj.as_ref().is_some_and(has_hdrop);
        MAIN_FILES.store(files, Ordering::SeqCst);
        if files {
            emit_drag(true);
        }
        unsafe {
            if !pdweffect.is_null() {
                *pdweffect = if files {
                    APP.get().map(preferred_effect).unwrap_or(DROPEFFECT_COPY)
                } else {
                    DROPEFFECT_NONE
                };
            }
        }
        Ok(())
    }

    fn DragOver(
        &self,
        _grfkeystate: windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS,
        _pt: &windows::Win32::Foundation::POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows_core::Result<()> {
        unsafe {
            if !pdweffect.is_null() {
                *pdweffect = if MAIN_FILES.load(Ordering::SeqCst) {
                    APP.get().map(preferred_effect).unwrap_or(DROPEFFECT_COPY)
                } else {
                    DROPEFFECT_NONE
                };
            }
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows_core::Result<()> {
        MAIN_FILES.store(false, Ordering::SeqCst);
        emit_drag(false);
        Ok(())
    }

    fn Drop(
        &self,
        pdataobj: windows_core::Ref<'_, IDataObject>,
        _grfkeystate: windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS,
        _pt: &windows::Win32::Foundation::POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows_core::Result<()> {
        emit_drag(false);
        let paths = pdataobj.as_ref().map(hdrop_paths).unwrap_or_default();
        let mut effect = DROPEFFECT_NONE;
        if let Some(app) = APP.get() {
            if !paths.is_empty() {
                note_drop();
                match import_dropped(app, &paths) {
                    Ok(()) => effect = preferred_effect(app),
                    Err(err) => {
                        let _ = app.emit("app-error", err);
                    }
                }
            }
        }
        unsafe {
            if !pdweffect.is_null() {
                *pdweffect = effect;
            }
        }
        Ok(())
    }
}

fn visible_window_contains(raw: isize, x: i32, y: i32) -> bool {
    if raw == 0 {
        return false;
    }
    let hwnd = HWND(raw as *mut c_void);
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return false;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
    }
}

fn point_in_visible_app(x: i32, y: i32) -> bool {
    let main = APP
        .get()
        .and_then(|app| app.get_webview_window("main"))
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize)
        .unwrap_or(0);
    visible_window_contains(main, x, y)
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && lparam.0 != 0 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let message = wparam.0 as u32;
        if message == WM_LBUTTONDOWN {
            DOWN_X.store(info.pt.x as isize, Ordering::SeqCst);
            DOWN_Y.store(info.pt.y as isize, Ordering::SeqCst);
            OUTSIDE_DRAG.store(!point_in_visible_app(info.pt.x, info.pt.y), Ordering::SeqCst);
            MOUSE_DRAG.store(false, Ordering::SeqCst);
        } else if message == WM_MOUSEMOVE
            && OUTSIDE_DRAG.load(Ordering::SeqCst)
            && !INTERNAL_DRAG.load(Ordering::SeqCst)
            && !MOUSE_DRAG.load(Ordering::SeqCst)
        {
            let dx = info.pt.x as isize - DOWN_X.load(Ordering::SeqCst);
            let dy = info.pt.y as isize - DOWN_Y.load(Ordering::SeqCst);
            if dx * dx + dy * dy > 12 * 12 {
                MOUSE_DRAG.store(true, Ordering::SeqCst);
                let _ = KillTimer(Some(shelf_hwnd()), END_TIMER);
                post(DRAG_START);
            }
        } else if message == WM_LBUTTONUP {
            OUTSIDE_DRAG.store(false, Ordering::SeqCst);
            if MOUSE_DRAG.swap(false, Ordering::SeqCst) {
                let _ = SetTimer(Some(shelf_hwnd()), END_TIMER, 200, None);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn on_drag_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    _hwnd: HWND,
    _idobject: i32,
    _idchild: i32,
    _idthread: u32,
    _time: u32,
) {
    if event == EVENT_SYSTEM_DRAGDROPSTART {
        post(DRAG_START);
    } else if event == EVENT_SYSTEM_DRAGDROPEND {
        post(DRAG_END);
    }
}

unsafe extern "system" fn shelf_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        SHOW_SHELF => {
            if DRAG_ACTIVE.load(Ordering::SeqCst) {
                place_rail_now();
            }
            LRESULT(0)
        }
        HIDE_SHELF => {
            if DRAG_ACTIVE.load(Ordering::SeqCst) {
                place_rail_now();
            } else {
                hide_rail();
            }
            LRESULT(0)
        }
        DRAG_START => {
            if INTERNAL_DRAG.load(Ordering::SeqCst) {
                return LRESULT(0);
            }
            DRAG_ACTIVE.store(true, Ordering::SeqCst);
            FILE_SHOWN.store(false, Ordering::SeqCst);
            REVEALED.store(false, Ordering::SeqCst);
            KEEP_OPEN.store(false, Ordering::SeqCst);
            emit_rail("rail-reset", ());
            let _ = KillTimer(Some(hwnd), END_TIMER);
            bind_shelf_tree(rail_hwnd());
            bind_shelf_tree(panel_hwnd());
            place_strip();
            LRESULT(0)
        }
        DRAG_END => {
            let revealed = REVEALED.swap(false, Ordering::SeqCst);
            let keep = KEEP_OPEN.swap(false, Ordering::SeqCst);
            DRAG_ACTIVE.store(false, Ordering::SeqCst);
            FILE_SHOWN.store(false, Ordering::SeqCst);
            set_hot(false);
            hide_rail();
            emit_rail("rail-reset", ());
            if revealed && !keep {
                if let Some(app) = APP.get() {
                    crate::hide_window(app);
                }
            }
            LRESULT(0)
        }
        WM_TIMER => {
            if wparam.0 == END_TIMER {
                let _ = KillTimer(Some(hwnd), END_TIMER);
                post(DRAG_END);
            } else if wparam.0 == ATTACH_TIMER {
                let _ = KillTimer(Some(hwnd), ATTACH_TIMER);
                bind_shelf_tree(rail_hwnd());
                if let Some(app) = APP.get() {
                    if let Some(window) = app.get_webview_window("main") {
                        if let Ok(raw) = window.hwnd() {
                            attach_main(raw.0 as isize);
                        }
                    }
                }
            }
            LRESULT(0)
        }
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        WM_ERASEBKGND => LRESULT(1),
        WM_PAINT => DefWindowProcW(hwnd, msg, wparam, lparam),
        WM_DESTROY => LRESULT(0),
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

