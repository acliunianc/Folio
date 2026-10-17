import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type CollisionDetection,
  type Modifier,
  useDroppable,
} from "@dnd-kit/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  createNote,
  createWorkspace,
  deleteEntry,
  deleteWorkspace,
  fileIcons,
  getConfig,
  groupItems,
  importPaths,
  inTauri,
  listDir,
  listWorkspaces,
  moveEntry,
  moveInto,
  openPath,
  openWith,
  clipboardFiles,
  dragFileOut,
  setActiveSurface,
  setWorkspaceNames,
  readWorkspaceBackground,
  saveWorkspaceBackground,
  clearWorkspaceBackground,
  showShellMenu,
  saveLayout,
  setConfig,
  writeNote,
} from "./api";
import { Board, snapIconSize } from "./Board";
import { arrange, moveItem, packTopLeft, placePacked, resizeItem } from "./layout";
import { WorkspaceRail } from "./WorkspaceRail";
import type { Config, DropMode, FolderChild, GridItem, Placement } from "./types";

const wallpaper = "/t01678398d736b184ed.jpg";

type DragData =
  | { type: "item"; name: string; spanCol: number; spanRow: number }
  | { type: "cell"; col: number; row: number }
  | { type: "workspace"; name: string }
  | { type: "parent" };

type Carry = {
  name: string;
  source: string[];
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
  width: number;
  height: number;
  node: HTMLElement;
};

function cellsOf(col: number, row: number) {
  return document.querySelector(`[data-cell][data-col="${col}"][data-row="${row}"]`);
}

function itemOutsidePanel(name: string) {
  const panel = document.querySelector("[data-folder-panel]");
  const ghost = document.querySelector("[data-drag-ghost]");
  const node = ghost ?? document.querySelector(`[data-item][data-name="${CSS.escape(name)}"]`);
  if (!(panel instanceof HTMLElement) || !(node instanceof HTMLElement)) return false;
  const box = panel.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  return rect.left < box.left || rect.left > box.right || rect.top < box.top || rect.top > box.bottom;
}

const snapTopLeft: Modifier = ({ transform, draggingNodeRect, active }) => {
  const data = active?.data.current as DragData | undefined;
  if (!draggingNodeRect || data?.type !== "item") return transform;
  const left = draggingNodeRect.left + transform.x;
  const top = draggingNodeRect.top + transform.y;
  const panel = document.querySelector("[data-folder-panel]");
  if (panel) {
    const box = panel.getBoundingClientRect();
    if (left < box.left || left > box.right || top < box.top || top > box.bottom) return transform;
  }
  const under = document.elementsFromPoint(left, top).find((node) => node instanceof Element && !node.closest("[data-item]"));
  if (
    under instanceof Element &&
    (under.closest("[data-workspace]") || (under.closest("[data-parent]") && !under.closest("[data-folder-panel]")))
  ) {
    return transform;
  }
  let best: HTMLElement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const cell of document.querySelectorAll<HTMLElement>("[data-cell]")) {
    const col = Number(cell.dataset.col);
    const row = Number(cell.dataset.row);
    if (!cellsOf(col + data.spanCol - 1, row + data.spanRow - 1)) continue;
    const rect = cell.getBoundingClientRect();
    const distance = (left - rect.left) ** 2 + (top - rect.top) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = cell;
    }
  }
  if (!best) return transform;
  const rect = best.getBoundingClientRect();
  return { ...transform, x: rect.left - draggingNodeRect.left, y: rect.top - draggingNodeRect.top };
};

let outsideCollision: ReturnType<CollisionDetection> | null = null;

const alignByTopLeft: CollisionDetection = ({ collisionRect, droppableContainers, droppableRects }) => {
  const x = collisionRect.left + 1;
  const y = collisionRect.top + 1;
  const panel = document.querySelector("[data-folder-panel]");
  if (panel) {
    const box = panel.getBoundingClientRect();
    const outside = x < box.left || x > box.right || y < box.top || y > box.bottom;
    // Keep the previous cell while the item is outside the panel. Changing the drop
    // target here swaps scroll parents and makes dnd-kit remeasure without end.
    if (outside) return outsideCollision ?? [];
  } else {
    outsideCollision = null;
  }
  const incomingEl = document.querySelector("[data-incoming]");
  const incomingBox = incomingEl?.getBoundingClientRect();
  const overIncoming = Boolean(
    incomingBox && x >= incomingBox.left && x <= incomingBox.right && y >= incomingBox.top && y <= incomingBox.bottom,
  );
  const hits = [];
  for (const container of droppableContainers) {
    const node = container.node.current;
    const inIncoming = node instanceof HTMLElement && Boolean(node.closest("[data-incoming]"));
    if (overIncoming !== inIncoming) continue;
    const rect = droppableRects.get(container.id);
    const kind = (container.data.current as DragData | undefined)?.type;
    if (!rect || (kind !== "cell" && kind !== "workspace" && kind !== "parent")) continue;
    if (kind === "parent") continue;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    const value = kind === "workspace" ? 3 : kind === "cell" ? 2 : 1;
    hits.push({ id: container.id, data: { droppableContainer: container, value } });
  }
  if (hits.length > 0) {
    const sorted = hits.sort((a, b) => b.data.value - a.data.value);
    if ((sorted[0].data.droppableContainer.data.current as DragData | undefined)?.type === "cell") {
      outsideCollision = sorted.slice(0, 1);
    }
    return sorted;
  }
  let best: (typeof droppableContainers)[number] | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const container of droppableContainers) {
    if ((container.data.current as DragData | undefined)?.type !== "cell") continue;
    const node = container.node.current;
    const inIncoming = node instanceof HTMLElement && Boolean(node.closest("[data-incoming]"));
    if (overIncoming !== inIncoming) continue;
    const rect = droppableRects.get(container.id);
    if (!rect) continue;
    const distance = (collisionRect.left - rect.left) ** 2 + (collisionRect.top - rect.top) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = container;
    }
  }
  if (!best) return outsideCollision ?? [];
  outsideCollision = [{ id: best.id, data: { droppableContainer: best, value: 1 } }];
  return outsideCollision;
};

