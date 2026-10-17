import { invoke } from "@tauri-apps/api/core";
import type { Config, DirListing, DropMode, Placement } from "./types";

type MockNode = {
  kind: "file" | "folder";
  content: string;
  note: boolean;
  layout: Record<string, Placement>;
  children: Record<string, MockNode>;
};

const mock = {
  config: {
    root: "C:\\Users\\示例\\Documents\\工作区",
    dropMode: "move" as DropMode,
    shortcut: "F7",
  },
  backgrounds: {} as Record<string, string>,
  order: ["采购项目", "设计稿"],
  nodes: {
    采购项目: folder({
      "供应商名单.xlsx": file(),
      合同: folder({ "2026年框架.pdf": file() }),
      "本周备注.md": note("周五前确认发货，缺的两家供应商单独标出来。"),
    }),
    设计稿: folder({
      "首页.fig": file(),
      "色板.png": file(),
    }),
  } as Record<string, MockNode>,
};

function file(): MockNode {
  return { kind: "file", content: "", note: false, layout: {}, children: {} };
}

function note(content: string): MockNode {
  return { kind: "file", content, note: true, layout: {}, children: {} };
}

function folder(children: Record<string, MockNode>, layout: Record<string, Placement> = {}): MockNode {
  return { kind: "folder", content: "", note: false, layout, children };
}

function child(workspace: string, folders: string[]) {
  let node = mock.nodes[workspace];
  for (const folderName of folders) {
    node = node?.children[folderName];
  }
  return node;
}

export function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getConfig(): Promise<Config> {
  if (!inTauri()) return { ...mock.config };
  return invoke<Config>("get_config");
}

export async function setConfig(config: Config): Promise<Config> {
  if (!inTauri()) {
    mock.config = { ...config };
    return getConfig();
  }
  return invoke<Config>("set_config", { next: config });
}

export async function listWorkspaces(): Promise<string[]> {
  if (!inTauri()) return [...mock.order];
  return invoke<string[]>("list_workspaces");
}

export async function createWorkspace(name: string): Promise<string> {
  if (!inTauri()) {
    if (mock.nodes[name]) throw new Error(`已经有工作区「${name}」。`);
    mock.nodes[name] = folder({});
    mock.order.push(name);
    return name;
  }
  return invoke<string>("create_workspace", { name });
}

export async function renameWorkspace(from: string, to: string): Promise<string> {
  if (!inTauri()) {
    if (!mock.nodes[from]) throw new Error("找不到这个工作区。");
    if (from !== to && mock.nodes[to]) throw new Error(`已经有工作区「${to}」。`);
    mock.nodes[to] = mock.nodes[from];
    if (from !== to) delete mock.nodes[from];
    mock.order = mock.order.map((item) => (item === from ? to : item));
    return to;
  }
  return invoke<string>("rename_workspace", { from, to });
}

export async function deleteWorkspace(name: string): Promise<void> {
  if (!inTauri()) {
    delete mock.nodes[name];
    mock.order = mock.order.filter((item) => item !== name);
    return;
  }
  return invoke("delete_workspace", { name });
}

export async function listDir(workspace: string, folders: string[]): Promise<DirListing> {
  if (!inTauri()) {
    const node = child(workspace, folders);
    if (!node) throw new Error("找不到这个文件夹。");
    const entries = Object.entries(node.children).map(([name, item]) => ({
      name,
      kind: item.kind,
      path: [mock.config.root, workspace, ...folders, name].join("\\"),
      content: item.note ? item.content : null,
    }));
    const layout = { ...node.layout };
    for (const [name, item] of Object.entries(node.children)) {
      if (item.note && !layout[name]) {
        layout[name] = { col: -1, row: -1, spanCol: 2, spanRow: 2, note: true };
      }
    }
    return { entries, layout };
  }
  return invoke<DirListing>("list_dir", { workspace, folders });
}

export async function saveLayout(
  workspace: string,
  folders: string[],
  items: Record<string, Placement>,
): Promise<void> {
  if (!inTauri()) {
    const node = child(workspace, folders);
    if (node) node.layout = items;
    return;
  }
  return invoke("save_layout", { workspace, folders, items });
}

export async function importPaths(
  workspace: string,
  folders: string[],
  paths: string[],
  mode: DropMode,
): Promise<void> {
  if (!inTauri()) {
    const node = child(workspace, folders);
    if (!node) return;
    for (const path of paths) {
      const name = path.split(/[/\\]/).pop() || "未命名";
      node.children[name] = file();
    }
    void mode;
    return;
  }
  return invoke("import_paths", { workspace, folders, paths, mode });
}

