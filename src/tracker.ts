import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { HoopError, splitRow, TABLE_DELIM, writeAtomic } from "./util.js";

export type TrackerItem = {
  id: string;
  parent?: string;
  type?: string;
  title: string;
  status?: string;
  phase?: string;
  cells: Record<string, string>;
  /** 0-based line in the file. */
  line: number;
  /** The item's `Project` cell, or the repository's name. */
  project: string;
  /** A row for a change request, which trackers no longer hold; it shows apart until the fold removes it. */
  legacy_change?: true;
};
export type TreeNode = { item: TrackerItem; children: TreeNode[] };
/**
 * An item's block under "## Items": its text, whether it has a description, and its definition of
 * done, whose points count as met when they are checked task list items.
 */
export type TrackerBlock = { line: number; text: string; has_description: boolean; has_dod: boolean; points: number; met: number };
export type Tracker = { columns: string[]; items: TrackerItem[]; tree: TreeNode[]; blocks: Record<string, TrackerBlock>; hash: string };

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

const isRow = (line: string) => line.trim().startsWith("|");
const isSeparator = (line: string) => TABLE_DELIM.test(line);
const formatRow = (cells: string[]) => `|${cells.map((c) => (c ? ` ${c} ` : " ")).join("|")}|`;
const clean = (value: string) =>
  value
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/(?<!\\)\|/g, "\\|")
    .trim();

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

export type TrackerTable = { start: number; end: number; columns: string[]; rows: { line: number; cells: Record<string, string> }[] };

/** Every tracker table (a header with ID and Parent, a separator, then rows) in a list of lines. */
export function trackerTables(lines: string[]): TrackerTable[] {
  const out: TrackerTable[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isRow(lines[i]!) || !isSeparator(lines[i + 1]!)) continue;
    const columns = splitRow(lines[i]!);
    let end = i + 2;
    while (end < lines.length && isRow(lines[end]!)) end++;
    if (columns.includes("ID") && columns.includes("Parent")) {
      const rows = [];
      for (let n = i + 2; n < end; n++) {
        const values = splitRow(lines[n]!);
        rows.push({ line: n, cells: Object.fromEntries(columns.map((c, j) => [c, values[j] ?? ""])) });
      }
      out.push({ start: i, end, columns, rows });
    }
    i = end - 1;
  }
  return out;
}

/** The first tracker table in a file (FR-8). */
function findTable(text: string, path: string): Table {
  const raw = text.split("\n");
  const cr = raw.map((l) => l.endsWith("\r"));
  const lines = raw.map((l, i) => (cr[i] ? l.slice(0, -1) : l));
  const first = trackerTables(lines)[0];
  if (!first) throw new HoopError(`no tracker table in ${path}: expected a table with ID and Parent columns`);
  return { lines, cr, crlf: text.includes("\r\n"), header: first.start, end: first.end, columns: first.columns };
}

/** The repository a tracker belongs to: the folder that holds its `docs` folder. */
function repoOf(path: string): string {
  const at = path.lastIndexOf(`${sep}docs${sep}`);
  return at >= 0 ? path.slice(0, at) : dirname(path);
}

function parse(text: string, path: string): Tracker {
  const t = findTable(text, path);
  const project = basename(repoOf(path));
  const items: TrackerItem[] = trackerTables(t.lines)[0]!
    .rows.filter((r) => r.cells.ID)
    .map(({ line, cells }) => {
      const opt = (c: string) => cells[c] || undefined;
      return {
        id: cells.ID!,
        parent: opt("Parent"),
        type: opt("Type"),
        title: cells.Title ?? "",
        status: opt("Status"),
        phase: opt("Phase"),
        cells,
        line,
        project: cells.Project || project,
        ...(/^CR-\d+$/.test(cells.ID!) ? { legacy_change: true as const } : {}),
      };
    });
  return { columns: t.columns, items, tree: buildTree(items), blocks: blocksOf(t.lines), hash: hashOf(text) };
}

