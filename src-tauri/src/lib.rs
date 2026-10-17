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

struct AppState {
    config: Mutex<Config>,
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
    *config = next;
    if let Err(err) = save_config(&app, &config) {
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
fn open_with(app_path: String, file_path: String) -> Result<(), String> {
    let app = std::path::PathBuf::from(&app_path);
    let target = if app.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("lnk")) {
        resolve_shortcut(&app)?
    } else {
        app
    };
    launch_app(&target, &file_path)
}

#[tauri::command]
fn drag_file_out(app: AppHandle, path: String) -> Result<(), String> {
    let file = std::path::PathBuf::from(&path);
    if !file.is_file() {
        return Err("只能把文件拖出去打开。".into());
    }
    hide_window(&app);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let dropped = shell_drag(&path).unwrap_or(false);
        if !dropped {
            show_window(&handle);
        }
    })
    .map_err(|err| err.to_string())
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
    let _ = app.emit("workspace-shown", ());
}

fn hide_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(false);
        let _ = window.hide();
    }
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

fn shell_drag(path: &str) -> Result<bool, String> {
    use windows::Win32::System::Com::IDataObject;
    use windows::Win32::System::Ole::{
        DoDragDrop, IDropSource, IDropSource_Impl, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE,
    };
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
            if (key_state.0 & 0x0001) == 0 {
                return HRESULT(0x0004_0100);
            }
            HRESULT(0)
        }

        fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
            HRESULT(0x0004_0102)
        }
    }

    unsafe {
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
        Ok(effect.0 != 0)
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
        .tooltip("工作区")
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
            });
            if let Err(err) = register_shortcut(app.handle(), &config.shortcut) {
                eprintln!("{err}");
            }
            setup_tray(app.handle())?;
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