export default function App() {
  const [config, setConfigState] = useState<Config | null>(null);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [folders, setFolders] = useState<string[]>([]);
  const [items, setItems] = useState<GridItem[]>([]);
  const [cols, setCols] = useState(8);
  const [rows, setRows] = useState(4);
  const [folderGrid, setFolderGrid] = useState({ cols: 6, rows: 4 });
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [batchEdit, setBatchEdit] = useState(false);
  const [externalDrag, setExternalDrag] = useState(false);
  const [edgeHint, setEdgeHint] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; item: string | null } | null>(null);
  const [frequentMenu, setFrequentMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [backgrounds, setBackgrounds] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, GridItem[]>>({});
  const [folderKids, setFolderKids] = useState<Record<string, FolderChild[]>>({});
  const [frequent, setFrequent] = useState<FrequentItem[]>(() => readFrequent());
  const [dragX, setDragX] = useState(0);
  const [paging, setPaging] = useState(false);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [incomingItems, setIncomingItems] = useState<GridItem[] | null>(null);
  const [overCell, setOverCell] = useState<{ col: number; row: number } | null>(null);
  const [ghost, setGhost] = useState<{ node: HTMLElement; width: number; height: number } | null>(null);
  const [overName, setOverName] = useState<string | null>(null);
  const [carry, setCarry] = useState<Carry | null>(null);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ title: string; value: string; onSubmit: (value: string) => void } | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; onYes: () => void } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);
  const handedOff = useRef(false);
  const nativeDrag = useRef(false);
  const edgeListen = useRef<(() => void) | null>(null);
  const groupPending = useRef<string | null>(null);
  const lastPointer = useRef({ x: 0, y: 0 });
  const groupTimer = useRef<number | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const opening = useRef(false);
  const suppressDrop = useRef(false);
  const activeNameRef = useRef<string | null>(null);
  const dragTargetRef = useRef<string | null>(null);
  const goToRef = useRef<(next: number) => void>(() => {});
  const workspacesRef = useRef<string[]>([]);
  const itemsRef = useRef(items);
  const colsRef = useRef(cols);
  const rowsRef = useRef(rows);
  const folderColsRef = useRef(folderGrid.cols);
  const boardKeyRef = useRef("");
  const carryRef = useRef<Carry | null>(null);
  const carryListen = useRef<(() => void) | null>(null);
  const seenInside = useRef(false);
  const editingRef = useRef(false);
  const editing = batchEdit || activeName !== null || carry !== null;
  editingRef.current = editing;
  itemsRef.current = items;
  colsRef.current = cols;
  rowsRef.current = rows;
  folderColsRef.current = folderGrid.cols;
  const surface = useRef({ workspace: "", folders: [] as string[] });
  const boardRequest = useRef(0);
  const boardCache = useRef(new Map<string, GridItem[]>());
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  const [boardKey, setBoardKey] = useState("");
  boardKeyRef.current = boardKey;
  const [overview, setOverview] = useState(false);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<{
    name: string;
    from: DOMRect;
    x: number;
    y: number;
    scale: number;
    placed: boolean;
    live: boolean;
  } | null>(null);

  const workspace = workspaces[index] ?? "";
  const needle = query.trim().toLowerCase();
  surface.current = { workspace, folders };
  const dropModeRef = useRef(config?.dropMode ?? "move");
  dropModeRef.current = config?.dropMode ?? "move";
  const overviewRef = useRef(overview);
  overviewRef.current = overview;

  useEffect(() => {
    let cancelled = false;
    void Promise.all(workspaces.map(async (name) => [name, await readWorkspaceBackground(name)] as const)).then((pairs) => {
      if (cancelled) return;
      setBackgrounds(Object.fromEntries(pairs.filter((pair): pair is [string, string] => Boolean(pair[1]))));
    });
    return () => {
      cancelled = true;
    };
  }, [workspaces]);

  function wallpaperOf(name: string) {
    return backgrounds[name] || wallpaper;
  }

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: batchEdit ? { distance: 4 } : { delay: 280, tolerance: 6 },
    }),
  );

  const showError = useCallback((error: unknown) => {
    setToast(error instanceof Error ? error.message : String(error));
  }, []);

  const goTo = useCallback((next: number) => {
    const name = workspaces[next] ?? "";
    if (workspace) boardCache.current.set(storageKey(workspace, folders), items);
    boardRequest.current += 1;
    const cached = boardCache.current.get(storageKey(name, [])) ?? previewsRef.current[name];
    setFolders([]);
    setIndex(next);
    if (name && cached) {
      setItems(cached);
      setBoardKey(storageKey(name, []));
    } else {
      setItems([]);
      setBoardKey("");
    }
  }, [workspaces, workspace, folders, items]);
  goToRef.current = goTo;
  workspacesRef.current = workspaces;

  const reload = useCallback(async () => {
    const names = await listWorkspaces();
    setWorkspaces(names);
    setFolders([]);
    setIndex((current) => Math.min(current, Math.max(0, names.length - 1)));
  }, []);

  const loadBoard = useCallback(
    async (name: string, path: string[], minRows: number) => {
      if (!name) {
        setItems([]);
        setBoardKey("");
        return;
      }
      const ticket = ++boardRequest.current;
      const released = await releaseSingletonGroup(name, path);
      if (ticket !== boardRequest.current) return;
      if (released) {
        boardCache.current.delete(storageKey(name, path));
        boardCache.current.delete(storageKey(name, released));
        setFolders(released);
        return;
      }
      if (await dissolveSingletonGroups(name, path)) {
        if (ticket !== boardRequest.current) return;
        boardCache.current.delete(storageKey(name, path));
      }
      const listing = await listDir(name, path);
      if (ticket !== boardRequest.current) return;
      const arranged = arrange(listing.entries, listing.layout, cols, minRows);
      if (ticket !== boardRequest.current) return;
      let nextItems = arranged.items;
      let dirty = arranged.dirty;
      let nextRows = arranged.rows;
      if (path.length > 0) {
        const packed = packTopLeft(nextItems, folderColsRef.current);
        if (!samePlaces(nextItems, packed)) {
          nextItems = packed;
          dirty = true;
          nextRows = Math.max(nextRows, ...packed.map((item) => item.row + item.spanRow));
        }
      }
      if (ticket !== boardRequest.current) return;
      const key = storageKey(name, path);
      boardCache.current.set(key, nextItems);
      setItems(nextItems);
      setBoardKey(key);
      setRows((current) => Math.max(current, nextRows, minRows));
      if (dirty) {
        await saveLayout(name, path, toLayout(nextItems));
      }
      const icons = await fileIcons(nextItems.map((item) => item.path));
      if (ticket !== boardRequest.current) return nextItems;
      setIcons((current) => ({ ...current, ...icons }));
      return nextItems;
    },
    [cols],
  );

  useEffect(() => {
    void (async () => {
      try {
        const next = await getConfig();
        setConfigState(next);
        const names = await listWorkspaces();
        setWorkspaces(names);
        if (location.hash === "#settings") setSettingsOpen(true);
      } catch (error) {
        showError(error);
      }
    })();
  }, [showError]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, GridItem[]> = {};
      for (const name of workspaces) {
        try {
          const listing = await listDir(name, []);
          next[name] = arrange(listing.entries, listing.layout, Math.max(cols, 1), Math.max(rows, 1)).items;
        } catch {
          next[name] = [];
        }
      }
      if (cancelled) return;
      setPreviews(next);
      const paths = Object.values(next).flat().map((item) => item.path);
      if (paths.length === 0) return;
      const found = await fileIcons(paths);
      if (!cancelled) setIcons((current) => ({ ...current, ...found }));
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaces, items, cols, rows]);

  useEffect(() => {
    let cancelled = false;
    const jobs: { workspace: string; folders: string[]; path: string }[] = [];
    for (const [workspaceName, list] of Object.entries(previews)) {
      for (const item of list) {
        if (item.kind === "folder") jobs.push({ workspace: workspaceName, folders: [item.name], path: item.path });
      }
    }
    for (const item of items) {
      if (item.kind !== "folder") continue;
      jobs.push({ workspace, folders: [...folders, item.name], path: item.path });
    }
    void (async () => {
      const next: Record<string, FolderChild[]> = {};
      const iconPaths: string[] = [];
      for (const job of jobs) {
        try {
          const listing = await listDir(job.workspace, job.folders);
          next[job.path] = listing.entries.slice(0, 9).map((entry) => ({
            name: entry.name,
            kind: entry.kind,
            path: entry.path,
          }));
          iconPaths.push(...next[job.path].map((child) => child.path));
        } catch {
          next[job.path] = [];
        }
      }
      if (cancelled) return;
      setFolderKids(next);
      if (iconPaths.length === 0) return;
      const found = await fileIcons(iconPaths);
      if (!cancelled) setIcons((current) => ({ ...current, ...found }));
    })();
    return () => {
      cancelled = true;
    };
  }, [previews, items, folders, workspace]);

  useEffect(() => {
    if (!workspace || suppressDrop.current) return;
    const minRows = measureRows();
    void loadBoard(workspace, folders, minRows).catch(showError);
  }, [workspace, folders, loadBoard, showError]);

  useEffect(() => {
    if (!workspace || folders.length === 0 || suppressDrop.current) return;
    void loadBoard(workspace, folders, measureRows()).catch(showError);
  }, [folderGrid.cols, workspace, folders, loadBoard, showError]);

  useEffect(() => {
    if (!inTauri()) return;
    const unlisten: Array<() => void> = [];
    void listen("open-settings", () => setSettingsOpen(true)).then((stop) => unlisten.push(stop));
    void listen("workspace-shown", () => {
      const current = surface.current;
      if (current.workspace) {
        void loadBoard(current.workspace, current.folders, measureRows()).catch(showError);
      }
    }).then((stop) => unlisten.push(stop));
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setExternalDrag(true);
          return;
        }
        setExternalDrag(false);
        if (event.payload.type !== "drop" || nativeDrag.current) return;
        const current = surface.current;
        if (!current.workspace || event.payload.paths.length === 0) return;
        boardCache.current.delete(storageKey(current.workspace, current.folders));
        void importPaths(current.workspace, current.folders, event.payload.paths, config?.dropMode ?? "move")
          .then(() => loadBoard(current.workspace, current.folders, measureRows()))
          .catch(showError);
      })
      .then((stop) => unlisten.push(stop));
    void listen<boolean>("external-drag", (event) => {
      nativeDrag.current = event.payload;
      setExternalDrag(event.payload);
    }).then((stop) => unlisten.push(stop));
    void listen<string>("app-error", (event) => showError(new Error(event.payload))).then((stop) => unlisten.push(stop));
    void listen<string>("activate-workspace", (event) => {
      const next = workspacesRef.current.indexOf(event.payload);
      if (next < 0) return;
      setOverview(false);
      goToRef.current(next);
    }).then((stop) => unlisten.push(stop));
    void listen("external-import", () => {
      const current = surface.current;
      if (!current.workspace) return;
      boardCache.current.delete(storageKey(current.workspace, current.folders));
      void loadBoard(current.workspace, current.folders, measureRows()).catch(showError);
    }).then((stop) => unlisten.push(stop));
    return () => unlisten.forEach((stop) => stop());
  }, [config?.dropMode, loadBoard, showError]);

  useEffect(() => {
    if (!inTauri()) return;
    void setActiveSurface(workspace, folders);
  }, [workspace, folders]);

  useEffect(() => {
    if (!inTauri()) return;
    void setWorkspaceNames(workspaces);
  }, [workspaces]);

  useEffect(() => {
    if (!dragTarget || dragTarget === workspace) {
      setIncomingItems(null);
      return;
    }
    const cached = boardCache.current.get(storageKey(dragTarget, [])) ?? previewsRef.current[dragTarget];
    if (cached) {
      setIncomingItems(cached);
      return;
    }
    setIncomingItems([]);
    let cancel = false;
    void listDir(dragTarget, []).then((listing) => {
      if (cancel) return;
      setIncomingItems(arrange(listing.entries, listing.layout, cols, rows).items);
    }).catch(() => {
      if (!cancel) setIncomingItems([]);
    });
    return () => {
      cancel = true;
    };
  }, [dragTarget, workspace, cols, rows]);

  useEffect(() => {
    const paste = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "v") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea")) return;
      const current = surface.current;
      if (!current.workspace || overviewRef.current) return;
      event.preventDefault();
      void clipboardFiles()
        .then(async (paths) => {
          if (paths.length === 0) return;
          await importPaths(current.workspace, current.folders, paths, dropModeRef.current);
          boardCache.current.delete(storageKey(current.workspace, current.folders));
          await loadBoard(current.workspace, current.folders, measureRows());
        })
        .catch(showError);
    };
    window.addEventListener("keydown", paste);
    return () => window.removeEventListener("keydown", paste);
  }, [loadBoard, showError]);

  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => setStage({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!zoom || zoom.placed || overview) return;
    const node = frame.current?.querySelector("[data-zoom-target]");
    if (!(node instanceof HTMLElement)) return;
    const to = node.getBoundingClientRect();
    if (to.width < 8) return;
    const scale = zoom.from.width / to.width;
    setZoom({
      ...zoom,
      x: zoom.from.left + zoom.from.width / 2 - (to.left + to.width / 2),
      y: zoom.from.top + zoom.from.height / 2 - (to.top + to.height / 2),
      scale,
      placed: true,
    });
  }, [zoom, overview, boardKey, items]);

  useEffect(() => {
    if (!zoom?.placed || zoom.live) return;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        setZoom((current) => (current ? { ...current, live: true } : current));
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [zoom]);

  useEffect(() => {
    if (!menu && !frequentMenu) return;
    const close = () => {
      setMenu(null);
      setFrequentMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu, frequentMenu]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeItem = useMemo(
    () => items.find((item) => item.name === activeName) ?? null,
    [activeName, items],
  );
  const footprint =
    activeItem && overCell
      ? { col: overCell.col, row: overCell.row, spanCol: activeItem.spanCol, spanRow: activeItem.spanRow }
      : null;

  const onGridChange = useCallback((grid: { cols: number; rows: number; cell: number }) => {
    setCols((current) => (current === grid.cols ? current : grid.cols));
    setRows((current) => (current === grid.rows ? current : grid.rows));
  }, []);

  const onFolderGrid = useCallback((grid: { cols: number; rows: number; cell: number }) => {
    folderColsRef.current = grid.cols;
    setFolderGrid((current) =>
      current.cols === grid.cols && current.rows === grid.rows ? current : { cols: grid.cols, rows: grid.rows },
    );
  }, []);

  function measureRows() {
    const height = frame.current?.clientHeight ?? window.innerHeight;
    return Math.max(3, Math.floor((height - 180) / 136));
  }

  async function persist(next: GridItem[]) {
    const name = surface.current.workspace;
    const path = surface.current.folders;
    const key = storageKey(name, path);
    boardCache.current.set(key, next);
    setItems(next);
    setBoardKey(key);
    if (!name) return;
    await saveLayout(name, path, toLayout(next));
  }

  async function onDragEnd(event: DragEndEvent) {
    const active = event.active.data.current as DragData | undefined;
    const over = event.over?.data.current as DragData | undefined;
    setOverName(null);
    setOverCell(null);
    setGhost(null);
    setEdgeHint(false);
    const targetWorkspace = dragTargetRef.current;
    dragTargetRef.current = null;
    setDragTarget(null);
    setIncomingItems(null);
    edgeListen.current?.();
    edgeListen.current = null;
    if (groupTimer.current != null) window.clearTimeout(groupTimer.current);
    groupTimer.current = null;
    groupPending.current = null;
    const exported = handedOff.current;
    handedOff.current = false;
    if (suppressDrop.current) return;
    setActiveName(null);
    activeNameRef.current = null;
    window.setTimeout(() => {
      dragged.current = false;
    }, 80);
    if (exported || !active || active.type !== "item" || !workspace) return;
    if (targetWorkspace && targetWorkspace !== workspace) {
      const spot = over?.type === "cell" ? over : null;
      boardCache.current.delete(storageKey(workspace, folders));
      boardCache.current.delete(storageKey(targetWorkspace, []));
      await moveEntry(workspace, folders, active.name, targetWorkspace, []);
      const listing = await listDir(targetWorkspace, []);
      let next = arrange(listing.entries, listing.layout, cols, rows).items;
      if (spot) next = moveItem(next, active.name, spot.col, spot.row, cols, rows);
      await saveLayout(targetWorkspace, [], toLayout(next));
      boardCache.current.set(storageKey(targetWorkspace, []), next);
      const nextIndex = workspaces.indexOf(targetWorkspace);
      if (nextIndex >= 0) goTo(nextIndex);
      boardCache.current.delete(storageKey(workspace, folders));
      setItems(next);
      setBoardKey(storageKey(targetWorkspace, []));
      return;
    }
    if (folders.length > 0 && itemOutsidePanel(active.name)) {
      const parentPath = folders.slice(0, -1);
      suppressDrop.current = true;
      boardCache.current.delete(storageKey(workspace, parentPath));
      try {
        await moveEntry(workspace, folders, active.name, workspace, parentPath);
        setFolders(parentPath);
        const listed = await loadBoard(workspace, parentPath, measureRows());
        const spot = cellAt(lastPointer.current.x, lastPointer.current.y);
        if (listed && spot) {
          const next = parentPath.length > 0
            ? placePacked(listed, active.name, spot.col, spot.row, folderColsRef.current)
            : moveItem(listed, active.name, spot.col, spot.row, cols, rows);
          if (next !== listed) await persist(next);
        }
      } catch (error) {
        showError(error);
      } finally {
        suppressDrop.current = false;
      }
      return;
    }
    if (!over) return;
    const dragging = items.find((item) => item.name === active.name);
    try {
      if (over.type === "cell") {
        const host = items.find(
          (item) =>
            item.name !== active.name &&
            over.col >= item.col &&
            over.row >= item.row &&
            over.col < item.col + item.spanCol &&
            over.row < item.row + item.spanRow,
        );
        if (host && dragging && isApp(host) && dragging.kind === "file" && !dragging.note) {
          await openWith(host.path, dragging.path);
        } else if (host?.kind === "folder" && !dragging?.note) {
          await moveInto(workspace, folders, active.name, host.name);
          await loadBoard(workspace, folders, measureRows());
        } else if (dragging?.note && folders.length > 0) {
          boardCache.current.delete(storageKey(workspace, []));
          await moveEntry(workspace, folders, active.name, workspace, []);
          setFolders([]);
          await loadBoard(workspace, [], measureRows());
        } else if (folders.length > 0) {
          const next = placePacked(items, active.name, over.col, over.row, folderColsRef.current);
          await persist(next);
        } else {
          const next = moveItem(items, active.name, over.col, over.row, cols, rows);
          await persist(next);
        }
      } else if (over.type === "item" && over.name !== active.name) {
        const target = items.find((item) => item.name === over.name);
        if (target && dragging && isApp(target) && dragging.kind === "file" && !dragging.note) {
          await openWith(target.path, dragging.path);
        } else if (target?.kind === "folder" && !dragging?.note) {
          await moveInto(workspace, folders, active.name, over.name);
          await loadBoard(workspace, folders, measureRows());
        }
      } else if (over.type === "parent" && folders.length > 0) {
        const parentPath = folders.slice(0, -1);
        boardCache.current.delete(storageKey(workspace, parentPath));
        await moveEntry(workspace, folders, active.name, workspace, parentPath);
        await loadBoard(workspace, parentPath, measureRows());
        setFolders(parentPath);
      } else if (over.type === "workspace" && over.name !== workspace) {
        await moveEntry(workspace, folders, active.name, over.name, []);
        await loadBoard(workspace, folders, measureRows());
      }
    } catch (error) {
      showError(error);
    }
  }

  function onDragCancel() {
    setOverName(null);
    setOverCell(null);
    setGhost(null);
    setEdgeHint(false);
    dragTargetRef.current = null;
    setDragTarget(null);
    setIncomingItems(null);
    edgeListen.current?.();
    edgeListen.current = null;
    handedOff.current = false;
    groupPending.current = null;
    if (groupTimer.current != null) window.clearTimeout(groupTimer.current);
    groupTimer.current = null;
    if (suppressDrop.current || opening.current) return;
    setActiveName(null);
    activeNameRef.current = null;
    window.setTimeout(() => {
      dragged.current = false;
    }, 80);
  }

  function onDragStart(event: DragStartEvent) {
    const data = event.active.data.current as DragData | undefined;
    if (data?.type === "item") {
      dragged.current = true;
      setActiveName(data.name);
      activeNameRef.current = data.name;
      setGhost(snapshotItem(data.name));
      handedOff.current = false;
      groupPending.current = null;
      if (event.activatorEvent instanceof MouseEvent) {
        lastPointer.current = { x: event.activatorEvent.clientX, y: event.activatorEvent.clientY };
      }
      edgeListen.current?.();
      const track = (ev: PointerEvent) => {
        lastPointer.current = { x: ev.clientX, y: ev.clientY };
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const workspaceHit = under instanceof Element ? under.closest("[data-workspace-name]") : null;
        const nextTarget = workspaceHit?.getAttribute("data-workspace-name") ?? null;
        if (nextTarget) {
          if (nextTarget !== dragTargetRef.current) {
            dragTargetRef.current = nextTarget;
            setDragTarget(nextTarget);
          }
          if (nextTarget !== surface.current.workspace) armOpen(null);
        } else if (
          !(under instanceof Element && under.closest("[data-incoming], [data-workspace-bar]")) &&
          dragTargetRef.current
        ) {
          dragTargetRef.current = null;
          setDragTarget(null);
        }
        if (handedOff.current || !inTauri() || opening.current) return;
        if (ev.clientY < 72 || (under instanceof Element && under.closest("[data-workspace-bar]"))) {
          setEdgeHint(false);
          return;
        }
        const dragging = itemsRef.current.find((item) => item.name === data.name);
        if (!dragging || dragging.note) return;
        const atEdge =
          ev.clientX < 24 ||
          ev.clientY < 24 ||
          ev.clientX > window.innerWidth - 24 ||
          ev.clientY > window.innerHeight - 24;
        setEdgeHint((current) => (current === atEdge ? current : atEdge));
        if (!atEdge) return;
        handedOff.current = true;
        setEdgeHint(false);
        setActiveName(null);
        activeNameRef.current = null;
        void dragFileOut(dragging.path).catch(showError);
      };
      window.addEventListener("pointermove", track);
      edgeListen.current = () => window.removeEventListener("pointermove", track);
    }
  }

  function armOpen(name: string | null) {
    const dragging = itemsRef.current.find((item) => item.name === activeNameRef.current);
    if (dragging?.note) name = null;
    if (name) {
      const host = itemsRef.current.find((item) => item.name === name);
      if (!host || host.note || (carryRef.current && host.kind !== "folder")) name = null;
    }
    if (opening.current || name === groupPending.current) return;
    if (groupTimer.current != null) window.clearTimeout(groupTimer.current);
    groupTimer.current = null;
    groupPending.current = name;
    if (!name) return;
    groupTimer.current = window.setTimeout(() => {
      if (groupPending.current !== name) return;
      void diveInto(name);
    }, 600);
  }

  function watchLeave() {
    if (opening.current || surface.current.folders.length === 0) {
      if (leaveTimer.current != null) window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
      return;
    }
    const panel = document.querySelector("[data-folder-panel]");
    if (!(panel instanceof HTMLElement)) return;
    const box = panel.getBoundingClientRect();
    const outside =
      lastPointer.current.x < box.left ||
      lastPointer.current.x > box.right ||
      lastPointer.current.y < box.top ||
      lastPointer.current.y > box.bottom;
    if (!outside) {
      seenInside.current = true;
      if (leaveTimer.current != null) window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
      return;
    }
    if (!seenInside.current) return;
    if (leaveTimer.current != null) return;
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      void liftOut();
    }, 450);
  }

  function rememberCarry(source: string[]) {
    const name = activeNameRef.current;
    const shot = name ? snapshotItem(name) : null;
    const ghostRect = document.querySelector("[data-drag-ghost]")?.getBoundingClientRect();
    const width = shot?.width ?? ghostRect?.width ?? 96;
    const height = shot?.height ?? ghostRect?.height ?? 96;
    const left = ghostRect?.left ?? lastPointer.current.x - width / 2;
    const top = ghostRect?.top ?? lastPointer.current.y - height / 2;
    if (!name || !shot) return null;
    return {
      name,
      source,
      offsetX: lastPointer.current.x - left,
      offsetY: lastPointer.current.y - top,
      x: left,
      y: top,
      width,
      height,
      node: shot.node,
    } satisfies Carry;
  }

  function hostAt(x: number, y: number) {
    const spot = cellAt(x, y);
    if (!spot) return null;
    const name = activeNameRef.current;
    const host = itemsRef.current.find(
      (item) =>
        item.name !== name &&
        spot.col >= item.col &&
        spot.row >= item.row &&
        spot.col < item.col + item.spanCol &&
        spot.row < item.row + item.spanRow,
    );
    const dragging = itemsRef.current.find((item) => item.name === name);
    if (dragging?.note || host?.note) return null;
    return host && !isApp(host) ? host.name : null;
  }

  function startCarry(session: Carry) {
    carryListen.current?.();
    carryRef.current = session;
    setCarry(session);
    activeNameRef.current = session.name;
    dragged.current = true;
    const move = (event: PointerEvent) => {
      lastPointer.current = { x: event.clientX, y: event.clientY };
      const left = event.clientX - session.offsetX;
      const top = event.clientY - session.offsetY;
      setCarry((current) => (current ? { ...current, x: left, y: top } : current));
      watchLeave();
      const host = hostAt(left + 8, top + 8);
      armOpen(host);
    };
    const up = (event: PointerEvent) => {
      stop();
      void finishCarry(event.clientX, event.clientY);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up, true);
      carryListen.current = null;
    };
    carryListen.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, true);
  }

  async function diveInto(targetName: string) {
    if (opening.current || !workspace) return;
    const name = activeNameRef.current;
    const host = itemsRef.current.find((item) => item.name === targetName);
    const dragging = itemsRef.current.find((item) => item.name === name);
    if (!name || !host || host.name === name || isApp(host) || host.note || dragging?.note) return;
    opening.current = true;
    suppressDrop.current = true;
    seenInside.current = false;
    carryListen.current?.();
    carryListen.current = null;
    if (groupTimer.current != null) window.clearTimeout(groupTimer.current);
    groupTimer.current = null;
    const source = [...surface.current.folders];
    const pointerUp: { event: PointerEvent | null } = { event: null };
    const onUp = (event: PointerEvent) => {
      pointerUp.event = event;
    };
    window.addEventListener("pointerup", onUp, true);
    try {
      const session = rememberCarry(source);
      let nextPath = source;
      if (host.kind === "folder") {
        await moveInto(workspace, source, name, host.name);
        nextPath = [...source, host.name];
      } else {
        const groupName = await groupItems(workspace, source, [host.name, name]);
        nextPath = [...source, groupName];
      }
      if (session) {
        session.source = nextPath;
        carryRef.current = session;
        setCarry(session);
      }
      boardCache.current.delete(storageKey(workspace, source));
      boardCache.current.delete(storageKey(workspace, nextPath));
      setFolders(nextPath);
      await loadBoard(workspace, nextPath, measureRows());
      if (!session) {
        suppressDrop.current = false;
        setActiveName(null);
        activeNameRef.current = null;
        return;
      }
      if (pointerUp.event) await finishCarry(pointerUp.event.clientX, pointerUp.event.clientY, session);
      else startCarry(session);
    } catch (error) {
      showError(error);
      suppressDrop.current = false;
      setActiveName(null);
      activeNameRef.current = null;
    } finally {
      window.removeEventListener("pointerup", onUp, true);
      opening.current = false;
    }
  }

  async function liftOut() {
    if (opening.current || !workspace || surface.current.folders.length === 0) return;
    const name = activeNameRef.current;
    if (!name) return;
    opening.current = true;
    suppressDrop.current = true;
    seenInside.current = false;
    carryListen.current?.();
    carryListen.current = null;
    const source = [...surface.current.folders];
    const parent = source.slice(0, -1);
    const pointerUp: { event: PointerEvent | null } = { event: null };
    const onUp = (event: PointerEvent) => {
      pointerUp.event = event;
    };
    window.addEventListener("pointerup", onUp, true);
    try {
      const session = rememberCarry(parent);
      if (session) {
        carryRef.current = session;
        setCarry(session);
      }
      await moveEntry(workspace, source, name, workspace, parent);
      boardCache.current.delete(storageKey(workspace, source));
      boardCache.current.delete(storageKey(workspace, parent));
      setFolders(parent);
      await loadBoard(workspace, parent, measureRows());
      if (!session) {
        suppressDrop.current = false;
        setActiveName(null);
        activeNameRef.current = null;
        return;
      }
      if (pointerUp.event) await finishCarry(pointerUp.event.clientX, pointerUp.event.clientY, session);
      else startCarry(session);
    } catch (error) {
      showError(error);
      suppressDrop.current = false;
      setActiveName(null);
      activeNameRef.current = null;
    } finally {
      window.removeEventListener("pointerup", onUp, true);
      opening.current = false;
    }
  }

  async function finishCarry(clientX: number, clientY: number, session = carryRef.current) {
    if (!session || !workspace) return;
    carryListen.current?.();
    carryRef.current = null;
    setCarry(null);
    setActiveName(null);
    window.setTimeout(() => {
      dragged.current = false;
    }, 80);
    const left = clientX - session.offsetX;
    const top = clientY - session.offsetY;
    const destination = [...surface.current.folders];
    try {
      if (session.source.join("/") !== destination.join("/")) {
        await moveEntry(workspace, session.source, session.name, workspace, destination);
        boardCache.current.delete(storageKey(workspace, session.source));
        boardCache.current.delete(storageKey(workspace, destination));
      }
      const listed = (await loadBoard(workspace, destination, measureRows())) ?? itemsRef.current;
      const spot = cellAt(left + 8, top + 8) ?? cellAt(clientX, clientY);
      if (!listed.some((item) => item.name === session.name) || !spot) return;
      const next = destination.length > 0
        ? placePacked(listed, session.name, spot.col, spot.row, folderColsRef.current)
        : moveItem(listed, session.name, spot.col, spot.row, colsRef.current, rowsRef.current);
      if (next !== listed) await persist(next);
    } catch (error) {
      showError(error);
    } finally {
      suppressDrop.current = false;
    }
  }

  function onDragMove(event: DragMoveEvent) {
    const source = event.activatorEvent;
    if (source instanceof MouseEvent) {
      lastPointer.current = { x: source.clientX + event.delta.x, y: source.clientY + event.delta.y };
    }
    watchLeave();
  }

  function beginExport(event: { button: number; clientX: number; clientY: number }, path: string) {
    if (!inTauri() || event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (ev: PointerEvent) => {
      if (editingRef.current) return;
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 12) return;
      stop();
      dragged.current = true;
      handedOff.current = true;
      void dragFileOut(path)
        .catch(showError)
        .finally(() => {
          window.setTimeout(() => {
            dragged.current = false;
            handedOff.current = false;
          }, 120);
        });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    const up = () => stop();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onDragOver(event: DragOverEvent) {
    const over = event.over?.data.current as DragData | undefined;
    const active = event.active.data.current as DragData | undefined;
    const targetWorkspace = dragTargetRef.current;
    if (targetWorkspace && targetWorkspace !== surface.current.workspace) {
      setOverCell(null);
      armOpen(null);
      return;
    }
    const dragging = active?.type === "item" ? items.find((item) => item.name === active.name) : undefined;
    if (over?.type === "cell" && dragging && over.col + dragging.spanCol <= cols && over.row + dragging.spanRow <= rows) {
      setOverCell({ col: over.col, row: over.row });
      const host = items.find(
        (item) =>
          item.name !== dragging.name &&
          over.col >= item.col &&
          over.row >= item.row &&
          over.col < item.col + item.spanCol &&
          over.row < item.row + item.spanRow,
      );
      armOpen(host && !isApp(host) ? host.name : null);
    } else {
      setOverCell(null);
      const target = over?.type === "item" ? items.find((item) => item.name === over.name) : undefined;
      armOpen(target && !isApp(target) ? target.name : null);
    }
  }

  function remember(item: GridItem) {
    const next = bumpFrequent(readFrequent(), {
      path: item.path,
      name: item.name,
      kind: item.kind,
      workspace,
      count: 1,
    });
    localStorage.setItem(FREQUENT_KEY, JSON.stringify(next));
    setFrequent(next);
  }

  function openItem(item: GridItem) {
    if (dragged.current) return;
    if (item.kind === "folder") {
      setFolders([item.name]);
      return;
    }
    remember(item);
    void openPath(item.path).catch(showError);
  }

  function showOverview() {
    setBatchEdit(false);
    setFolders([]);
    setQuery("");
    setMenu(null);
    setOverview(true);
  }

  async function refreshBoard() {
    if (!workspace) return;
    boardCache.current.delete(storageKey(workspace, folders));
    await loadBoard(workspace, folders, measureRows());
  }

  async function chooseBackground() {
    if (!workspace) return;
    if (!inTauri()) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/webp,image/bmp,image/gif";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const url = String(reader.result ?? "");
          void saveWorkspaceBackground(workspace, url)
            .then((saved) => setBackgrounds((current) => ({ ...current, [workspace]: saved })))
            .catch(showError);
        };
        reader.readAsDataURL(file);
      };
      input.click();
      return;
    }
    const picked = await open({
      multiple: false,
      directory: false,
      title: "设置背景",
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
    });
    if (!picked || Array.isArray(picked)) return;
    const saved = await saveWorkspaceBackground(workspace, picked);
    setBackgrounds((current) => ({ ...current, [workspace]: saved }));
  }

  async function resetBackground() {
    if (!workspace) return;
    await clearWorkspaceBackground(workspace);
    setBackgrounds((current) => {
      const next = { ...current };
      delete next[workspace];
      return next;
    });
  }

  function enterWorkspace(workspaceIndex: number, preview: HTMLElement) {
    const from = preview.getBoundingClientRect();
    setZoom({
      name: workspaces[workspaceIndex] ?? "",
      from,
      x: 0,
      y: 0,
      scale: 1,
      placed: false,
      live: false,
    });
    setOverview(false);
    goTo(workspaceIndex);
  }

  async function addPicked(directory: boolean) {
    if (!workspace) return;
    if (!inTauri()) {
      showError(new Error("请在桌面版里放入文件。"));
      return;
    }
    const picked = await open({
      multiple: true,
      directory,
      title: directory ? "放入文件夹" : "放入文件",
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    await importPaths(workspace, folders, paths, config?.dropMode ?? "move");
    await loadBoard(workspace, folders, measureRows());
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={alignByTopLeft}
      modifiers={[snapTopLeft]}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragOver={onDragOver}
      onDragCancel={onDragCancel}
      onDragEnd={(event) => void onDragEnd(event)}
    >
      <main
        className="relative flex h-full flex-col overflow-hidden bg-transparent"
      onContextMenu={(event) => {
        event.preventDefault();
        if (overview) return;
        const target = event.target as HTMLElement;
        const host = target.closest("[data-item]");
        const name = host instanceof HTMLElement ? host.dataset.name ?? null : null;
        const picked = name ? items.find((entry) => entry.name === name) : undefined;
        if (picked && inTauri()) {
          void showShellMenu(picked.path, event.shiftKey)
            .then(() => refreshBoard())
            .catch(showError);
          return;
        }
        const width = 196;
        const height = picked ? 320 : 280;
        setMenu({
          x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
          y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
          item: name,
        });
      }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            if (menu || frequentMenu) {
              setMenu(null);
              setFrequentMenu(null);
            }
            else if (query) setQuery("");
            else if (overview) setOverview(false);
            else if (folders.length) setFolders((current) => current.slice(0, -1));
            else setBatchEdit(false);
          }
          if (event.key === "ArrowRight" && !overview && !editing && folders.length === 0) {
            goTo(Math.min(workspaces.length - 1, index + 1));
          }
          if (event.key === "ArrowLeft" && !overview && !editing && folders.length === 0) {
            goTo(Math.max(0, index - 1));
          }
        }}
        tabIndex={0}
      >
        {externalDrag && workspace && (
          <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center bg-black/45">
            <div className="rounded-[28px] bg-[#1c1c1c]/90 px-8 py-5 text-lg text-[#f4f1ea] shadow-[0_16px_40px_rgba(0,0,0,0.35)]">
              松开放入「{folders.length > 0 ? folders[folders.length - 1] : workspace}」
            </div>
          </div>
        )}
        {edgeHint && (
          <div className="pointer-events-none absolute bottom-28 left-1/2 z-30 -translate-x-1/2 rounded-full bg-black/60 px-4 py-2 text-sm text-white">
            拖到屏幕边缘，即可放到其他窗口
          </div>
        )}
        <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-6 pt-5 pb-2">
          {activeName ? (
            <WorkspaceRail names={workspaces} current={dragTarget ?? workspace} />
          ) : (
            <label className="pointer-events-auto flex h-11 w-[min(440px,72vw)] items-center gap-3 rounded-full bg-black/40 px-4 text-white/70">
              <SearchIcon />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="输入以搜索"
                className="w-full bg-transparent text-[15px] text-white outline-none placeholder:text-white/45"
              />
            </label>
          )}
        </header>
        {activeName && dragTarget && dragTarget !== workspace && incomingItems && (
          <div
            data-incoming
            className="absolute inset-0 z-10 px-8 pt-20 pb-24"
            style={{ background: `#1a1916 url("${wallpaperOf(dragTarget)}") center / cover no-repeat` }}
          >
            <Board
              items={incomingItems}
              cols={cols}
              rows={rows}
              editing
              icons={icons}
              folderKids={{}}
              activeName={null}
              overName={null}
              footprint={null}
              idPrefix="incoming:"
              onOpen={() => {}}
              onRemove={() => {}}
              onNote={() => {}}
              onResize={() => {}}
            />
          </div>
        )}

        <div
          ref={frame}
          className="absolute inset-0 overflow-hidden"
          onPointerDown={(event) => {
            const target = event.target as HTMLElement;
            if (
              overview ||
              editing ||
              folders.length ||
              target.closest("button, a, input, textarea, label, [data-item]")
            ) {
              return;
            }
            const startX = event.clientX;
            const pointerId = event.pointerId;
            let moved = false;
            const timer = window.setTimeout(() => {
              if (!moved) setBatchEdit(true);
            }, 280);
            const move = (ev: PointerEvent) => {
              const dx = ev.clientX - startX;
              if (Math.abs(dx) > 8) {
                moved = true;
                window.clearTimeout(timer);
                setPaging(true);
                setDragX(dx);
              }
            };
            const up = (ev: PointerEvent) => {
              window.clearTimeout(timer);
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
              frame.current?.releasePointerCapture?.(pointerId);
              const width = frame.current?.clientWidth ?? 1;
              const dx = ev.clientX - startX;
              if (Math.abs(dx) > width * 0.18) {
                goTo(clamp(index + (dx < 0 ? 1 : -1), 0, workspaces.length - 1));
              }
              setPaging(false);
              setDragX(0);
            };
            frame.current?.setPointerCapture?.(pointerId);
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        >
          {workspaces.length === 0 ? (
            <Empty
              onCreate={() =>
                setPrompt({
                  title: "新建工作区",
                  value: "",
                  onSubmit: (value) => {
                    void createWorkspace(value).then(() => reload()).catch(showError);
                  },
                })
              }
            />
          ) : (
            <div
              className="h-full"
              style={{
                filter: overview ? "blur(42px)" : undefined,
                transform: overview ? "scale(1.08)" : undefined,
                transition: "filter 280ms ease, transform 280ms ease",
                pointerEvents: overview ? "none" : undefined,
              }}
            >
            <div
              className="flex h-full"
              style={{
                width: `${Math.max(workspaces.length, 1) * 100}%`,
                transform: `translateX(calc(${-index * (100 / Math.max(workspaces.length, 1))}% + ${dragX}px))`,
                transition: paging ? "none" : "transform 280ms cubic-bezier(.2,.8,.2,1)",
              }}
            >
              {workspaces.map((name) => (
                <section
                  key={name}
                  className="scroll-hidden relative h-full overflow-y-auto"
                  style={{
                    width: `${100 / Math.max(workspaces.length, 1)}%`,
                    background: `#1a1916 url("${wallpaperOf(name)}") center / cover no-repeat`,
                    ...(zoom?.placed && zoom.name === name
                      ? {
                          transform: zoom.live ? "none" : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
                          transition: "transform 460ms cubic-bezier(.16,1,.3,1)",
                        }
                      : {}),
                  }}
                  data-zoom-target={name === workspace ? "" : undefined}
                  onTransitionEnd={(event) => {
                    if (event.propertyName === "transform" && zoom?.live && zoom.name === name) setZoom(null);
                  }}
                >
                  {name === workspace && folders.length === 0 && boardKey === storageKey(workspace, []) ? (
                    needle ? (
                      <SearchResults
                        items={items.filter((item) => item.name.toLowerCase().includes(needle))}
                        icons={icons}
                        onOpen={openItem}
                        onExport={(item, event) => beginExport(event, item.path)}
                      />
                    ) : (
                    <div className="h-full px-8 pt-20 pb-24">
                    <Board
                      items={items}
                      cols={cols}
                      rows={rows}
                      onGridChange={onGridChange}
                      editing={editing && folders.length === 0}
                      icons={icons}
                      folderKids={folderKids}
                      activeName={activeName ?? carry?.name ?? null}
                      overName={overName}
                      footprint={footprint}
                      onOpen={openItem}
                      onRemove={(item) =>
                        setConfirm({
                          text: `删除「${item.name}」？文件会从磁盘移除。`,
                          onYes: () => {
                            void deleteEntry(workspace, [], item.name)
                              .then(() => loadBoard(workspace, [], measureRows()))
                              .catch(showError);
                          },
                        })
                      }
                      onNote={(item, content) => {
                        void writeNote(workspace, [], item.name, content).catch(showError);
                      }}
                      onResize={(name, spanCol, spanRow) => {
                        const next = resizeItem(items, name, spanCol, spanRow, cols, rows);
                        if (next !== items) void persist(next);
                      }}
                    />
                    </div>
                    )
                  ) : (
                    <div className="grid h-full place-items-center text-3xl text-white/35">{name}</div>
                  )}
                </section>
              ))}
            </div>
            </div>
          )}
          {overview && (
            <WorkspaceOverview
              names={workspaces}
              activeIndex={index}
              stage={stage}
              wallpaperFor={wallpaperOf}
              itemsFor={(name) => (name === workspace ? items : (previews[name] ?? []))}
              cols={cols}
              rows={rows}
              icons={icons}
              folderKids={folderKids}
              onOpen={enterWorkspace}
              onCreate={() =>
                setPrompt({
                  title: "新建工作区",
                  value: "",
                  onSubmit: (value) => {
                    void createWorkspace(value)
                      .then(async (name) => {
                        await reload();
                        const names = await listWorkspaces();
                        const next = Math.max(0, names.indexOf(name));
                        setOverview(false);
                        goTo(next);
                      })
                      .catch(showError);
                  },
                })
              }
            />
          )}
          {editing && workspace && (
          <div className="absolute bottom-24 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/50 px-3 py-2 backdrop-blur">
            <DockButton onClick={() => void addPicked(false).catch(showError)}>放入文件</DockButton>
            <DockButton onClick={() => void addPicked(true).catch(showError)}>放入文件夹</DockButton>
            <DockButton
              onClick={() =>
                void createNote(workspace, [])
                  .then(() => {
                    setFolders([]);
                    return loadBoard(workspace, [], measureRows());
                  })
                  .catch(showError)
              }
            >
              新建便签
            </DockButton>
            <DockButton
              onClick={() =>
                setConfirm({
                  text: `删除工作区「${workspace}」？对应文件夹会一起删除。`,
                  onYes: () => {
                    void deleteWorkspace(workspace)
                      .then(async () => {
                        setFolders([]);
                        setBatchEdit(false);
                        await reload();
                      })
                      .catch(showError);
                  },
                })
              }
            >
              删除工作区
            </DockButton>
            <DockButton onClick={() => setBatchEdit(false)}>完成</DockButton>
          </div>
        )}
        </div>

        {!overview && workspaces.length > 1 && (
          <div className="absolute inset-x-0 bottom-20 z-20 flex justify-center gap-2">
            {workspaces.map((name, workspaceIndex) => (
              <button
                key={name}
                type="button"
                aria-label={name}
                className={`h-2 w-2 rounded-full ${workspaceIndex === index ? "bg-white" : "bg-white/35"}`}
                onClick={() => goTo(workspaceIndex)}
              />
            ))}
          </div>
        )}

        <footer className="absolute inset-x-0 bottom-0 z-20 flex justify-center px-6 pt-1 pb-4">
          <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-full bg-black/45 px-3 py-2 shadow-lg">
            {frequent.map((item) => (
              <button
                key={item.path}
                type="button"
                title={item.name}
                className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl hover:bg-white/10"
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const width = 168;
                  const height = 44;
                  setMenu(null);
                  setFrequentMenu({
                    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
                    y: Math.max(8, event.clientY - height - 6),
                    path: item.path,
                  });
                }}
                onPointerDown={(event) => beginExport(event, item.path)}
                onClick={() => {
                  if (dragged.current) return;
                  const workspaceIndex = workspaces.indexOf(item.workspace);
                  if (workspaceIndex >= 0) goTo(workspaceIndex);
                  if (item.kind === "folder") {
                    setFolders([item.name]);
                    return;
                  }
                  remember({ ...item, content: "", col: 0, row: 0, spanCol: 1, spanRow: 1, note: false });
                  void openPath(item.path).catch(showError);
                }}
              >
                {icons[item.path] ? (
                  <img
                    src={icons[item.path]}
                    alt=""
                    className="object-contain"
                    style={{ width: snapIconSize(40), height: snapIconSize(40) }}
                    draggable={false}
                  />
                ) : (
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#d7b15a] text-sm text-[#1c1a16]">
                    {item.kind === "folder" ? "夹" : "档"}
                  </span>
                )}
              </button>
            ))}
            <span className="mx-1 h-8 w-px shrink-0 bg-white/25" />
            <button
              type="button"
              title="工作区"
              aria-label="工作区"
              aria-pressed={overview}
              className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${overview ? "bg-white/20" : "hover:bg-white/10"}`}
              onClick={() => (overview ? setOverview(false) : showOverview())}
            >
              <span className="grid grid-cols-3 gap-1">
                {Array.from({ length: 9 }, (_, dot) => (
                  <span key={dot} className="h-1.5 w-1.5 rounded-full bg-white" />
                ))}
              </span>
            </button>
          </div>
        </footer>

        {folders.length > 0 && workspace && (
          <FolderLayer
            onClose={() => {
              if (dragged.current) return;
              setFolders([]);
            }}
          >
            <div className="scroll-hidden min-h-0 flex-1 overflow-auto">
                {boardKey === storageKey(workspace, folders) ? (
                <Board
                  items={items}
                  cols={folderGrid.cols}
                  rows={folderGrid.rows}
                  onGridChange={onFolderGrid}
                  editing={editing}
                  icons={icons}
                  folderKids={folderKids}
                  activeName={activeName ?? carry?.name ?? null}
                  overName={overName}
                  footprint={footprint}
                  onOpen={(item) => {
                    if (dragged.current) return;
                    if (item.kind === "folder") setFolders((current) => [...current, item.name]);
                    else {
                      remember(item);
                      void openPath(item.path).catch(showError);
                    }
                  }}
                  onRemove={(item) =>
                    setConfirm({
                      text: `删除「${item.name}」？文件会从磁盘移除。`,
                      onYes: () => {
                        void deleteEntry(workspace, folders, item.name)
                          .then(() => loadBoard(workspace, folders, measureRows()))
                          .catch(showError);
                      },
                    })
                  }
                  onNote={(item, content) => {
                    void writeNote(workspace, folders, item.name, content).catch(showError);
                  }}
                  onResize={(name, spanCol, spanRow) => {
                    const next = resizeItem(items, name, spanCol, spanRow, folderGrid.cols, folderGrid.rows);
                    if (next !== items) void persist(next);
                  }}
                />
                ) : null}
            </div>
          </FolderLayer>
        )}

        {frequentMenu && (
          <div
            className="absolute z-50 w-40 overflow-hidden rounded-2xl border border-white/15 bg-[#1c1c1c]/90 py-1 text-sm text-[#f4f1ea] shadow-[0_16px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl"
            style={{ left: frequentMenu.x, top: frequentMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <MenuItem
              label="从常用中移除"
              onClick={() => {
                const next = frequent.filter((entry) => entry.path !== frequentMenu.path);
                localStorage.setItem(FREQUENT_KEY, JSON.stringify(next));
                setFrequent(next);
                setFrequentMenu(null);
              }}
            />
          </div>
        )}

        {menu && (
          <div
            className="absolute z-50 w-48 overflow-hidden rounded-2xl border border-white/15 bg-[#1c1c1c]/90 py-1 text-sm text-[#f4f1ea] shadow-[0_16px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl"
            style={{ left: menu.x, top: menu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {menu.item && (
              <MenuItem
                label="打开"
                onClick={() => {
                  const item = items.find((entry) => entry.name === menu.item);
                  setMenu(null);
                  if (item) openItem(item);
                }}
              />
            )}
            <MenuItem
              label="放入文件"
              onClick={() => {
                setMenu(null);
                void addPicked(false).catch(showError);
              }}
            />
            <MenuItem
              label="放入文件夹"
              onClick={() => {
                setMenu(null);
                void addPicked(true).catch(showError);
              }}
            />
            <MenuItem
              label="刷新"
              onClick={() => {
                setMenu(null);
                void refreshBoard().catch(showError);
              }}
            />
            <MenuItem
              label={batchEdit ? "完成编辑" : "编辑布局"}
              onClick={() => {
                setBatchEdit((current) => !current);
                setMenu(null);
              }}
            />
            <MenuItem
              label="设置背景"
              onClick={() => {
                setMenu(null);
                void chooseBackground().catch(showError);
              }}
            />
            <MenuItem
              label="恢复默认背景"
              disabled={!backgrounds[workspace]}
              onClick={() => {
                setMenu(null);
                void resetBackground().catch(showError);
              }}
            />
            <MenuItem
              label="设置"
              onClick={() => {
                setMenu(null);
                setSettingsOpen(true);
              }}
            />
          </div>
        )}
        {settingsOpen && config && (
          <Settings
            config={config}
            onClose={() => setSettingsOpen(false)}
            onSave={async (next) => {
              const saved = await setConfig(next);
              setConfigState(saved);
              await reload();
              setSettingsOpen(false);
            }}
            onError={showError}
          />
        )}

        {prompt && (
          <PromptDialog
            title={prompt.title}
            value={prompt.value}
            onCancel={() => setPrompt(null)}
            onSubmit={(value) => {
              prompt.onSubmit(value);
              setPrompt(null);
            }}
          />
        )}
        {confirm && (
          <ConfirmDialog
            text={confirm.text}
            onNo={() => setConfirm(null)}
            onYes={() => {
              confirm.onYes();
              setConfirm(null);
            }}
          />
        )}
        {toast && (
          <div className="absolute bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[#3a2a28] px-4 py-2 text-sm text-[#f6d7d2]">
            {toast}
          </div>
        )}
      </main>
      <DragOverlay className="pointer-events-none" style={ghost ? { width: ghost.width, height: ghost.height } : undefined}>
        {ghost ? <DragGhost node={ghost.node} /> : null}
      </DragOverlay>
      {carry && (
        <div
          className="pointer-events-none fixed z-[70]"
          style={{ left: carry.x, top: carry.y, width: carry.width, height: carry.height }}
        >
          <DragGhost node={carry.node} />
        </div>
      )}
    </DndContext>
  );
}

function FolderLayer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: "parent-workspace", data: { type: "parent" } });
  return (
    <div
      ref={setNodeRef}
      data-parent
      className="absolute inset-0 z-30 flex items-center justify-center p-16"
      onClick={onClose}
    >
      <div
        data-folder-panel
        className="flex h-[68%] w-[min(720px,86%)] flex-col rounded-[28px] border border-white/20 bg-white/8 p-6 shadow-[0_8px_40px_rgba(0,0,0,0.08)] backdrop-blur-sm"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function snapshotItem(name: string) {
  const source = document.querySelector(`[data-item][data-name="${CSS.escape(name)}"]`);
  if (!(source instanceof HTMLElement)) return null;
  const clone = source.cloneNode(true) as HTMLElement;
  const fields = source.querySelectorAll("textarea, input");
  const copies = clone.querySelectorAll("textarea, input");
  fields.forEach((field, index) => {
    const copy = copies[index];
    if ((copy instanceof HTMLTextAreaElement || copy instanceof HTMLInputElement) && "value" in field) {
      copy.value = (field as HTMLTextAreaElement).value;
    }
  });
  clone.classList.remove("wiggle");
  clone.style.opacity = "1";
  clone.style.transform = "none";
  clone.style.width = "100%";
  clone.style.height = "100%";
  clone.style.gridColumn = "auto";
  clone.style.gridRow = "auto";
  return { node: clone, width: source.offsetWidth, height: source.offsetHeight };
}

function DragGhost({ node }: { node: HTMLElement }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    host.current?.replaceChildren(node);
  }, [node]);
  return <div ref={host} data-drag-ghost className="pointer-events-none h-full w-full" />;
}

const FREQUENT_KEY = "workspace-frequent";

type FrequentItem = {
  path: string;
  name: string;
  kind: "file" | "folder";
  workspace: string;
  count: number;
};

function readFrequent(): FrequentItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FREQUENT_KEY) ?? "[]") as FrequentItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function bumpFrequent(list: FrequentItem[], item: FrequentItem) {
  const next = list.map((entry) => ({ ...entry }));
  const found = next.find((entry) => entry.path === item.path);
  if (found) found.count += 1;
  else next.push(item);
  next.sort((a, b) => b.count - a.count);
  return next.slice(0, 12);
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 fill-white/70">
      <path d="M11.4 10.2a5.2 5.2 0 1 0-1.2 1.2l2.7 2.7a.85.85 0 0 0 1.2-1.2l-2.7-2.7ZM7 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z" />
    </svg>
  );
}

function SearchResults({
  items,
  icons,
  onOpen,
  onExport,
}: {
  items: GridItem[];
  icons: Record<string, string>;
  onOpen: (item: GridItem) => void;
  onExport: (item: GridItem, event: { button: number; clientX: number; clientY: number }) => void;
}) {
  if (items.length === 0) {
    return <div className="grid h-full place-items-center text-white/45">没有匹配的内容</div>;
  }
  return (
    <div className="mx-auto flex max-w-[1080px] flex-wrap justify-center gap-x-8 gap-y-6 pt-4">
      {items.map((item) => (
        <button
          key={item.name}
          type="button"
          data-item
          className="flex w-24 flex-col items-center gap-2"
          onPointerDown={(event) => onExport(item, event)}
          onClick={() => onOpen(item)}
        >
          {icons[item.path] ? (
            <img
              src={icons[item.path]}
              alt=""
              className="object-contain"
              style={{ width: snapIconSize(64), height: snapIconSize(64) }}
              draggable={false}
            />
          ) : (
            <span className="grid h-16 w-16 place-items-center rounded-2xl bg-[#d7b15a] text-lg text-[#1c1a16]">
              {item.kind === "folder" ? "夹" : "档"}
            </span>
          )}
          <span className="desktop-label line-clamp-2 w-full text-center text-xs">{item.name}</span>
        </button>
      ))}
    </div>
  );
}

function WorkspaceOverview({
  names,
  activeIndex,
  stage,
  wallpaperFor,
  itemsFor,
  cols,
  rows,
  icons,
  folderKids,
  onOpen,
  onCreate,
}: {
  names: string[];
  activeIndex: number;
  stage: { width: number; height: number };
  wallpaperFor: (name: string) => string;
  itemsFor: (name: string) => GridItem[];
  cols: number;
  rows: number;
  icons: Record<string, string>;
  folderKids: Record<string, FolderChild[]>;
  onOpen: (index: number, preview: HTMLElement) => void;
  onCreate: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const coast = useRef<number | null>(null);
  const cardWidth = Math.max(280, stage.width * 0.62);
  const cardHeight = Math.max(180, stage.height * 0.62);
  const scale = stage.width > 0 ? cardWidth / stage.width : 0.62;
  const gutter = Math.max(24, (stage.width - cardWidth) / 2);
  function stopCoast() {
    if (coast.current != null) cancelAnimationFrame(coast.current);
    coast.current = null;
  }
  function limitScroll(root: HTMLDivElement, next: number) {
    const max = Math.max(0, root.scrollWidth - root.clientWidth);
    return Math.min(max, Math.max(0, next));
  }
  useEffect(() => {
    const root = scroller.current;
    const current = root?.querySelector("[data-current='true']");
    if (!(root && current instanceof HTMLElement)) return;
    root.scrollLeft = current.offsetLeft - (root.clientWidth - current.offsetWidth) / 2;
  }, [activeIndex, names.length, cardWidth]);
  useEffect(() => () => stopCoast(), []);
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const slide = (event: WheelEvent) => {
      const unit = event.deltaMode === 1 ? 48 : event.deltaMode === 2 ? root.clientWidth : 1;
      const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit;
      if (delta === 0 || root.scrollWidth <= root.clientWidth) return;
      event.preventDefault();
      stopCoast();
      root.scrollLeft = limitScroll(root, root.scrollLeft + delta);
    };
    root.addEventListener("wheel", slide, { passive: false });
    return () => root.removeEventListener("wheel", slide);
  }, []);
  function onPanStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const root = scroller.current;
    if (!root || root.scrollWidth <= root.clientWidth) return;
    stopCoast();
    suppressClick.current = false;
    const startX = event.clientX;
    let lastX = event.clientX;
    let lastTime = performance.now();
    let velocity = 0;
    const move = (ev: PointerEvent) => {
      const now = performance.now();
      const dx = ev.clientX - lastX;
      const dt = Math.max(8, now - lastTime);
      if (Math.abs(ev.clientX - startX) > 6) suppressClick.current = true;
      if (suppressClick.current) {
        root.scrollLeft = limitScroll(root, root.scrollLeft - dx);
        velocity = velocity * 0.55 + (-dx / dt) * 0.45;
      }
      lastX = ev.clientX;
      lastTime = now;
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (performance.now() - lastTime > 60) velocity = 0;
      const max = Math.max(0, root.scrollWidth - root.clientWidth);
      let speed = velocity;
      let previous = performance.now();
      const step = (now: number) => {
        const dt = Math.min(34, now - previous);
        previous = now;
        speed *= Math.exp(-3.4 * dt / 1000);
        const next = root.scrollLeft + speed * dt;
        if (next <= 0 || next >= max) {
          root.scrollLeft = Math.min(max, Math.max(0, next));
          coast.current = null;
          return;
        }
        root.scrollLeft = next;
        if (Math.abs(speed) < 0.02) {
          coast.current = null;
          return;
        }
        coast.current = requestAnimationFrame(step);
      };
      if (suppressClick.current && Math.abs(speed) > 0.08) coast.current = requestAnimationFrame(step);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }
  function openCard(event: ReactMouseEvent<HTMLButtonElement>, open: () => void) {
    if (suppressClick.current) {
      event.preventDefault();
      suppressClick.current = false;
      return;
    }
    open();
  }
  return (
    <div className="absolute inset-0 z-10 flex items-center">
      <div
        ref={scroller}
        className="scroll-hidden flex h-full w-full cursor-grab items-center gap-8 overflow-x-auto active:cursor-grabbing"
        style={{ paddingLeft: gutter, paddingRight: gutter, touchAction: "none" }}
        onPointerDown={onPanStart}
      >
        {names.map((name, workspaceIndex) => (
          <button
            key={name}
            type="button"
            data-current={workspaceIndex === activeIndex ? "true" : undefined}
            className="relative shrink-0 overflow-hidden rounded-[18px] text-left shadow-[0_24px_70px_rgba(0,0,0,0.38)] ring-1 ring-white/30"
            style={{ width: cardWidth, height: cardHeight }}
            onClick={(event) => {
              openCard(event, () => {
                const preview = event.currentTarget.querySelector("[data-workspace-preview]");
                if (preview instanceof HTMLElement) onOpen(workspaceIndex, preview);
              });
            }}
          >
            <div
              data-workspace-preview
              className="pointer-events-none origin-top-left"
              style={{
                width: stage.width,
                height: stage.height,
                transform: `scale(${scale})`,
                background: `#1a1916 url("${wallpaperFor(name)}") center / cover no-repeat`,
              }}
            >
              <div className="h-full px-8 pt-20 pb-24">
                <Board
                  items={itemsFor(name)}
                  cols={cols}
                  rows={rows}
                  editing={false}
                  icons={icons}
                  folderKids={folderKids}
                  activeName={null}
                  overName={null}
                  onOpen={() => {}}
                  onRemove={() => {}}
                  onNote={() => {}}
                  onResize={() => {}}
                  idPrefix={`overview:${name}:`}
                />
              </div>
            </div>
            <span className="desktop-label absolute inset-x-0 bottom-3 text-center text-sm">{name}</span>
          </button>
        ))}
        <button
          type="button"
          title="新建工作区"
          className="grid shrink-0 place-items-center rounded-[18px] border border-dashed border-white/40 bg-white/10 text-4xl text-white/80"
          style={{ width: cardWidth, height: cardHeight }}
          onClick={(event) => openCard(event, onCreate)}
        >
          +
        </button>
      </div>
    </div>
  );
}

