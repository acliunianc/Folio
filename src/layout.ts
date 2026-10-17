import type { DirEntry, GridItem, Placement } from "./types";

export function arrange(
  entries: DirEntry[],
  layout: Record<string, Placement>,
  cols: number,
  minRows: number,
): { items: GridItem[]; rows: number; dirty: boolean } {
  const pending: { entry: DirEntry; spanCol: number; spanRow: number; note: boolean }[] = [];
  const items: GridItem[] = [];
  let rows = minRows;
  let dirty = false;

  for (const entry of entries) {
    const place = layout[entry.name];
    const note = place?.note ?? false;
    const spanCol = clamp(place?.spanCol ?? (note ? 2 : 1), 1, 3);
    const spanRow = clamp(place?.spanRow ?? (note ? 2 : 1), 1, 3);
    const positioned =
      place != null &&
      place.col >= 0 &&
      place.row >= 0 &&
      place.col + spanCol <= cols;
    if (!positioned) {
      pending.push({ entry, spanCol, spanRow, note });
      continue;
    }
    rows = Math.max(rows, place.row + spanRow);
    items.push({
      name: entry.name,
      kind: entry.kind,
      path: entry.path,
      content: entry.content ?? "",
      col: place.col,
      row: place.row,
      spanCol,
      spanRow,
      note,
    });
  }

  for (const item of pending) {
    let spot = findFree(items, item.spanCol, item.spanRow, cols, rows);
    if (!spot) {
      rows += item.spanRow;
      spot = findFree(items, item.spanCol, item.spanRow, cols, rows);
    }
    const cell = spot ?? { col: 0, row: rows - item.spanRow };
    items.push({
      name: item.entry.name,
      kind: item.entry.kind,
      path: item.entry.path,
      content: item.entry.content ?? "",
      col: cell.col,
      row: cell.row,
      spanCol: item.spanCol,
      spanRow: item.spanRow,
      note: item.note,
    });
    dirty = true;
  }

  return { items, rows, dirty };
}

export function findFree(
  items: GridItem[],
  spanCol: number,
  spanRow: number,
  cols: number,
  rows: number,
): { col: number; row: number } | null {
  for (let row = 0; row <= rows - spanRow; row += 1) {
    for (let col = 0; col <= cols - spanCol; col += 1) {
      const candidate = { col, row, spanCol, spanRow };
      if (items.every((item) => !overlaps(item, candidate))) {
        return { col, row };
      }
    }
  }
  return null;
}

export function overlaps(
  a: { col: number; row: number; spanCol: number; spanRow: number },
  b: { col: number; row: number; spanCol: number; spanRow: number },
): boolean {
  return (
    a.col < b.col + b.spanCol &&
    a.col + a.spanCol > b.col &&
    a.row < b.row + b.spanRow &&
    a.row + a.spanRow > b.row
  );
}

export function resizeItem(
  items: GridItem[],
  name: string,
  spanCol: number,
  spanRow: number,
  cols: number,
  rows: number,
) {
  const current = items.find((item) => item.name === name);
  if (!current) return items;
  const nextSpanCol = clamp(spanCol, 1, Math.min(3, cols - current.col));
  const nextSpanRow = clamp(spanRow, 1, 3);
  if (nextSpanCol === current.spanCol && nextSpanRow === current.spanRow) return items;

  const next = items.map((item) => ({ ...item }));
  const item = next.find((entry) => entry.name === name);
  if (!item) return items;
  item.spanCol = nextSpanCol;
  item.spanRow = nextSpanRow;

  const hits = next.filter((other) => other.name !== name && overlaps(item, other));
  if (hits.length === 0) return next;

  const placed = next.filter((other) => other.name === name || !hits.includes(other));
  let rowCount = Math.max(rows, item.row + item.spanRow);
  for (const hit of hits) {
    let spot = findFree(placed, hit.spanCol, hit.spanRow, cols, rowCount);
    if (!spot) {
      rowCount += hit.spanRow;
      spot = findFree(placed, hit.spanCol, hit.spanRow, cols, rowCount);
    }
    if (!spot) return items;
    hit.col = spot.col;
    hit.row = spot.row;
    placed.push(hit);
  }
  return next;
}

export function moveItem(items: GridItem[], name: string, col: number, row: number, cols: number, rows: number) {
  const next = items.map((item) => ({ ...item }));
  const item = next.find((entry) => entry.name === name);
  if (!item) return items;
  if (col < 0 || row < 0 || col + item.spanCol > cols || row + item.spanRow > rows) {
    return items;
  }
  const hits = next.filter(
    (other) => other.name !== name && overlaps({ ...item, col, row }, other),
  );
  if (hits.length === 1 && item.spanCol === 1 && item.spanRow === 1 && hits[0].spanCol === 1 && hits[0].spanRow === 1) {
    hits[0].col = item.col;
    hits[0].row = item.row;
    item.col = col;
    item.row = row;
    return next;
  }
  if (hits.length === 0) {
    item.col = col;
    item.row = row;
    return next;
  }
  return items;
}

export function packTopLeft(items: GridItem[], cols: number) {
  const ordered = [...items].sort((a, b) => a.row - b.row || a.col - b.col || a.name.localeCompare(b.name, "zh"));
  return flow(ordered, cols);
}

export function placePacked(items: GridItem[], name: string, col: number, row: number, cols: number) {
  const moving = items.find((item) => item.name === name);
  if (!moving) return items;
  const others = items.filter((item) => item.name !== name).sort((a, b) => a.row - b.row || a.col - b.col);
  let index = others.findIndex((item) => item.row > row || (item.row === row && item.col >= col));
  if (index < 0) index = others.length;
  const ordered = [...others];
  ordered.splice(index, 0, moving);
  return flow(ordered, cols);
}

function flow(ordered: GridItem[], cols: number) {
  const placed: GridItem[] = [];
  const room = Math.max(8, ordered.reduce((total, item) => total + item.spanRow, 0) + 2);
  for (const item of ordered) {
    const spot = findFree(placed, item.spanCol, item.spanRow, cols, room) ?? {
      col: 0,
      row: placed.reduce((max, entry) => Math.max(max, entry.row + entry.spanRow), 0),
    };
    placed.push({ ...item, col: spot.col, row: spot.row });
  }
  return placed;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
