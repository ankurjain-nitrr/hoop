import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import type { ChangeRecord } from "./changes.js";
import { HoopError } from "./hoop.js";

export type TrackerItem = {
  id: string; parent?: string; type?: string; title: string; status?: string; phase?: string;
  cells: Record<string, string>;
  /** 0-based line in the file. */
  line: number;
};
export type TreeNode = { item: TrackerItem; children: TreeNode[] };
export type Tracker = { columns: string[]; items: TrackerItem[]; tree: TreeNode[]; hash: string };

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Splits a table row on unescaped pipes; cells are trimmed and keep their `\|` escapes. */
function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return body.split(/(?<!\\)\|/).map((c) => c.trim());
}
const isRow = (line: string) => line.trim().startsWith("|");
const isSeparator = (line: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
const formatRow = (cells: string[]) => `|${cells.map((c) => (c ? ` ${c} ` : " ")).join("|")}|`;
const clean = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ").replace(/(?<!\\)\|/g, "\\|").trim();

/**
 * A file's lines without their `\r`, which `cr` records per line, so rewritten lines keep the
 * file's line endings and every other line is written back byte for byte.
 */
type Table = { lines: string[]; cr: boolean[]; crlf: boolean; header: number; end: number; columns: string[] };

function setLine(t: Table, i: number, text: string) {
  t.lines[i] = text;
}

function insertLine(t: Table, at: number, text: string) {
  // Appending after a last line that had no newline: that line now needs one.
  if (at === t.lines.length && at > 0) t.cr[at - 1] = t.crlf;
  const cr = at < t.lines.length ? t.crlf : false;
  t.lines.splice(at, 0, text);
  t.cr.splice(at, 0, cr);
  t.end++;
}

const joinLines = (t: Table) => t.lines.map((l, i) => l + (t.cr[i] ? "\r" : "")).join("\n");

/** The first table whose header has ID and Parent columns (FR-8). */
function findTable(text: string, path: string): Table {
  const raw = text.split("\n");
  const cr = raw.map((l) => l.endsWith("\r"));
  const lines = raw.map((l, i) => (cr[i] ? l.slice(0, -1) : l));
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isRow(lines[i]!) || !isSeparator(lines[i + 1]!)) continue;
    const columns = splitRow(lines[i]!);
    if (!columns.includes("ID") || !columns.includes("Parent")) continue;
    let end = i + 2;
    while (end < lines.length && isRow(lines[end]!)) end++;
    return { lines, cr, crlf: text.includes("\r\n"), header: i, end, columns };
  }
  throw new HoopError(`no tracker table in ${path}: expected a table with ID and Parent columns`);
}

function parse(text: string, path: string): Tracker {
  const t = findTable(text, path);
  const items: TrackerItem[] = [];
  for (let i = t.header + 2; i < t.end; i++) {
    const values = splitRow(t.lines[i]!);
    const cells = Object.fromEntries(t.columns.map((c, j) => [c, values[j] ?? ""]));
    if (!cells.ID) continue;
    const opt = (c: string) => cells[c] || undefined;
    items.push({ id: cells.ID, parent: opt("Parent"), type: opt("Type"), title: cells.Title ?? "", status: opt("Status"), phase: opt("Phase"), cells, line: i });
  }
  return { columns: t.columns, items, tree: buildTree(items), hash: hashOf(text) };
}