function toLayout(items: GridItem[]): Record<string, Placement> {
  return Object.fromEntries(
    items.map((item) => [
      item.name,
      {
        col: item.col,
        row: item.row,
        spanCol: item.spanCol,
        spanRow: item.spanRow,
        note: item.note,
      },
    ]),
  );
}

function cellAt(x: number, y: number) {
  for (const node of document.elementsFromPoint(x, y)) {
    if (!(node instanceof Element)) continue;
    const cell = node.closest("[data-cell]");
    if (!(cell instanceof HTMLElement) || cell.dataset.col == null || cell.dataset.row == null) continue;
    return { col: Number(cell.dataset.col), row: Number(cell.dataset.row) };
  }
  return null;
}

function samePlaces(current: GridItem[], next: GridItem[]) {
  if (current.length !== next.length) return false;
  const byName = new Map(current.map((item) => [item.name, item]));
  return next.every((item) => {
    const previous = byName.get(item.name);
    return previous?.col === item.col && previous.row === item.row;
  });
}

function storageKey(name: string, path: string[]) {
  return `${name}/${path.join("/")}`;
}

function isMadeGroup(name: string) {
  return /^分组(?: \d+)?$/.test(name);
}

async function releaseSingletonGroup(workspace: string, path: string[]): Promise<string[] | null> {
  if (path.length === 0 || !isMadeGroup(path[path.length - 1])) return null;
  const listing = await listDir(workspace, path);
  if (listing.entries.length > 1) return null;
  const parent = path.slice(0, -1);
  if (listing.entries.length === 1) {
    await moveEntry(workspace, path, listing.entries[0].name, workspace, parent);
  }
  await deleteEntry(workspace, parent, path[path.length - 1]);
  return parent;
}

