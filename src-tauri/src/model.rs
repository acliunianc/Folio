use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub root: String,
    pub drop_mode: String,
    pub shortcut: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub col: i32,
    pub row: i32,
    #[serde(default = "one")]
    pub span_col: i32,
    #[serde(default = "one")]
    pub span_row: i32,
    #[serde(default)]
    pub note: bool,
}

fn one() -> i32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LayoutFile {
    #[serde(default)]
    version: i32,
    #[serde(default)]
    items: BTreeMap<String, Placement>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub kind: String,
    pub path: String,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub entries: Vec<DirEntry>,
    pub layout: BTreeMap<String, Placement>,
}

pub fn default_root() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Documents")
        .join("工作区")
}

pub fn default_config() -> Config {
    Config {
        root: default_root().to_string_lossy().to_string(),
        drop_mode: "move".to_string(),
        shortcut: "F7".to_string(),
    }
}

pub fn normalize(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn change_root(old: &Path, new: &Path) -> Result<(), String> {
    let old = normalize(old);
    let new = normalize(new);
    fs::create_dir_all(&new).map_err(|err| format!("无法创建总文件夹：{err}"))?;
    if old == new {
        return Ok(());
    }
    if new.starts_with(&old) {
        return Err("新位置不能放在当前总文件夹里面。".into());
    }
    if !old.exists() {
        return Ok(());
    }
    let names = workspace_dir_names(&old)?;
    for name in &names {
        if new.join(name).exists() {
            return Err(format!("新位置已有同名文件夹「{name}」，没有移动任何工作区。"));
        }
    }
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for name in &names {
        let src = old.join(name);
        let dest = new.join(name);
        if let Err(err) = move_path(&src, &dest) {
            for (src, dest) in moved.iter().rev() {
                let _ = move_path(dest, src);
            }
            return Err(format!("移动工作区失败，已退回原位置：{err}"));
        }
        moved.push((src, dest));
    }
    if dir_is_empty(&old) {
        let _ = fs::remove_dir(&old);
    }
    Ok(())
}

pub fn list_workspaces(root: &Path) -> Result<Vec<String>, String> {
    fs::create_dir_all(root).map_err(|err| err.to_string())?;
    let mut found = workspace_dir_names(root)?;
    let stored = read_order(root);
    let mut ordered = Vec::new();
    for name in stored {
        if let Some(index) = found.iter().position(|item| item == &name) {
            ordered.push(found.remove(index));
        }
    }
    found.sort();
    ordered.extend(found);
    write_order(root, &ordered)?;
    Ok(ordered)
}

pub fn create_workspace(root: &Path, name: &str) -> Result<String, String> {
    let name = clean_name(name)?;
    fs::create_dir_all(root).map_err(|err| err.to_string())?;
    let path = root.join(&name);
    if path.exists() {
        return Err(format!("已经有工作区「{name}」。"));
    }
    fs::create_dir(&path).map_err(|err| err.to_string())?;
    let mut order = list_workspaces(root)?;
    if !order.contains(&name) {
        order.push(name.clone());
        write_order(root, &order)?;
    }
    Ok(name)
}

pub fn rename_workspace(root: &Path, from: &str, to: &str) -> Result<String, String> {
    let to = clean_name(to)?;
    let src = root.join(from);
    let dest = root.join(&to);
    if !src.is_dir() {
        return Err("找不到这个工作区。".into());
    }
    if src != dest && dest.exists() {
        return Err(format!("已经有工作区「{to}」。"));
    }
    if src != dest {
        fs::rename(&src, &dest).map_err(|err| err.to_string())?;
    }
    let mut order = list_workspaces(root)?;
    if let Some(item) = order.iter_mut().find(|item| *item == from || *item == &to) {
        *item = to.clone();
    }
    write_order(root, &order)?;
    Ok(to)
}

pub fn delete_workspace(root: &Path, name: &str) -> Result<(), String> {
    let path = root.join(name);
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|err| err.to_string())?;
    }
    let order = list_workspaces(root)?
        .into_iter()
        .filter(|item| item != name)
        .collect::<Vec<_>>();
    write_order(root, &order)?;
    Ok(())
}

