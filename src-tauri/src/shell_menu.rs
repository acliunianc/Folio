#![allow(unsafe_op_in_unsafe_fn)]

use std::ffi::c_void;

use windows::Win32::Foundation::{HANDLE, HWND, POINT};
use windows::Win32::System::Com::{CoTaskMemFree, IBindCtx};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    IContextMenu, IShellFolder, ILClone, ILFindLastID, ILRemoveLastID, SHGetDesktopFolder,
    SHParseDisplayName, CMF_EXPLORE, CMF_EXTENDEDVERBS, CMF_NORMAL, CMINVOKECOMMANDINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, GetCursorPos, TrackPopupMenuEx, TPM_NONOTIFY, TPM_RETURNCMD,
    TPM_RIGHTBUTTON,
};
use windows::core::{HSTRING, PCSTR};

const CMD_FIRST: u32 = 1;
const CMD_LAST: u32 = 0x7fff;

pub fn show(owner: *mut c_void, path: &str, extended: bool) -> Result<(), String> {
    let mut point = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut point);
        popup(HWND(owner), path, point.x, point.y, extended)
    }
}

unsafe fn popup(hwnd: HWND, path: &str, x: i32, y: i32, extended: bool) -> Result<(), String> {
    let mut full: *mut ITEMIDLIST = std::ptr::null_mut();
    SHParseDisplayName(&HSTRING::from(path), None::<&IBindCtx>, &mut full, 0, None)
        .map_err(|err| format!("无法定位这个文件：{err}"))?;
    if full.is_null() {
        return Err("无法定位这个文件。".into());
    }
    let parent_pidl = ILClone(full);
    let child = ILFindLastID(full);
    if !parent_pidl.is_null() {
        let _ = ILRemoveLastID(Some(parent_pidl));
    }

    let desktop = SHGetDesktopFolder().map_err(|err| err.to_string())?;
    let folder: IShellFolder = if parent_pidl.is_null() || (*parent_pidl).mkid.cb == 0 {
        desktop
    } else {
        desktop
            .BindToObject(parent_pidl, None::<&IBindCtx>)
            .map_err(|err| format!("无法打开所在文件夹：{err}"))?
    };
    let listed = [child as *const ITEMIDLIST];
    let context: IContextMenu = folder
        .GetUIObjectOf(hwnd, &listed, None)
        .map_err(|err| format!("这个文件没有系统菜单：{err}"))?;
    let menu = CreatePopupMenu().map_err(|err| err.to_string())?;
    let mut flags = CMF_NORMAL | CMF_EXPLORE;
    if extended {
        flags |= CMF_EXTENDEDVERBS;
    }
    let queried = context.QueryContextMenu(menu, 0, CMD_FIRST, CMD_LAST, flags);
    if queried.is_err() {
        let _ = DestroyMenu(menu);
        free_pidl(full);
        free_pidl(parent_pidl);
        return Err("无法创建系统菜单。".into());
    }

    let chosen = TrackPopupMenuEx(
        menu,
        (TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON).0,
        x,
        y,
        hwnd,
        None,
    );
    let command = chosen.0 as u32;
    if command >= CMD_FIRST {
        let invoke = CMINVOKECOMMANDINFO {
            cbSize: std::mem::size_of::<CMINVOKECOMMANDINFO>() as u32,
            fMask: 0,
            hwnd,
            lpVerb: PCSTR((command - CMD_FIRST) as usize as *const u8),
            lpParameters: PCSTR::null(),
            lpDirectory: PCSTR::null(),
            nShow: 1,
            dwHotKey: 0,
            hIcon: HANDLE::default(),
        };
        if let Err(err) = context.InvokeCommand(&invoke) {
            let _ = DestroyMenu(menu);
            free_pidl(full);
            free_pidl(parent_pidl);
            return Err(format!("无法执行这个菜单项：{err}"));
        }
    }

    let _ = DestroyMenu(menu);
    free_pidl(full);
    free_pidl(parent_pidl);
    Ok(())
}

unsafe fn free_pidl(pidl: *mut ITEMIDLIST) {
    if !pidl.is_null() {
        CoTaskMemFree(Some(pidl as *const c_void));
    }
}
