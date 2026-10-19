mod drop_shelf;
mod icon;
mod model;
mod shell_menu;

use std::sync::Mutex;

use model::Config;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub(crate) struct AppState {
    pub(crate) config: Mutex<Config>,
    pub(crate) surface: Mutex<(String, Vec<String>)>,
    pub(crate) names: Mutex<Vec<String>>,
}

#[tauri::command]
fn get_config(state: State<AppState>) -> Result<Config, String> {
    state
        .config
        .lock()
        .map(|config| config.clone())
        .map_err(|_| "设置正在被占用。".into())
}

#[tauri::command]
fn set_config(app: AppHandle, state: State<AppState>, next: Config) -> Result<Config, String> {
    if !matches!(next.drop_mode.as_str(), "move" | "copy" | "shortcut") {
        return Err("放入方式只能是移动、复制或快捷方式。".into());
    }
    if next.shortcut.parse::<tauri_plugin_global_shortcut::Shortcut>().is_err() {
        return Err("这个快捷键无法使用。".into());
    }
    let mut config = state
        .config
        .lock()
        .map_err(|_| "设置正在被占用。".to_string())?;
    let old_root = std::path::PathBuf::from(&config.root);
    let new_root = std::path::PathBuf::from(&next.root);
    model::change_root(&old_root, &new_root)?;
    let previous_shortcut = config.shortcut.clone();
    let previous_launch = config.launch_at_login;
    *config = next;
    if let Err(err) = save_config(&app, &config) {
        return Err(err);
    }
    if let Err(err) = set_launch_at_login(config.launch_at_login) {
        config.launch_at_login = previous_launch;
        let _ = save_config(&app, &config);
        return Err(err);
    }
    if config.shortcut != previous_shortcut {
        if let Err(err) = register_shortcut(&app, &config.shortcut) {
            config.shortcut = previous_shortcut;
            let _ = save_config(&app, &config);
            let _ = register_shortcut(&app, &config.shortcut);
            return Err(err);
        }
    }
    Ok(config.clone())
}

#[tauri::command]
fn list_workspaces(state: State<AppState>) -> Result<Vec<String>, String> {
    model::list_workspaces(&root_of(&state)?)
}

#[tauri::command]
fn create_workspace(state: State<AppState>, name: String) -> Result<String, String> {
    model::create_workspace(&root_of(&state)?, &name)
}

#[tauri::command]
fn rename_workspace(state: State<AppState>, from: String, to: String) -> Result<String, String> {
    model::rename_workspace(&root_of(&state)?, &from, &to)
}

#[tauri::command]
fn delete_workspace(state: State<AppState>, name: String) -> Result<(), String> {
    model::delete_workspace(&root_of(&state)?, &name)
}

#[tauri::command]
fn list_dir(
    state: State<AppState>,
    workspace: String,
    folders: Vec<String>,
) -> Result<model::DirListing, String> {
    model::list_dir(&root_of(&state)?, &workspace, &folders)
}

#[tauri::command]
fn save_layout(
    state: State<AppState>,
    workspace: String,
    folders: Vec<String>,
    items: std::collections::BTreeMap<String, model::Placement>,
) -> Result<(), String> {
    model::save_layout(&root_of(&state)?, &workspace, &folders, items)
}

#[tauri::command]
fn import_paths(
    state: State<AppState>,
    workspace: String,
    folders: Vec<String>,
    paths: Vec<String>,
    mode: String,
) -> Result<(), String> {
    model::import_paths(&root_of(&state)?, &workspace, &folders, &paths, &mode)
}

#[tauri::command]
fn create_note(
    state: State<AppState>,
    workspace: String,
    folders: Vec<String>,
) -> Result<String, String> {
    model::create_note(&root_of(&state)?, &workspace, &folders)
}

#[tauri::command]
fn read_note(
    state: State<AppState>,
    workspace: String,
    folders: Vec<String>,
    name: String,
) -> Result<String, String> {
    model::read_note(&root_of(&state)?, &workspace, &folders, &name)
}

#[tauri::command]
fn write_note(
    state: State<AppState>,
    workspace: String,
    folders: Vec<String>,
    name: String,
    content: String,
) -> Result<(), String> {
    model::write_note(&root_of(&state)?, &workspace, &folders, &name, &content)
}