export async function createNote(workspace: string, folders: string[]): Promise<string> {
  if (!inTauri()) {
    const node = child(workspace, folders);
    if (!node) throw new Error("找不到这个文件夹。");
    const name = node.children["便签.md"] ? "便签 2.md" : "便签.md";
    node.children[name] = note("");
    return name;
  }
  return invoke<string>("create_note", { workspace, folders });
}

export async function writeNote(
  workspace: string,
  folders: string[],
  name: string,
  content: string,
): Promise<void> {
  if (!inTauri()) {
    const node = child(workspace, folders)?.children[name];
    if (node) node.content = content;
    return;
  }
  return invoke("write_note", { workspace, folders, name, content });
}

export async function groupItems(
  workspace: string,
  folders: string[],
  names: string[],
): Promise<string> {
  if (!inTauri()) {
    const node = child(workspace, folders);
    if (!node) throw new Error("找不到这个文件夹。");
    const group = folder({});
    for (const name of names) {
      if (node.children[name]) {
        group.children[name] = node.children[name];
        delete node.children[name];
      }
    }
    node.children["分组"] = group;
    return "分组";
  }
  return invoke<string>("group_items", { workspace, folders, names });
}

export async function moveInto(
  workspace: string,
  folders: string[],
  name: string,
  folderName: string,
): Promise<void> {
  if (!inTauri()) {
    const node = child(workspace, folders);
    const target = node?.children[folderName];
    const source = node?.children[name];
    if (!node || !target || !source || target.kind !== "folder") return;
    target.children[name] = source;
    delete node.children[name];
    return;
  }
  return invoke("move_into", { workspace, folders, name, folder: folderName });
}

export async function moveEntry(
  fromWorkspace: string,
  fromFolders: string[],
  name: string,
  toWorkspace: string,
  toFolders: string[],
): Promise<void> {
  if (!inTauri()) {
    const from = child(fromWorkspace, fromFolders);
    const to = child(toWorkspace, toFolders);
    if (!from || !to || !from.children[name]) return;
    to.children[name] = from.children[name];
    delete from.children[name];
    return;
  }
  return invoke("move_entry", {
    fromWorkspace,
    fromFolders,
    name,
    toWorkspace,
    toFolders,
  });
}

export async function deleteEntry(workspace: string, folders: string[], name: string): Promise<void> {
  if (!inTauri()) {
    const node = child(workspace, folders);
    if (node) delete node.children[name];
    return;
  }
  return invoke("delete_entry", { workspace, folders, name });
}

export async function openPath(path: string): Promise<void> {
  if (!inTauri()) return;
  return invoke("open_path", { path });
}

export async function openWith(appPath: string, filePath: string): Promise<void> {
  if (!inTauri()) return;
  return invoke("open_with", { appPath, filePath });
}

export async function dragFileOut(path: string): Promise<boolean> {
  if (!inTauri()) return false;
  return invoke<boolean>("drag_file_out", { path });
}

export async function setWorkspaceNames(names: string[]): Promise<void> {
  if (!inTauri()) return;
  return invoke("set_workspace_names", { names });
}

export async function setActiveSurface(workspace: string, folders: string[]): Promise<void> {
  if (!inTauri()) return;
  return invoke("set_active_surface", { workspace, folders });
}

export async function clipboardFiles(): Promise<string[]> {
  if (!inTauri()) return [];
  return invoke<string[]>("clipboard_files");
}

export async function readWorkspaceBackground(workspace: string): Promise<string | null> {
  if (!inTauri()) return mock.backgrounds[workspace] ?? null;
  return invoke<string | null>("workspace_background", { workspace });
}

export async function saveWorkspaceBackground(workspace: string, source: string): Promise<string> {
  if (!inTauri()) {
    mock.backgrounds[workspace] = source;
    return source;
  }
  return invoke<string>("set_workspace_background", { workspace, source });
}

export async function clearWorkspaceBackground(workspace: string): Promise<void> {
  if (!inTauri()) {
    delete mock.backgrounds[workspace];
    return;
  }
  return invoke("clear_workspace_background", { workspace });
}

export async function showShellMenu(path: string, extended: boolean): Promise<void> {
  if (!inTauri()) return;
  return invoke("show_shell_menu", { path, extended });
}

export async function fileIcons(paths: string[]): Promise<Record<string, string>> {
  if (!inTauri() || paths.length === 0) return {};
  return invoke<Record<string, string>>("file_icons", { paths });
}
