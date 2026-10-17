export type DropMode = "move" | "copy" | "shortcut";

export type Config = {
  root: string;
  dropMode: DropMode;
  shortcut: string;
  launchAtLogin: boolean;
};

export type Placement = {
  col: number;
  row: number;
  spanCol: number;
  spanRow: number;
  note: boolean;
};

export type DirEntry = {
  name: string;
  kind: "file" | "folder";
  path: string;
  content: string | null;
};

export type FolderChild = {
  name: string;
  kind: "file" | "folder";
  path: string;
};

export type DirListing = {
  entries: DirEntry[];
  layout: Record<string, Placement>;
};

export type GridItem = {
  name: string;
  kind: "file" | "folder";
  path: string;
  content: string;
  col: number;
  row: number;
  spanCol: number;
  spanRow: number;
  note: boolean;
};