#[tauri::command]
fn group_items(
    state: State<AppState>,
    workspace: String,
    folders: Vec<String>,
    names: Vec<String>,
) -> Result<String, String> {
    model::group_items(&root_of(&state)?, &workspace, &folders, &names)
}

#[tauri::command]
fn move_into(
    state: State<AppState>,
    workspace: String,
    folders: Vec<String>,
    name: String,
    folder: String,
) -> Result<(), String> {
    model::move_into(&root_of(&state)?, &workspace, &folders, &name, &folder)
}

#[tauri::command]
fn move_entry(
    state: State<AppState>,
    from_workspace: String,
    from_folders: Vec<String>,
    name: String,
    to_workspace: String,
    to_folders: Vec<String>,
) -> Result<(), String> {
    let root = root_of(&state)?;
    model::move_entry(
        &root,
        &from_workspace,
        &from_folders,
        &name,
        &to_workspace,
        &to_folders,
    )
}

#[tauri::command]
fn delete_entry(
    state: State<AppState>,
    workspace: String,
    folders: Vec<String>,
    name: String,
) -> Result<(), String> {
    model::delete_entry(&root_of(&state)?, &workspace, &folders, &name)
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    open_with_shell(&path)?;
    hide_window(&app);
    Ok(())
}

#[tauri::command]
fn open_with(app: AppHandle, app_path: String, file_path: String) -> Result<(), String> {
    let program_path = std::path::PathBuf::from(&app_path);
    let program = if program_path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
    {
        resolve_shortcut(&program_path)?
    } else {
        program_path
    };
    let target = export_path(&file_path)?;
    launch_app(&program, &target)?;
    hide_window(&app);
    Ok(())
}

#[tauri::command]
fn workspace_names(state: State<AppState>) -> Vec<String> {
    state.names.lock().map(|names| names.clone()).unwrap_or_default()
}

#[tauri::command]
fn place_rail(width: f64, height: f64) {
    drop_shelf::place_rail(width, height);
}

#[tauri::command]
fn hover_workspace(name: String) {
    drop_shelf::activate_workspace(&name);
}

#[tauri::command]
fn set_workspace_names(state: State<AppState>, names: Vec<String>) {
    if let Ok(mut slot) = state.names.lock() {
        *slot = names;
    }
    drop_shelf::publish_names();
}

#[tauri::command]
fn set_active_surface(state: State<AppState>, workspace: String, folders: Vec<String>) {
    if let Ok(mut surface) = state.surface.lock() {
        *surface = (workspace, folders);
    }
}

#[tauri::command]
fn clipboard_files() -> Vec<String> {
    drop_shelf::clipboard_paths()
}

#[tauri::command]
fn drag_file_out(app: AppHandle, path: String) -> Result<bool, String> {
    let path = export_path(&path)?;
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(drag_out_now(&handle, &path));
    })
    .map_err(|err| err.to_string())?;
    rx.recv().unwrap_or(Err("拖拽被中断。".into()))
}

fn export_path(path: &str) -> Result<String, String> {
    let file = std::path::PathBuf::from(path);
    if !file.exists() {
        return Err("找不到这个文件。".into());
    }
    let shortcut = file
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"));
    if !shortcut {
        return Ok(path.to_string());
    }
    let target = resolve_shortcut(&file)?;
    if !target.is_dir() {
        return Ok(path.to_string());
    }
    if !target.exists() {
        return Err("快捷方式指向的文件夹不存在。".into());
    }
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn file_icons(paths: Vec<String>) -> std::collections::HashMap<String, String> {
    icon::icons_for(&paths)
}

#[tauri::command]
fn workspace_background(state: State<AppState>, workspace: String) -> Option<String> {
    let root = root_of(&state).ok()?;
    model::workspace_background(&root, &workspace)
}

#[tauri::command]
fn set_workspace_background(
    state: State<AppState>,
    workspace: String,
    source: String,
) -> Result<String, String> {
    model::set_workspace_background(&root_of(&state)?, &workspace, std::path::Path::new(&source))
}

#[tauri::command]
fn clear_workspace_background(state: State<AppState>, workspace: String) -> Result<(), String> {
    model::clear_workspace_background(&root_of(&state)?, &workspace)
}

#[tauri::command]
fn show_shell_menu(app: AppHandle, path: String, extended: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("找不到窗口。")?;
    let hwnd = window.hwnd().map_err(|err| err.to_string())?;
    let raw = hwnd.0 as isize;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = window.set_always_on_top(false);
        let result = shell_menu::show(raw as *mut std::ffi::c_void, &path, extended);
        let _ = window.set_always_on_top(true);
        let _ = tx.send(result);
    })
    .map_err(|err| err.to_string())?;
    rx.recv().map_err(|_| "系统菜单没有打开。".to_string())?
}

