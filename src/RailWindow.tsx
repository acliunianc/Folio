import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DndContext } from "@dnd-kit/core";
import { fileIcons, listDir, readWorkspaceBackground } from "./api";
import { Board } from "./Board";
import { arrange } from "./layout";
import type { GridItem } from "./types";

const wallpaper = "/t01678398d736b184ed.jpg";
const stage = { width: 1280, height: 800 };
const card = { width: 276, height: 172 };

function useRailEvents(onShow: (names: string[]) => void, onHide: () => void) {
  useEffect(() => {
    document.documentElement.dataset.rail = "1";
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
    const stops: Array<() => void> = [];
    void listen<string[]>("rail-names", (event) => onShow(event.payload)).then((stop) => stops.push(stop));
    void listen<string[]>("rail-show", (event) => onShow(event.payload)).then((stop) => stops.push(stop));
    void listen("rail-reset", () => onHide()).then((stop) => stops.push(stop));
    return () => stops.forEach((stop) => stop());
  }, [onHide, onShow]);
}

function DropMark() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.rail = "1";
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
    const stops: Array<() => void> = [];
    void listen("rail-show", () => setShown(true)).then((stop) => stops.push(stop));
    void listen("rail-reset", () => setShown(false)).then((stop) => stops.push(stop));
    return () => stops.forEach((stop) => stop());
  }, []);
  if (!shown) return null;
  return (
    <div className="grid h-screen w-screen place-items-center">
      <img src="/tauri.svg" alt="" className="h-9 w-9 object-contain" draggable={false} />
    </div>
  );
}

function DropPanel() {
  const [names, setNames] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [probe, setProbe] = useState<{ x: number; y: number } | null>(null);
  const [boards, setBoards] = useState<Record<string, GridItem[]>>({});
  const [walls, setWalls] = useState<Record<string, string>>({});
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [overflow, setOverflow] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const lastScroll = useRef(0);
  const show = useCallback((next: string[]) => setNames(next), []);
  const hide = useCallback(() => {
    setOpen(false);
    setCurrent(null);
    setProbe(null);
  }, []);
  useRailEvents(show, hide);

  useEffect(() => {
    const stops: Array<() => void> = [];
    void listen("rail-open", () => setOpen(true)).then((stop) => stops.push(stop));
    void listen("rail-leave", () => setOpen(false)).then((stop) => stops.push(stop));
    void listen<{ x: number; y: number }>("rail-probe", (event) => setProbe(event.payload)).then((stop) => stops.push(stop));
    return () => stops.forEach((stop) => stop());
  }, []);

  useEffect(() => {
    if (names.length === 0) return;
    let cancel = false;
    void (async () => {
      const nextBoards: Record<string, GridItem[]> = {};
      const nextWalls: Record<string, string> = {};
      for (const name of names) {
        try {
          const listing = await listDir(name, []);
          nextBoards[name] = arrange(listing.entries, listing.layout, 8, 4).items;
        } catch {
          nextBoards[name] = [];
        }
        nextWalls[name] = (await readWorkspaceBackground(name).catch(() => null)) || wallpaper;
      }
      if (cancel) return;
      setBoards(nextBoards);
      setWalls(nextWalls);
      const paths = Object.values(nextBoards).flat().map((item) => item.path);
      if (paths.length === 0) return;
      const found = await fileIcons(paths).catch(() => ({}));
      if (!cancel) setIcons(found);
    })();
    return () => {
      cancel = true;
    };
  }, [names]);

  useEffect(() => {
    const node = root.current;
    if (!node || !open) return;
    const report = () => {
      void invoke("place_rail", { width: node.offsetWidth, height: node.offsetHeight }).catch(() => undefined);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, names.length, overflow]);

  useEffect(() => {
    const node = scroller.current;
    if (!node || !open) {
      setOverflow(false);
      return;
    }
    const check = () => setOverflow(node.scrollHeight - node.clientHeight > 4);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, names.length]);

  useEffect(() => {
    if (!probe || !open) return;
    const target = document.elementFromPoint(probe.x / window.devicePixelRatio, probe.y / window.devicePixelRatio);
    const name = target?.closest("[data-workspace-name]")?.getAttribute("data-workspace-name");
    if (name) {
      setCurrent(name);
      void invoke("hover_workspace", { name }).catch(() => undefined);
    }
    const edge = target?.closest("[data-workspace-scroll]")?.getAttribute("data-workspace-scroll");
    if (edge !== "prev" && edge !== "next") return;
    const now = Date.now();
    if (now - lastScroll.current < 140) return;
    lastScroll.current = now;
    if (scroller.current) scroller.current.scrollTop += edge === "prev" ? -36 : 36;
  }, [probe, open]);

  if (!open) return null;

  const scale = card.width / stage.width;
  const chevron = (edge: "prev" | "next", glyph: string) =>
    overflow ? (
      <span data-workspace-scroll={edge} className="grid h-8 place-items-center text-sm text-white/80">
        {glyph}
      </span>
    ) : null;

  return (
    <DndContext>
      <div ref={root} className="flex w-[308px] flex-col px-3 py-3">
        {chevron("prev", "▲")}
        <div ref={scroller} className="scroll-hidden flex max-h-[640px] flex-col gap-4 overflow-hidden">
          {names.map((name) => (
            <div
              key={name}
              data-workspace-name={name}
              className={`relative shrink-0 overflow-hidden rounded-2xl ring-1 ${name === current ? "ring-white" : "ring-white/30"}`}
              style={{ width: card.width, height: card.height }}
            >
              <div
                className="pointer-events-none origin-top-left"
                style={{
                  width: stage.width,
                  height: stage.height,
                  transform: `scale(${scale})`,
                  background: `#1a1916 url("${walls[name] || wallpaper}") center / cover no-repeat`,
                }}
              >
                <div className="h-full px-8 pt-16 pb-20">
                  <Board
                    items={boards[name] ?? []}
                    cols={8}
                    rows={4}
                    editing={false}
                    icons={icons}
                    folderKids={{}}
                    activeName={null}
                    overName={null}
                    onOpen={() => {}}
                    onRemove={() => {}}
                    onNote={() => {}}
                    onResize={() => {}}
                    idPrefix={`rail:${name}:`}
                  />
                </div>
              </div>
              <span className="desktop-label absolute inset-x-0 bottom-2 text-center text-sm">{name}</span>
            </div>
          ))}
        </div>
        {chevron("next", "▼")}
      </div>
    </DndContext>
  );
}

export default function RailWindow() {
  const label = getCurrentWindow().label;
  return label === "rail-panel" ? <DropPanel /> : <DropMark />;
}
