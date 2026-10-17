use base64::{engine::general_purpose::STANDARD, Engine};
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HBITMAP,
};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SHGetFileInfoW, SHFILEINFOW,
    SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY, SHGFI_ICON, SHGFI_LARGEICON,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};
use windows::core::HSTRING;

const ICON_PX: i32 = 256;

fn cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ensure_com() {
    thread_local! {
        static READY: Cell<bool> = const { Cell::new(false) };
    }
    READY.with(|ready| {
        if ready.get() {
            return;
        }
        unsafe {
            if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok() {
                ready.set(true);
            }
        }
    });
}

pub fn icons_for(paths: &[String]) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for path in paths {
        if let Some(icon) = icon_for(path) {
            result.insert(path.clone(), icon);
        }
    }
    result
}

fn icon_for(path: &str) -> Option<String> {
    if let Some(hit) = cache().lock().ok()?.get(path).cloned() {
        return Some(hit);
    }
    let encoded = extract_png(path)?;
    if let Ok(mut guard) = cache().lock() {
        guard.insert(path.to_string(), encoded.clone());
    }
    Some(encoded)
}

fn extract_png(path: &str) -> Option<String> {
    ensure_com();
    let bytes = shell_image(path).or_else(|| shell_icon(path))?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

fn shell_image(path: &str) -> Option<Vec<u8>> {
    unsafe {
        let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path), None).ok()?;
        let bitmap = factory
            .GetImage(SIZE { cx: ICON_PX, cy: ICON_PX }, SIIGBF_BIGGERSIZEOK | SIIGBF_ICONONLY)
            .ok()?;
        let png = hbitmap_to_png(bitmap, true);
        let _ = DeleteObject(bitmap.into());
        png
    }
}

fn shell_icon(path: &str) -> Option<Vec<u8>> {
    unsafe {
        let mut info = SHFILEINFOW::default();
        let flags = SHGFI_ICON | SHGFI_LARGEICON;
        let found = SHGetFileInfoW(
            &HSTRING::from(path),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        );
        if found == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let png = hicon_to_png(info.hIcon);
        let _ = DestroyIcon(info.hIcon);
        png
    }
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn hicon_to_png(icon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<Vec<u8>> {
    let mut icon_info = ICONINFO::default();
    GetIconInfo(icon, &mut icon_info).ok()?;
    let bitmap = if icon_info.hbmColor.is_invalid() {
        icon_info.hbmMask
    } else {
        icon_info.hbmColor
    };
    let png = hbitmap_to_png(bitmap, false);
    let _ = DeleteObject(icon_info.hbmColor.into());
    let _ = DeleteObject(icon_info.hbmMask.into());
    png
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn hbitmap_to_png(bitmap: HBITMAP, premultiplied: bool) -> Option<Vec<u8>> {
    let mut desc: BITMAP = std::mem::zeroed();
    let read = GetObjectW(
        bitmap.into(),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut desc as *mut BITMAP as *mut _),
    );
    if read == 0 {
        return None;
    }
    let width = desc.bmWidth.unsigned_abs();
    let height = desc.bmHeight.unsigned_abs();
    if width == 0 || height == 0 || width > 1024 || height > 1024 {
        return None;
    }
    let mut header = BITMAPINFOHEADER::default();
    header.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    header.biWidth = width as i32;
    header.biHeight = -(height as i32);
    header.biPlanes = 1;
    header.biBitCount = 32;
    header.biCompression = BI_RGB.0;
    let mut info = BITMAPINFO {
        bmiHeader: header,
        ..Default::default()
    };
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let dc = GetDC(None);
    let lines = GetDIBits(
        dc,
        bitmap,
        0,
        height,
        Some(pixels.as_mut_ptr() as *mut _),
        &mut info,
        DIB_RGB_COLORS,
    );
    let _ = ReleaseDC(None, dc);
    if lines == 0 {
        return None;
    }
    let has_alpha = pixels.chunks_exact(4).any(|pixel| pixel[3] != 0);
    for pixel in pixels.chunks_exact_mut(4) {
        if has_alpha && premultiplied && pixel[3] > 0 && pixel[3] < 255 {
            let alpha = pixel[3] as u16;
            pixel[0] = ((pixel[0] as u16 * 255) / alpha) as u8;
            pixel[1] = ((pixel[1] as u16 * 255) / alpha) as u8;
            pixel[2] = ((pixel[2] as u16 * 255) / alpha) as u8;
        } else if !has_alpha || (pixel[3] == 0 && (pixel[0] | pixel[1] | pixel[2]) > 0) {
            pixel[3] = 255;
        }
        pixel.swap(0, 2);
    }
    let mut output = Vec::new();
    let mut encoder = png::Encoder::new(&mut output, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().ok()?;
    writer.write_image_data(&pixels).ok()?;
    drop(writer);
    Some(output)
}