pub(crate) fn import_dropped(app: &AppHandle, paths: &[String]) -> Result<(), String> {
    let state = app.state::<AppState>();
    let root = root_of(&state)?;
    let mode = state
        .config
        .lock()
        .map_err(|_| "设置正在被占用。".to_string())?
        .drop_mode
        .clone();
    let surface = state
        .surface
        .lock()
        .map_err(|_| "工作区正在切换。".to_string())?;
    if surface.0.is_empty() {
        return Err("还没有打开的工作区。".into());
    }
    model::import_paths(&root, &surface.0, &surface.1, paths, &mode)?;
    let _ = app.emit("external-import", ());
    Ok(())
}

fn root_of(state: &State<AppState>) -> Result<std::path::PathBuf, String> {
    let config = state
        .config
        .lock()
        .map_err(|_| "设置正在被占用。".to_string())?;
    Ok(std::path::PathBuf::from(&config.root))
}

fn config_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join("config.json"))
}

fn load_config(app: &AppHandle) -> Result<Config, String> {
    let path = config_file(app)?;
    let config = if let Ok(text) = std::fs::read_to_string(&path) {
        serde_json::from_str(&text).unwrap_or_else(|_| model::default_config())
    } else {
        model::default_config()
    };
    std::fs::create_dir_all(&config.root).map_err(|err| err.to_string())?;
    save_config(app, &config)?;
    Ok(config)
}

fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_SZ,
    };

    const NAME: windows::core::PCWSTR = windows::core::w!("Folio");
    unsafe {
        let mut key = HKEY::default();
        let status = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            windows::core::w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run"),
            Some(0),
            KEY_SET_VALUE,
            &mut key,
        );
        if status != ERROR_SUCCESS {
            return Err("无法写入开机启动项。".into());
        }
        let _ = RegDeleteValueW(key, windows::core::w!("工作区"));
        let result = if enabled {
            let exe = std::env::current_exe().map_err(|err| format!("找不到程序位置：{err}"))?;
            let quoted = format!("\"{}\"", exe.display());
            let wide: Vec<u16> = std::ffi::OsStr::new(&quoted).encode_wide().chain(std::iter::once(0)).collect();
            let bytes: Vec<u8> = wide.iter().flat_map(|unit| unit.to_le_bytes()).collect();
            RegSetValueExW(key, NAME, Some(0), REG_SZ, Some(&bytes))
        } else {
            RegDeleteValueW(key, NAME)
        };
        let _ = RegCloseKey(key);
        if result == ERROR_SUCCESS || (!enabled && result == ERROR_FILE_NOT_FOUND) {
            Ok(())
        } else {
            Err("无法更新开机启动项。".into())
        }
    }
}

fn save_config(app: &AppHandle, config: &Config) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config).map_err(|err| err.to_string())?;
    std::fs::write(config_file(app)?, text).map_err(|err| err.to_string())
}

fn register_shortcut(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcut = app.global_shortcut();
    shortcut.unregister_all().map_err(|err| err.to_string())?;
    shortcut
        .register(accelerator)
        .map_err(|err| format!("快捷键注册失败：{err}"))
}

fn cursor_pos() -> (i32, i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut point);
    }
    (point.x, point.y)
}

fn show_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let (x, y) = cursor_pos();
    if let Ok(monitors) = window.available_monitors() {
        for monitor in monitors {
            let pos = monitor.position();
            let size = monitor.size();
            let right = pos.x + size.width as i32;
            let bottom = pos.y + size.height as i32;
            if x >= pos.x && x < right && y >= pos.y && y < bottom {
                let _ = window.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
                let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
                break;
            }
        }
    }
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.set_always_on_top(true);
    if let Ok(hwnd) = window.hwnd() {
        drop_shelf::attach_main(hwnd.0 as isize);
    }
    if drop_shelf::external_drag() {
        drop_shelf::present();
    } else {
        drop_shelf::hide();
    }
    let _ = app.emit("workspace-shown", ());
}