pub fn list_dir(root: &Path, workspace: &str, folders: &[String]) -> Result<DirListing, String> {
    let dir = resolve_dir(root, workspace, folders)?;
    let layout = read_layout(&dir);
    let mut entries = Vec::new();
    for item in fs::read_dir(&dir).map_err(|err| err.to_string())? {
        let item = item.map_err(|err| err.to_string())?;
        let name = item.file_name().to_string_lossy().to_string();
        if skipped_name(&name) {
            continue;
        }
        let path = item.path();
        let kind = if path.is_dir() { "folder" } else { "file" };
        let note = layout.items.get(&name).is_some_and(|place| place.note);
        let content = if note {
            fs::read_to_string(&path).ok()
        } else {
            None
        };
        entries.push(DirEntry {
            name,
            kind: kind.to_string(),
            path: path.to_string_lossy().to_string(),
            content,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(DirListing {
        entries,
        layout: layout.items,
    })
}

pub fn save_layout(
    root: &Path,
    workspace: &str,
    folders: &[String],
    items: BTreeMap<String, Placement>,
) -> Result<(), String> {
    let dir = resolve_dir(root, workspace, folders)?;
    write_layout(
        &dir,
        &LayoutFile {
            version: 1,
            items,
        },
    )
}

pub fn import_paths(
    root: &Path,
    workspace: &str,
    folders: &[String],
    sources: &[String],
    mode: &str,
) -> Result<(), String> {
    let dest_dir = resolve_dir(root, workspace, folders)?;
    for source in sources {
        let source = PathBuf::from(source);
        if !source.exists() {
            return Err(format!("找不到 {}", source.display()));
        }
        if source.parent() == Some(dest_dir.as_path()) {
            continue;
        }
        let file_name = source
            .file_name()
            .ok_or("无法识别文件名")?
            .to_string_lossy()
            .to_string();
        let dest = match mode {
            "copy" => unique_dest(dest_dir.join(file_name)),
            "shortcut" if !is_lnk(&source) => {
                let stem = source
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                dest_dir.join(unique_name(&dest_dir, &stem, ".lnk"))
            }
            _ => unique_dest(dest_dir.join(file_name)),
        };
        match mode {
            "copy" => copy_path(&source, &dest)?,
            "shortcut" if !is_lnk(&source) => create_shortcut(&dest, &source)?,
            _ => move_path(&source, &dest)?,
        }
    }
    Ok(())
}

pub fn create_note(root: &Path, workspace: &str, folders: &[String]) -> Result<String, String> {
    let dir = resolve_dir(root, workspace, folders)?;
    let name = unique_name(&dir, "便签", ".md");
    fs::write(dir.join(&name), "").map_err(|err| err.to_string())?;
    let mut layout = read_layout(&dir);
    layout.items.insert(
        name.clone(),
        Placement {
            col: -1,
            row: -1,
            span_col: 2,
            span_row: 2,
            note: true,
        },
    );
    write_layout(&dir, &layout)?;
    Ok(name)
}

pub fn read_note(
    root: &Path,
    workspace: &str,
    folders: &[String],
    name: &str,
) -> Result<String, String> {
    let path = resolve_dir(root, workspace, folders)?.join(clean_name(name)?);
    fs::read_to_string(path).map_err(|err| err.to_string())
}

pub fn write_note(
    root: &Path,
    workspace: &str,
    folders: &[String],
    name: &str,
    content: &str,
) -> Result<(), String> {
    let path = resolve_dir(root, workspace, folders)?.join(clean_name(name)?);
    fs::write(path, content).map_err(|err| err.to_string())
}

pub fn group_items(
    root: &Path,
    workspace: &str,
    folders: &[String],
    names: &[String],
) -> Result<String, String> {
    if names.len() < 2 {
        return Err("需要两个项目才能成组。".into());
    }
    let dir = resolve_dir(root, workspace, folders)?;
    if names.iter().any(|name| is_note(&dir, name)) {
        return Err("便签只能放在工作区桌面，不能成组。".into());
    }
    let group_name = unique_name(&dir, "分组", "");
    let group = dir.join(&group_name);
    fs::create_dir(&group).map_err(|err| err.to_string())?;
    for name in names {
        let src = dir.join(name);
        if src.exists() {
            move_path(&src, &group.join(name))?;
        }
    }
    Ok(group_name)
}

pub fn move_into(
    root: &Path,
    workspace: &str,
    folders: &[String],
    name: &str,
    folder: &str,
) -> Result<(), String> {
    let dir = resolve_dir(root, workspace, folders)?;
    if is_note(&dir, name) {
        return Err("便签只能放在工作区桌面，不能放进文件夹。".into());
    }
    let src = dir.join(clean_name(name)?);
    let folder = dir.join(clean_name(folder)?);
    if !folder.is_dir() {
        return Err("目标不是文件夹。".into());
    }
    let dest = unique_dest(folder.join(src.file_name().unwrap_or_default()));
    move_path(&src, &dest)
}

pub fn move_entry(
    root: &Path,
    from_workspace: &str,
    from_folders: &[String],
    name: &str,
    to_workspace: &str,
    to_folders: &[String],
) -> Result<(), String> {
    let from_dir = resolve_dir(root, from_workspace, from_folders)?;
    let to_dir = resolve_dir(root, to_workspace, to_folders)?;
    if from_dir == to_dir {
        return Ok(());
    }
    if !to_folders.is_empty() && is_note(&from_dir, name) {
        return Err("便签只能放在工作区桌面，不能放进文件夹。".into());
    }
    let src = from_dir.join(clean_name(name)?);
    let dest = unique_dest(to_dir.join(src.file_name().unwrap_or_default()));
    move_path(&src, &dest)
}

pub fn delete_entry(
    root: &Path,
    workspace: &str,
    folders: &[String],
    name: &str,
) -> Result<(), String> {
    let path = resolve_dir(root, workspace, folders)?.join(clean_name(name)?);
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|err| err.to_string())
    } else if path.exists() {
        fs::remove_file(path).map_err(|err| err.to_string())
    } else {
        Ok(())
    }
}

pub fn workspace_background(root: &Path, workspace: &str) -> Option<String> {
    let path = find_background(root, workspace)?;
    let bytes = fs::read(&path).ok()?;
    let mime = image_mime(&path);
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

pub fn set_workspace_background(root: &Path, workspace: &str, source: &Path) -> Result<String, String> {
    if !source.is_file() {
        return Err("找不到这张图片。".into());
    }
    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif") {
        return Err("请选择 png、jpg、webp、bmp 或 gif 图片。".into());
    }
    let dir = resolve_dir(root, workspace, &[])?;
    clear_background_files(&dir)?;
    let dest = dir.join(format!(".background.{ext}"));
    fs::copy(source, &dest).map_err(|err| format!("无法保存背景：{err}"))?;
    workspace_background(root, workspace).ok_or_else(|| "无法读取背景图。".into())
}

pub fn clear_workspace_background(root: &Path, workspace: &str) -> Result<(), String> {
    let dir = resolve_dir(root, workspace, &[])?;
    clear_background_files(&dir)
}

fn find_background(root: &Path, workspace: &str) -> Option<PathBuf> {
    let dir = resolve_dir(root, workspace, &[]).ok()?;
    fs::read_dir(dir).ok()?.find_map(|item| {
        let path = item.ok()?.path();
        let name = path.file_name()?.to_string_lossy().to_string();
        name.to_ascii_lowercase().starts_with(".background.").then_some(path)
    })
}

fn clear_background_files(dir: &Path) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|err| err.to_string())?;
    for item in entries {
        let path = item.map_err(|err| err.to_string())?.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if name.to_ascii_lowercase().starts_with(".background.") {
            fs::remove_file(path).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn image_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        _ => "image/png",
    }
}