async function dissolveSingletonGroups(workspace: string, path: string[]): Promise<boolean> {
  const listing = await listDir(workspace, path);
  let changed = false;
  for (const entry of listing.entries) {
    if (entry.kind !== "folder" || !isMadeGroup(entry.name)) continue;
    const childPath = [...path, entry.name];
    const inner = await listDir(workspace, childPath);
    if (inner.entries.length > 1) continue;
    if (inner.entries.length === 1) {
      await moveEntry(workspace, childPath, inner.entries[0].name, workspace, path);
    }
    await deleteEntry(workspace, path, entry.name);
    changed = true;
  }
  return changed;
}

function isApp(item: GridItem) {
  const ext = item.name.includes(".") ? (item.name.split(".").pop()?.toLowerCase() ?? "") : "";
  return item.kind === "file" && (ext === "exe" || ext === "lnk");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function Empty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="text-center">
        <div className="mb-3 text-3xl">还没有工作区</div>
        <p className="mb-6 text-[#f4f1ea]/60">每个工作区是总文件夹里的一个文件夹。</p>
        <button
          type="button"
          className="rounded-full bg-[#e2b657] px-5 py-2 text-[#241c0d]"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onCreate}
        >
          新建工作区
        </button>
      </div>
    </div>
  );
}

function MenuItem({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="block w-full px-4 py-2 text-left hover:bg-white/10 disabled:text-white/30"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function DockButton({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button type="button" className="rounded-full px-3 py-1 text-sm text-[#f4f1ea] hover:bg-white/10" onClick={onClick}>
      {children}
    </button>
  );
}

function Settings({
  config,
  onClose,
  onSave,
  onError,
}: {
  config: Config;
  onClose: () => void;
  onSave: (config: Config) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [root, setRoot] = useState(config.root);
  const [dropMode, setDropMode] = useState<DropMode>(config.dropMode);
  const [shortcut, setShortcut] = useState(config.shortcut);
  const [launchAtLogin, setLaunchAtLogin] = useState(config.launchAtLogin);
  const [capturing, setCapturing] = useState(false);

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/55" onClick={onClose}>
      <form
        className="w-[min(520px,92%)] rounded-[28px] bg-[#22261f] p-6"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({ root, dropMode, shortcut, launchAtLogin }).catch(onError);
        }}
      >
        <h2 className="mb-5 text-xl">设置</h2>
        <label className="mb-4 block text-sm text-[#f4f1ea]/70">
          总文件夹
          <div className="mt-2 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-xl bg-black/30 px-3 py-2 text-[#f4f1ea] outline-none"
              value={root}
              onChange={(event) => setRoot(event.target.value)}
            />
            <button
              type="button"
              className="rounded-xl bg-white/10 px-3"
              onClick={() => {
                if (!inTauri()) return;
                void open({ directory: true, title: "选择总文件夹" }).then((picked) => {
                  if (typeof picked === "string") setRoot(picked);
                });
              }}
            >
              浏览
            </button>
          </div>
        </label>
        <div className="mb-4 text-sm text-[#f4f1ea]/70">
          放入方式
          <div className="mt-2 flex gap-2">
            {(
              [
                ["move", "移动"],
                ["copy", "复制"],
                ["shortcut", "快捷方式"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`rounded-full px-3 py-1 ${dropMode === value ? "bg-[#e2b657] text-[#241c0d]" : "bg-white/10 text-[#f4f1ea]"}`}
                onClick={() => setDropMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="mb-4 text-sm text-[#f4f1ea]/70">
          开机启动
          <div className="mt-2">
            <button
              type="button"
              className={`rounded-full px-3 py-1 ${launchAtLogin ? "bg-[#e2b657] text-[#241c0d]" : "bg-white/10 text-[#f4f1ea]"}`}
              onClick={() => setLaunchAtLogin((enabled) => !enabled)}
            >
              {launchAtLogin ? "已开启" : "已关闭"}
            </button>
          </div>
        </div>
        <label className="mb-6 block text-sm text-[#f4f1ea]/70">
          显示 / 隐藏快捷键
          <input
            className="mt-2 w-full rounded-xl bg-black/30 px-3 py-2 text-[#f4f1ea] outline-none"
            value={capturing ? "请按下快捷键" : shortcut}
            readOnly
            onKeyDown={(event) => {
              event.preventDefault();
              if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;
              if (event.key === "Escape") {
                setCapturing(false);
                return;
              }
              const parts: string[] = [];
              if (event.ctrlKey) parts.push("Ctrl");
              if (event.altKey) parts.push("Alt");
              if (event.shiftKey) parts.push("Shift");
              if (event.metaKey) parts.push("Super");
              let key = event.code;
              if (key.startsWith("Key")) key = key.slice(3);
              else if (key.startsWith("Digit")) key = key.slice(5);
              else if (key === "Space") key = "Space";
              else if (!/^F\d+$/.test(key)) return;
              parts.push(key);
              setShortcut(parts.join("+"));
              setCapturing(false);
            }}
            onFocus={() => setCapturing(true)}
            onBlur={() => setCapturing(false)}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-full px-4 py-2 text-sm" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="rounded-full bg-[#e2b657] px-4 py-2 text-sm text-[#241c0d]">
            保存
          </button>
        </div>
      </form>
    </div>
  );
}

function PromptDialog({
  title,
  value,
  onCancel,
  onSubmit,
}: {
  title: string;
  value: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/45">
      <form
        className="w-[min(420px,90%)] rounded-3xl bg-[#22261f] p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) onSubmit(text.trim());
        }}
      >
        <div className="mb-3 text-lg">{title}</div>
        <input
          autoFocus
          className="mb-4 w-full rounded-xl bg-black/30 px-3 py-2 outline-none"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-full px-4 py-2 text-sm" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="rounded-full bg-[#e2b657] px-4 py-2 text-sm text-[#241c0d]">
            确定
          </button>
        </div>
      </form>
    </div>
  );
}

function ConfirmDialog({ text, onNo, onYes }: { text: string; onNo: () => void; onYes: () => void }) {
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/45">
      <div className="w-[min(420px,90%)] rounded-3xl bg-[#22261f] p-5">
        <p className="mb-5 leading-6">{text}</p>
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-full px-4 py-2 text-sm" onClick={onNo}>
            取消
          </button>
          <button type="button" className="rounded-full bg-[#d46a6a] px-4 py-2 text-sm text-white" onClick={onYes}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