pub(crate) fn reveal_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let (x, y) = cursor_pos();
    if let Ok(monitors) = window.available_monitors() {
        for monitor in monitors {
            let pos = monitor.position();
            let size = monitor.size();
            let right = pos.x + size.width as i32;
            let bottom = pos.y + size.height as i32;
            if x >= pos.x && x < right && y >= pos.y && y < bottom {
                let _ = window.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
                let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
                break;
            }
        }
    }
    if let Ok(hwnd) = window.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
        unsafe {
            let _ = ShowWindow(HWND(hwnd.0 as *mut std::ffi::c_void), SW_SHOWNOACTIVATE);
        }
    }
    let _ = window.set_always_on_top(true);
    if let Ok(hwnd) = window.hwnd() {
        drop_shelf::attach_main(hwnd.0 as isize);
    }
    drop_shelf::present();
    let _ = app.emit("workspace-shown", ());
}

pub(crate) fn hide_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(false);
        let _ = window.hide();
    }
    drop_shelf::main_hidden();
}

fn toggle_window(app: &AppHandle) {
    let visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if visible {
        hide_window(app);
    } else {
        show_window(app);
    }
}

fn launch_app(app: &std::path::Path, file: &str) -> Result<(), String> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{HSTRING, PCWSTR};
    let program = HSTRING::from(app.as_os_str());
    let params = HSTRING::from(format!("\"{file}\""));
    let handle = unsafe {
        ShellExecuteW(
            None,
            windows::core::w!("open"),
            &program,
            &params,
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if (handle.0 as usize) <= 32 {
        return Err("无法用这个程序打开文件。".into());
    }
    Ok(())
}

fn resolve_shortcut(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        IPersistFile, STGM_READ,
    };
    use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
    use windows::Win32::UI::Shell::IShellLinkW;
    use windows::core::{Interface, GUID, HSTRING};

    let clsid = GUID::from_u128(0x0002_1401_0000_0000_c000_0000_0000_0046);
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if init.is_err() && init != windows::Win32::Foundation::RPC_E_CHANGED_MODE {
            return Err(format!("无法读取快捷方式：{init}"));
        }
        let link: IShellLinkW = CoCreateInstance(&clsid, None, CLSCTX_INPROC_SERVER)
            .map_err(|err| format!("无法读取快捷方式：{err}"))?;
        let persist: IPersistFile = link.cast().map_err(|err| err.to_string())?;
        persist
            .Load(&HSTRING::from(path.as_os_str()), STGM_READ)
            .map_err(|err| format!("无法读取快捷方式：{err}"))?;
        let mut buffer = vec![0u16; 1024];
        link.GetPath(buffer.as_mut_slice(), std::ptr::null_mut::<WIN32_FIND_DATAW>(), 0)
            .map_err(|err| format!("无法读取快捷方式：{err}"))?;
        let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
        let target = std::ffi::OsString::from_wide(&buffer[..end]);
        if target.is_empty() {
            return Err("这个快捷方式没有目标。".into());
        }
        Ok(std::path::PathBuf::from(target))
    }
}

fn drag_out_now(app: &AppHandle, path: &str) -> Result<bool, String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_NOTOPMOST, SWP_NOACTIVATE};
    drop_shelf::set_internal_drag(true);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(false);
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let _ = ReleaseCapture();
                let _ = SetWindowPos(
                    HWND(hwnd.0 as *mut std::ffi::c_void),
                    Some(HWND_NOTOPMOST),
                    -32000,
                    -32000,
                    200,
                    200,
                    SWP_NOACTIVATE,
                );
            }
        }
    }
    let dropped = shell_drag(path);
    drop_shelf::set_internal_drag(false);
    match dropped {
        Ok(true) => {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(hwnd) = window.hwnd() {
                    yield_foreground(hwnd.0 as *mut std::ffi::c_void);
                }
            }
            hide_window(app);
            Ok(true)
        }
        Ok(false) => {
            show_window(app);
            Ok(false)
        }
        Err(err) => {
            show_window(app);
            Err(err)
        }
    }
}

fn yield_foreground(our: *mut std::ffi::c_void) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetCursorPos, SetForegroundWindow, WindowFromPoint, GA_ROOT,
    };
    unsafe {
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        let hit = WindowFromPoint(point);
        if hit.0.is_null() {
            return;
        }
        let root = GetAncestor(hit, GA_ROOT);
        let target = if root.0.is_null() { hit } else { root };
        if target.0.is_null() || target.0 == our {
            return;
        }
        let _ = SetForegroundWindow(target);
    }
}

