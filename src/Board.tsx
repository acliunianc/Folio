import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useEffect, useRef, useState } from "react";
import type { FolderChild, GridItem } from "./types";

const GAP = 12;
const MAX_CELL = 104;

const marks: Record<string, string> = {
  xlsx: "表",
  xls: "表",
  doc: "文",
  docx: "文",
  pdf: "PDF",
  png: "图",
  jpg: "图",
  md: "记",
  txt: "记",
  lnk: "链",
  exe: "应用",
};

const tones: Record<string, string> = {
  folder: "#d7b15a",
  md: "#8eacc4",
  txt: "#8eacc4",
  xlsx: "#7eae86",
  xls: "#7eae86",
  doc: "#7f93c4",
  docx: "#7f93c4",
  pdf: "#c47d72",
  png: "#c4a27a",
  jpg: "#c4a27a",
  lnk: "#c4b48a",
  exe: "#c48a6e",
};

export function Board({
  items,
  cols,
  rows,
  editing,
  icons,
  folderKids,
  activeName,
  overName,
  footprint,
  onOpen,
  onRemove,
  onNote,
  onResize,
  onGridChange,
  idPrefix = "",
}: {
  items: GridItem[];
  cols: number;
  rows: number;
  editing: boolean;
  icons: Record<string, string>;
  folderKids: Record<string, FolderChild[]>;
  activeName: string | null;
  overName: string | null;
  footprint?: { col: number; row: number; spanCol: number; spanRow: number } | null;
  onOpen: (item: GridItem) => void;
  onRemove: (item: GridItem) => void;
  onNote: (item: GridItem, content: string) => void;
  onResize: (name: string, spanCol: number, spanRow: number) => void;
  onGridChange?: (grid: { cols: number; rows: number; cell: number }) => void;
  idPrefix?: string;
}) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState(MAX_CELL);
  const contentRows = items.reduce((max, item) => Math.max(max, item.row + item.spanRow), 0);
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      cells.push({ col, row });
    }
  }

  useEffect(() => {
    const node = boardRef.current;
    if (!node) return;
    const measure = () => {
      const available = node.parentElement?.clientHeight ?? node.clientHeight;
      const width = node.clientWidth;
      if (width <= 0) return;
      let nextCols = Math.max(6, Math.floor((width + GAP) / (MAX_CELL + GAP)));
      let size = (width - GAP * (nextCols - 1)) / nextCols;
      if (size > MAX_CELL) {
        nextCols += 1;
        size = (width - GAP * (nextCols - 1)) / nextCols;
      }
      const fitRows = Math.max(1, Math.floor((available + GAP) / (size + GAP)));
      const nextRows = Math.max(fitRows, contentRows);
      setCell((current) => (Math.abs(current - size) < 0.5 ? current : size));
      onGridChange?.({ cols: nextCols, rows: nextRows, cell: size });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.parentElement) observer.observe(node.parentElement);
    return () => observer.disconnect();
  }, [contentRows, onGridChange]);

  return (
    <div ref={boardRef} className="flex min-h-full w-full items-center justify-center">
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${cols}, ${cell}px)`,
          gridTemplateRows: `repeat(${rows}, ${cell}px)`,
          gap: GAP,
        }}
      >
        {cells.map((slot) => (
          <Cell key={`${slot.col}-${slot.row}`} col={slot.col} row={slot.row} footprint={footprint} idPrefix={idPrefix} />
        ))}
          {items.map((item) => (
            <Tile
              key={item.name}
              item={item}
              cell={cell}
              editing={editing}
              icon={icons[item.path]}
          kids={item.kind === "folder" ? (folderKids[item.path] ?? []) : []}
          icons={icons}
              dragging={activeName === item.name}
              grouping={overName === item.name && activeName !== item.name}
              onOpen={() => onOpen(item)}
              onRemove={() => onRemove(item)}
              onNote={(content) => onNote(item, content)}
              onResize={(spanCol, spanRow) => onResize(item.name, spanCol, spanRow)}
              idPrefix={idPrefix}
            />
          ))}
        </div>
    </div>
  );
}

function Cell({
  col,
  row,
  footprint,
  idPrefix,
}: {
  col: number;
  row: number;
  footprint?: { col: number; row: number; spanCol: number; spanRow: number } | null;
  idPrefix: string;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `${idPrefix}cell:${col}:${row}`,
    data: { type: "cell", col, row },
  });
  const covered = footprint
    ? col >= footprint.col &&
      row >= footprint.row &&
      col < footprint.col + footprint.spanCol &&
      row < footprint.row + footprint.spanRow
    : isOver;
  return (
    <div
      ref={setNodeRef}
      data-cell
      data-col={col}
      data-row={row}
      style={{ gridColumn: col + 1, gridRow: row + 1 }}
      className={`rounded-2xl ${covered ? "bg-white/15" : ""}`}
    />
  );
}

function Tile({
  item,
  cell,
  editing,
  icon,
  kids,
  icons,
  dragging,
  grouping,
  onOpen,
  onRemove,
  onNote,
  onResize,
  idPrefix,
}: {
  item: GridItem;
  cell: number;
  editing: boolean;
  icon?: string;
  kids: FolderChild[];
  icons: Record<string, string>;
  dragging: boolean;
  grouping: boolean;
  onOpen: () => void;
  onRemove: () => void;
  onNote: (content: string) => void;
  onResize: (spanCol: number, spanRow: number) => void;
  idPrefix: string;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${idPrefix}item:${item.name}`,
    data: { type: "item", name: item.name, spanCol: item.spanCol, spanRow: item.spanRow },
  });
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    if (editing) setWriting(false);
  }, [editing]);

  return (
    <div
      ref={setNodeRef}
      data-item
      data-name={item.name}
      style={{
        gridColumn: `${item.col + 1} / span ${item.spanCol}`,
        gridRow: `${item.row + 1} / span ${item.spanRow}`,
      }}
      className={`relative z-10 min-h-0 ${editing && !dragging && !isDragging ? "wiggle" : ""} ${dragging ? "opacity-40" : ""}`}
      {...listeners}
      {...attributes}
      onClick={(event) => {
        if (editing) return;
        event.stopPropagation();
        if (item.note) {
          setWriting(true);
          return;
        }
        onOpen();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      {editing && (
        <button
          type="button"
          className="absolute top-1 left-1 z-20 grid h-6 w-6 place-items-center rounded-full bg-[#d46a6a] text-sm text-white"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
      {item.note ? (
        <NoteCard
          item={item}
          cell={cell}
          editing={editing}
          writing={writing && !editing}
          grouping={grouping}
          onNote={onNote}
          onFinish={() => setWriting(false)}
          onResize={onResize}
        />
      ) : (
        <FileCard item={item} cell={cell} icon={icon} kids={kids} icons={icons} grouping={grouping} />
      )}
    </div>
  );
}

function FileCard({
  item,
  cell,
  icon,
  kids,
  icons,
  grouping,
}: {
  item: GridItem;
  cell: number;
  icon?: string;
  kids: FolderChild[];
  icons: Record<string, string>;
  grouping: boolean;
}) {
  const ext = item.name.includes(".") ? item.name.split(".").pop()?.toLowerCase() ?? "" : "";
  const tone = tones[ext] ?? "#8d8a84";
  const iconSize = snapIconSize(cell * 0.62);
  return (
    <div className={`flex h-full flex-col items-center justify-start gap-1.5 rounded-2xl px-1.5 pt-1 ${grouping ? "bg-white/10 ring-2 ring-[#e2b657]" : ""}`}>
      {item.kind === "folder" ? (
        <GroupGlyph kids={kids} icons={icons} size={iconSize} />
      ) : icon ? (
        <img src={icon} alt="" className="object-contain" style={{ width: iconSize, height: iconSize }} draggable={false} />
      ) : (
        <span
          className="grid place-items-center rounded-2xl font-semibold text-[#1c1a16]"
          style={{ width: iconSize, height: iconSize, background: tone, fontSize: Math.max(13, iconSize * 0.34) }}
        >
          {marks[ext] ?? (ext || "档").slice(0, 2).toUpperCase()}
        </span>
      )}
      <span className="desktop-label line-clamp-2 min-h-8 w-full text-center text-[12px] leading-4">{item.name}</span>
    </div>
  );
}

export function snapIconSize(px: number) {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(1, Math.round(px * dpr) / dpr);
}

export function GroupGlyph({
  kids,
  icons,
  size,
}: {
  kids: FolderChild[];
  icons: Record<string, string>;
  size: number;
}) {
  const gap = Math.max(2, Math.round(size * 0.08));
  const pad = Math.max(4, Math.round(size * 0.12));
  return (
    <div
      className="grid grid-cols-3 grid-rows-3 rounded-[28%] bg-white/16"
      style={{ width: size, height: size, gap, padding: pad }}
    >
      {Array.from({ length: 9 }, (_, index) => {
        const child = kids[index];
        if (!child) return <span key={index} />;
        return icons[child.path] ? (
          <img key={child.path} src={icons[child.path]} alt="" className="h-full w-full object-contain" draggable={false} />
        ) : (
          <span key={child.path} className={`rounded-[22%] ${child.kind === "folder" ? "bg-[#d7b15a]" : "bg-white/75"}`} />
        );
      })}
    </div>
  );
}

function NoteCard({
  item,
  cell,
  editing,
  writing,
  grouping,
  onNote,
  onFinish,
  onResize,
}: {
  item: GridItem;
  cell: number;
  editing: boolean;
  writing: boolean;
  grouping: boolean;
  onNote: (content: string) => void;
  onFinish: () => void;
  onResize: (spanCol: number, spanRow: number) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!writing) return;
    area.current?.focus();
  }, [writing]);

  return (
    <div className={`relative h-full overflow-hidden rounded-2xl bg-[#efe6d4] text-[#2b261f] shadow-[0_12px_30px_rgba(0,0,0,0.18)] ${grouping ? "ring-2 ring-[#e2b657]" : ""}`}>
      <textarea
        ref={area}
        className={`h-full w-full resize-none bg-transparent px-4 py-3 text-sm leading-6 outline-none ${writing ? "" : "pointer-events-none"}`}
        defaultValue={item.content}
        placeholder="写给这个工作区的备注"
        readOnly={!writing}
        tabIndex={writing ? 0 : -1}
        onPointerDown={(event) => {
          if (writing) event.stopPropagation();
        }}
        onBlur={(event) => {
          if (!writing) return;
          onNote(event.target.value);
          onFinish();
        }}
      />
      {editing && (
        <span
          className="absolute right-1 bottom-1 h-4 w-4 cursor-nwse-resize rounded-sm bg-[#2b261f]/25"
          onPointerDown={(event) => {
            event.stopPropagation();
            const startX = event.clientX;
            const startY = event.clientY;
            const startCol = item.spanCol;
            const startRow = item.spanRow;
            const move = (ev: PointerEvent) => {
              const spanCol = Math.min(3, Math.max(1, startCol + Math.round((ev.clientX - startX) / cell)));
              const spanRow = Math.min(3, Math.max(1, startRow + Math.round((ev.clientY - startY) / cell)));
              onResize(spanCol, spanRow);
            };
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        />
      )}
    </div>
  );
}

export function WorkspacePill({ name, active }: { name: string; active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `workspace:${name}`,
    data: { type: "workspace", name },
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`rounded-full px-3 py-1 text-sm ${active ? "bg-[#e2b657] text-[#241c0d]" : "bg-white/10 text-[#f4f1ea]"} ${isOver ? "ring-2 ring-white" : ""}`}
    >
      {name}
    </button>
  );
}