fn resolve_dir(root: &Path, workspace: &str, folders: &[String]) -> Result<PathBuf, String> {
    let mut path = root.join(clean_name(workspace)?);
    for folder in folders {
        path.push(clean_name(folder)?);
    }
    if !path.is_dir() {
        return Err("找不到这个文件夹。".into());
    }
    Ok(path)
}

fn workspace_dir_names(root: &Path) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    if !root.exists() {
        return Ok(names);
    }
    for item in fs::read_dir(root).map_err(|err| err.to_string())? {
        let item = item.map_err(|err| err.to_string())?;
        if !item.path().is_dir() {
            continue;
        }
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        names.push(name);
    }
    Ok(names)
}

fn read_order(root: &Path) -> Vec<String> {
    let path = root.join(".order.json");
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_order(root: &Path, names: &[String]) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|err| err.to_string())?;
    let text = serde_json::to_string_pretty(names).map_err(|err| err.to_string())?;
    fs::write(root.join(".order.json"), text).map_err(|err| err.to_string())
}

fn is_note(dir: &Path, name: &str) -> bool {
    read_layout(dir).items.get(name).is_some_and(|place| place.note)
}

fn read_layout(dir: &Path) -> LayoutFile {
    let Ok(text) = fs::read_to_string(dir.join(".layout.json")) else {
        return LayoutFile::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_layout(dir: &Path, layout: &LayoutFile) -> Result<(), String> {
    let text = serde_json::to_string_pretty(layout).map_err(|err| err.to_string())?;
    fs::write(dir.join(".layout.json"), text).map_err(|err| err.to_string())
}

fn skipped_name(name: &str) -> bool {
    name.starts_with('.')
        || name.eq_ignore_ascii_case("desktop.ini")
        || name.eq_ignore_ascii_case("thumbs.db")
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let invalid = name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with('.')
        || name.ends_with(' ')
        || name
            .chars()
            .any(|ch| matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'));
    if invalid {
        return Err("名称不能包含 \\ / : * ? \" < > |，也不能以空格或句点结尾。".into());
    }
    Ok(name.to_string())
}

fn dir_is_empty(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut items| items.next().is_none())
        .unwrap_or(false)
}

fn is_lnk(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
}

fn unique_name(dir: &Path, stem: &str, ext: &str) -> String {
    let first = format!("{stem}{ext}");
    if !dir.join(&first).exists() {
        return first;
    }
    for index in 2..1000 {
        let candidate = format!("{stem} {index}{ext}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem} {}{ext}", std::process::id())
}

fn unique_dest(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let parent = path.parent().unwrap_or(Path::new(".")).to_path_buf();
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default();
    parent.join(unique_name(&parent, &stem, &ext))
}

fn move_path(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_path(from, to)?;
            if from.is_dir() {
                fs::remove_dir_all(from).map_err(|err| err.to_string())?;
            } else {
                fs::remove_file(from).map_err(|err| err.to_string())?;
            }
            Ok(())
        }
    }
}

fn copy_path(from: &Path, to: &Path) -> Result<(), String> {
    if from.is_dir() {
        fs::create_dir_all(to).map_err(|err| err.to_string())?;
        for item in fs::read_dir(from).map_err(|err| err.to_string())? {
            let item = item.map_err(|err| err.to_string())?;
            copy_path(&item.path(), &to.join(item.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        fs::copy(from, to).map(|_| ()).map_err(|err| err.to_string())
    }
}

fn create_shortcut(link_path: &Path, target: &Path) -> Result<(), String> {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        IPersistFile,
    };
    use windows::Win32::UI::Shell::IShellLinkW;
    use windows::core::{Interface, GUID, HSTRING};

    if let Some(parent) = link_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let workdir = target.parent().unwrap_or(target);
    let clsid = GUID::from_u128(0x0002_1401_0000_0000_c000_0000_0000_0046);
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if init.is_err() && init != windows::Win32::Foundation::RPC_E_CHANGED_MODE {
            return Err(format!("无法初始化快捷方式：{init}"));
        }
        let link: IShellLinkW = CoCreateInstance(&clsid, None, CLSCTX_INPROC_SERVER)
            .map_err(|err| format!("无法创建快捷方式：{err}"))?;
        link.SetPath(&HSTRING::from(target.as_os_str()))
            .map_err(|err| err.to_string())?;
        link.SetWorkingDirectory(&HSTRING::from(workdir.as_os_str()))
            .map_err(|err| err.to_string())?;
        let persist: IPersistFile = link.cast().map_err(|err| err.to_string())?;
        persist
            .Save(&HSTRING::from(link_path.as_os_str()), true)
            .map_err(|err| format!("无法保存快捷方式：{err}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "workspace-model-{}-{}",
            std::process::id(),
            unique_token()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn unique_token() -> u128 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(1);
        NEXT.fetch_add(1, Ordering::Relaxed) as u128
    }

    #[test]
    fn moves_existing_workspaces_into_the_new_folder() {
        let base = scratch();
        let old = base.join("old");
        let new_root = base.join("new");
        fs::create_dir_all(old.join("项目甲")).unwrap();
        fs::write(old.join("项目甲").join("a.txt"), "hi").unwrap();
        fs::create_dir_all(&new_root).unwrap();

        change_root(&old, &new_root).unwrap();

        assert_eq!(
            fs::read_to_string(new_root.join("项目甲").join("a.txt")).unwrap(),
            "hi"
        );
        assert!(!old.join("项目甲").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn keeps_files_in_place_when_the_new_folder_has_the_same_name() {
        let base = scratch();
        let old = base.join("old");
        let new_root = base.join("new");
        fs::create_dir_all(old.join("项目甲")).unwrap();
        fs::write(old.join("项目甲").join("a.txt"), "hi").unwrap();
        fs::create_dir_all(new_root.join("项目甲")).unwrap();

        let err = change_root(&old, &new_root).unwrap_err();

        assert!(err.contains("项目甲"));
        assert_eq!(
            fs::read_to_string(old.join("项目甲").join("a.txt")).unwrap(),
            "hi"
        );
        let _ = fs::remove_dir_all(&base);
    }
}