fn shell_drag(path: &str) -> Result<bool, String> {
    use windows::Win32::System::Com::IDataObject;
    use windows::Win32::System::Ole::{
        DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, ReleaseCapture, VK_LBUTTON};
    use windows::Win32::UI::Shell::{BHID_DataObject, IShellItem, SHCreateItemFromParsingName};
    use windows::core::{implement, BOOL, HSTRING, HRESULT};
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;

    #[implement(IDropSource)]
    struct FileDropSource;

    impl IDropSource_Impl for FileDropSource_Impl {
        fn QueryContinueDrag(&self, escape_pressed: BOOL, key_state: MODIFIERKEYS_FLAGS) -> HRESULT {
            if escape_pressed.as_bool() {
                return HRESULT(0x0004_0101);
            }
            let async_down = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } < 0;
            if async_down || (key_state.0 & 0x0001) != 0 {
                return HRESULT(0);
            }
            HRESULT(0x0004_0100)
        }

        fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
            HRESULT(0x0004_0102)
        }
    }

    unsafe {
        if let Err(err) = OleInitialize(None) {
            if err.code() != windows::Win32::Foundation::RPC_E_CHANGED_MODE {
                return Err(format!("无法拖出文件：{err}"));
            }
        }
        let _ = ReleaseCapture();
        let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(path), None)
            .map_err(|err| format!("无法拖出文件：{err}"))?;
        let data: IDataObject = item
            .BindToHandler(None, &BHID_DataObject)
            .map_err(|err| format!("无法拖出文件：{err}"))?;
        let source: IDropSource = FileDropSource.into();
        let mut effect = DROPEFFECT(0);
        let result = DoDragDrop(&data, &source, DROPEFFECT_COPY | DROPEFFECT_MOVE, &mut effect);
        if result.is_err() {
            return Err(format!("无法拖出文件：{result}"));
        }
        // 松手放到其他窗口后，即使对方没回报效果，也不要把本窗口再拉到前台。
        let cancelled = result.0 as u32 == 0x0004_0101;
        Ok(!cancelled && (result.0 as u32 == 0x0004_0100 || effect.0 != 0))
    }
}

fn open_with_shell(path: &str) -> Result<(), String> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{HSTRING, PCWSTR};
    let file = HSTRING::from(path);
    let handle = unsafe {
        ShellExecuteW(
            None,
            windows::core::w!("open"),
            &file,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if (handle.0 as usize) <= 32 {
        return Err("无法打开这个文件。".into());
    }
    Ok(())
}

fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let show = MenuItem::with_id(app, "show", "显示 / 隐藏", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let settings =
        MenuItem::with_id(app, "settings", "设置", true, None::<&str>).map_err(|err| err.to_string())?;
    let quit =
        MenuItem::with_id(app, "quit", "退出", true, None::<&str>).map_err(|err| err.to_string())?;
    let menu = Menu::with_items(app, &[&show, &settings, &quit]).map_err(|err| err.to_string())?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("缺少托盘图标。")?;
    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("Folio")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_window(app),
            "settings" => {
                show_window(app);
                let _ = app.emit("open-settings", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let config = load_config(app.handle())?;
            app.manage(AppState {
                config: Mutex::new(config.clone()),
                surface: Mutex::new((String::new(), Vec::new())),
                names: Mutex::new(Vec::new()),
            });
            if let Err(err) = register_shortcut(app.handle(), &config.shortcut) {
                eprintln!("{err}");
            }
            if let Err(err) = set_launch_at_login(config.launch_at_login) {
                eprintln!("{err}");
            }
            setup_tray(app.handle())?;
            if let Err(err) = drop_shelf::install(app.handle()) {
                eprintln!("{err}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            list_workspaces,
            create_workspace,
            rename_workspace,
            delete_workspace,
            list_dir,
            save_layout,
            import_paths,
            create_note,
            read_note,
            write_note,
            group_items,
            move_into,
            move_entry,
            delete_entry,
            open_path,
            open_with,
            workspace_names,
            place_rail,
            hover_workspace,
            set_workspace_names,
            set_active_surface,
            clipboard_files,
            drag_file_out,
            file_icons,
            workspace_background,
            set_workspace_background,
            clear_workspace_background,
            show_shell_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