const LABEL = /^(?:#{1,6}\s+)?[A-Z][A-Za-z ,'-]{0,40}:$/;
const DOD = /^(?:#{1,6}\s+)?Definition of done:?$/i;
const POINT = /^\s*[-*+]\s+/;
const MET = /^\s*[-*+]\s+\[[xX]\]\s/;

/** Each item's block: a `### <ID>: <title>` heading under `## Items`, up to the next heading. */
function blocksOf(lines: string[]): Record<string, TrackerBlock> {
  const start = lines.findIndex((l) => /^##\s+Items\s*$/.test(l));
  const out: Record<string, TrackerBlock> = {};
  if (start < 0) return out;
  let i = start + 1;
  while (i < lines.length && !/^##\s/.test(lines[i]!)) {
    const m = lines[i]!.match(/^###\s+([A-Za-z][\w.-]*):\s/);
    if (!m) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !/^#{2,3}\s/.test(lines[end]!)) end++;
    const body = lines.slice(i + 1, end);
    const firstLabel = body.findIndex((l) => LABEL.test(l.trim()));
    // A placeholder such as "<Why: ...>." left from the stub doesn't count as a description.
    const description = (firstLabel < 0 ? body : body.slice(0, firstLabel)).some((l) => l.trim() && !POINT.test(l) && !/^<.*>\.?$/.test(l.trim()));
    const dod = body.findIndex((l) => DOD.test(l.trim()));
    const points: string[] = [];
    if (dod >= 0)
      for (const l of body.slice(dod + 1)) {
        if (POINT.test(l)) points.push(l);
        else if (l.trim()) break;
      }
    out[m[1]!] = {
      line: i,
      text: lines.slice(i, end).join("\n").trimEnd(),
      has_description: description,
      has_dod: dod >= 0 && points.length > 0,
      points: points.length,
      met: points.filter((p) => MET.test(p)).length,
    };
    i = end;
  }
  return out;
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
  writeAtomic(path, out);
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
    const row = t.columns.map((c, j) => (c in cells ? clean(cells[c]!) : (values[j] ?? "")));
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
    // Every item hoop adds comes with a block to fill in, at the end of Items.
    if (!t.lines.some((l) => /^##\s+Items\s*$/.test(l))) appendLines(t, ["", "## Items"]);
    addBlock(t, blockStub(cells.ID!, clean(cells.Title ?? "")));
  });
}

/** The block a new item starts with: the tracker template's four headings, each to fill in. */
export function blockStub(id: string, title: string): string[] {
  return [
    `### ${id}: ${title || "<One sentence that names the outcome>."}`,
    "",
    "<Why: one or two sentences on what this item delivers>.",
    "",
    "What is expected:",
    "- <The behavior or result once it is done>.",
    "",
    "Scope:",
    "- In: <what this item changes>.",
    "",
    "How to check:",
    "- <The test or review that shows it works>.",
    "",
    "Definition of done:",
    "- [ ] Every check above passes.",
  ];
}

/** Puts a block at the end of the Items section: before the next section, or at the end of the file. */
function addBlock(t: Table, block: string[]) {
  const items = t.lines.findIndex((l) => /^##\s+Items\s*$/.test(l));
  const next = t.lines.findIndex((l, i) => i > items && /^##\s/.test(l));
  if (next < 0) return appendLines(t, ["", ...block]);
  let at = next;
  while (at > items + 1 && t.lines[at - 1] === "") at--;
  const add = ["", ...block, ""];
  t.lines.splice(at, 0, ...add);
  t.cr.splice(at, 0, ...add.map(() => t.crlf));
}

/** Appends lines at the end of the file, after the table and any blocks. */
function appendLines(t: Table, add: string[]) {
  while (t.lines.length > t.end && t.lines.at(-1) === "") {
    t.lines.pop();
    t.cr.pop();
  }
  if (t.lines.length) t.cr[t.lines.length - 1] = t.crlf;
  for (const l of add) {
    t.lines.push(l);
    t.cr.push(t.crlf);
  }
  t.lines.push("");
  t.cr.push(false);
}

/** The repository's trackers: the project's and each change's, relative to the repository. */
export function trackerFiles(repo: string): string[] {
  const changes = join(repo, "docs", "changes");
  const found = existsSync(changes)
    ? readdirSync(changes)
        .sort((a, b) => (Number(a.match(/\d+/)?.[0]) || 0) - (Number(b.match(/\d+/)?.[0]) || 0))
        .map((d) => `docs/changes/${d}/TRACKER.md`)
    : [];
  return ["docs/TRACKER.md", ...found].filter((f) => existsSync(join(repo, f)));
}

/** A markdown file inside the repository, or a refusal; symlinks are resolved first. */
export function insideRepo(repo: string, file: string): string {
  const root = realpathSync(repo),
    path = resolve(root, file);
  if (!path.endsWith(".md")) throw new HoopError(`${file} is not a markdown file`);
  if (!existsSync(path)) throw new HoopError(`no tracker at ${file}`);
  const real = realpathSync(path);
  if (!real.startsWith(root + sep)) throw new HoopError(`${file} is outside the repository`);
  return real;
}