/** Nests items by parent; an unknown parent, or a cycle, makes an item a root. */
function buildTree(items: TrackerItem[]): TreeNode[] {
  const nodes = new Map(items.map((item) => [item.id, { item, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  const reaches = (from: string | undefined, target: string): boolean => {
    for (let seen = 0, at = from; at && seen <= items.length; seen++, at = nodes.get(at)?.item.parent) if (at === target) return true;
    return false;
  };
  for (const node of nodes.values()) {
    const parent = node.item.parent && nodes.get(node.item.parent);
    if (parent && !reaches(node.item.parent, node.item.id)) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function readTracker(path: string): Tracker {
  return parse(readFileSync(path, "utf8"), path);
}

/** Rewrites the file atomically if it still matches `base` (the hash the change was based on). */
function update(path: string, base: string | undefined, edit: (t: Table) => void): Tracker {
  const text = readFileSync(path, "utf8");
  if (base && hashOf(text) !== base) throw new HoopError(`${path} changed since it was read; read it again and retry`);
  const t = findTable(text, path);
  edit(t);
  const out = joinLines(t);
  // Write through a symlink to its target, so the link survives the rename.
  const real = realpathSync(path), tmp = `${real}.${process.pid}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, real);
  return parse(out, path);
}

/** Adds any columns the cells name that the table lacks, with an empty cell on every row. */
function addColumns(t: Table, names: string[]) {
  const missing = names.filter((n) => !t.columns.includes(n));
  if (!missing.length) return;
  // Existing separator cells keep their alignment; new columns get a plain one.
  const delims = splitRow(t.lines[t.header + 1]!);
  t.columns.push(...missing);
  setLine(t, t.header, formatRow(t.columns));
  setLine(t, t.header + 1, `|${[...delims, ...missing.map(() => "---")].join("|")}|`);
  for (let i = t.header + 2; i < t.end; i++) {
    const values = splitRow(t.lines[i]!);
    setLine(t, i, formatRow([...values, ...Array(Math.max(0, t.columns.length - values.length)).fill("")]));
  }
}

/** Changes the named cells of one item; every other line stays byte-identical (unless a column is added). */
export function setCells(path: string, id: string, cells: Record<string, string>, opts: { base?: string } = {}): Tracker {
  return update(path, opts.base, (t) => {
    addColumns(t, Object.keys(cells));
    const at = t.lines.findIndex((l, i) => i >= t.header + 2 && i < t.end && splitRow(l)[t.columns.indexOf("ID")] === id);
    if (at < 0) throw new HoopError(`no item ${id} in ${path}`, [{ path: "id", message: "unknown item" }]);
    const values = splitRow(t.lines[at]!);
    const row = t.columns.map((c, j) => (c in cells ? clean(cells[c]!) : values[j] ?? ""));
    setLine(t, at, formatRow(row));
  });
}

/** Inserts an item after `after` and its descendants (or at the end of the table). */
export function addItem(path: string, cells: Record<string, string>, opts: { after?: string; base?: string } = {}): Tracker {
  if (!cells.ID?.trim()) throw new HoopError("an item needs an ID", [{ path: "ID", message: "expected an ID" }]);
  return update(path, opts.base, (t) => {
    addColumns(t, Object.keys(cells));
    const { items } = parse(joinLines(t), path);
    if (items.some((i) => i.id === cells.ID)) throw new HoopError(`${path} already has ${cells.ID}`, [{ path: "ID", message: "duplicate ID" }]);
    let at = t.end;
    if (opts.after) {
      const anchor = items.find((i) => i.id === opts.after);
      if (!anchor) throw new HoopError(`no item ${opts.after} in ${path}`, [{ path: "after", message: "unknown item" }]);
      const under = (id?: string, depth = 0): boolean =>
        !!id && depth <= items.length && (id === anchor.id || under(items.find((i) => i.id === id)?.parent, depth + 1));
      at = anchor.line + 1;
      while (at < t.end && under(items.find((i) => i.line === at)?.id)) at++;
    }
    insertLine(t, at, formatRow(t.columns.map((c) => clean(cells[c] ?? ""))));
  });
}

const STATUS: Partial<Record<string, string>> = { intake: "queued", fold: "done", closed: "closed" };

/** Keeps a change's row in the tracker in step with its record: type, title, status and phase (FR-1, FR-2, FR-6). */
export function trackChange(path: string, rec: ChangeRecord): void {
  if (!existsSync(path)) writeFileSync(path, "# Tracker\n\n| ID | Parent | Type | Title | Status | Phase |\n|---|---|---|---|---|---|\n");
  const step = rec.steps.at(-1)?.step ?? "intake";
  const cells = { Type: rec.type, Title: rec.title, Status: STATUS[step] ?? "in progress", Phase: step };
  if (readTracker(path).items.some((i) => i.id === rec.id)) setCells(path, rec.id, cells);
  else addItem(path, { ID: rec.id, Parent: "", ...cells });
}
