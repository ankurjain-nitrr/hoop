import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FENCE, ITEM, TABLE_DELIM } from "../web/blocks.js";
import type { Store } from "./store.js";
import { HoopError, writeAtomic } from "./util.js";

/** The blocks a build is made of: the blocks a markdown file has. */
export const BLOCK_KINDS = ["h1", "h2", "h3", "paragraph", "list", "table", "code", "diagram"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/**
 * One block of a build. `id` never changes. `text` is the block's markdown as written; `sep` is the
 * exact text between it and the next block (a blank line unless the source had another).
 */
export type BuildBlock = { id: string; kind: BlockKind; text: string; sep?: string; by: "person" | "claude"; generated?: true };

/** One change to a build: who made it, when, and what it did to which block. */
export type BuildStep = { n: number; at: string; by: string; what: string; block?: string };

/**
 * A build's current state. `version` counts its changes, so the page can tell when to redraw.
 * `lead` and `tail` are the text before the first block and after the last.
 */
export type Build = { version: number; next: number; lead: string; tail: string; blocks: BuildBlock[]; steps: BuildStep[] };

const ATX = /^\s{0,3}(#{1,6})(\s|$)/;
const MERMAID = /^\s{0,3}(```|~~~)\s*mermaid\s*$/;

/** A block's kind, from its first lines. Headings below `###` count as subsections. */
export function kindOf(text: string): BlockKind {
  const [first = "", second = ""] = text.split("\n");
  const h = first.match(ATX);
  if (h) return h[1]!.length === 1 ? "h1" : h[1]!.length === 2 ? "h2" : "h3";
  if (MERMAID.test(first)) return "diagram";
  if (FENCE.test(first)) return "code";
  if (ITEM.test(first)) return "list";
  if (first.includes("|") && TABLE_DELIM.test(second)) return "table";
  return "paragraph";
}

/** A heading block's level, or 0 for any other block. */
export const levelOf = (b: { text: string }) => b.text.match(ATX)?.[1]?.length ?? 0;

/**
 * Splits markdown into blocks: blank lines separate blocks outside code fences, and a heading is
 * always a block of its own. Each block keeps the exact text that follows it (`sep`), and the text
 * before the first and after the last is `lead` and `tail`, so `joinBlocks` gives the input back
 * byte for byte.
 */
export function splitBlocks(markdown: string): { lead: string; tail: string; blocks: { kind: BlockKind; text: string; sep: string }[] } {
  const lines = markdown.split("\n");
  // Each block as [first line, line after its last].
  const spans: [number, number][] = [];
  let start = -1;
  let fence = "";
  const close = (end: number) => {
    if (start >= 0) spans.push([start, end]);
    start = -1;
  };
  lines.forEach((line, i) => {
    if (fence) {
      if (line.trim().startsWith(fence)) {
        fence = "";
        close(i + 1);
      }
      return;
    }
    if (!line.trim()) return close(i);
    const opens = FENCE.exec(line)?.[1];
    if (opens || ATX.test(line)) close(i);
    if (start < 0) start = i;
    if (opens) fence = opens;
    else if (ATX.test(line)) close(i + 1);
  });
  close(lines.length);
  const at = (line: number) => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
  // A block's end offset excludes the newline after its last line.
  const ends = spans.map(([s, e]) => [at(s), at(e) - 1] as const);
  if (!spans.length) return { lead: markdown, tail: "", blocks: [] };
  const blocks = ends.map(([s, e], k) => {
    const text = markdown.slice(s, Math.min(e, markdown.length));
    const sep = k + 1 < ends.length ? markdown.slice(Math.min(e, markdown.length), ends[k + 1]![0]) : "";
    return { kind: kindOf(text), text, sep };
  });
  return { lead: markdown.slice(0, ends[0]![0]), tail: markdown.slice(Math.min(ends.at(-1)![1], markdown.length)), blocks };
}

/** A build's markdown: its blocks' text in order, each followed by its separator, or a blank line when it has none. */
export function joinBlocks(build: { lead: string; tail: string; blocks: { text: string; sep?: string }[] }): string {
  const body = build.blocks.map((b, i) => b.text + (i + 1 < build.blocks.length ? b.sep || "\n\n" : "")).join("");
  return build.lead + body + build.tail;
}

/** The text a new block of each kind starts with. */
export const STARTERS: Record<BlockKind, string> = {
  h1: "# Title",
  h2: "## Section",
  h3: "### Subsection",
  paragraph: "Write here.",
  list: "- First point\n- Second point",
  table: "| Column | Column |\n|---|---|\n| | |",
  code: "```\ncode\n```",
  diagram: "```mermaid\nflowchart LR\n  a[Start] --> b[End]\n```",
};

/** A change the page sends: add a block after another (or first), edit, move or remove one. */
export type BuildChange =
  | { op: "add"; kind: BlockKind; after?: string }
  | { op: "edit"; block: string; text: string }
  | { op: "move"; block: string; to: "up" | "down" }
  | { op: "remove"; block: string };

const FILE = "build.json";

/** The build files of reviews in a store: `build.json`, a snapshot per change, and block text by hash. */
export class Builds {
  constructor(readonly store: Store) {}

  private path(id: string, name = FILE) {
    return join(this.store.dirOf(id), name);
  }

  has(id: string): boolean {
    return existsSync(this.path(id));
  }

  read(id: string): Build {
    if (!this.has(id)) throw new HoopError(`review ${id} is not a build`);
    return JSON.parse(readFileSync(this.path(id), "utf8")) as Build;
  }

  /** A new build of `markdown`, every block written by `by`. */
  create(id: string, markdown: string, by: BuildBlock["by"]): Build {
    const { lead, tail, blocks } = splitBlocks(markdown);
    const build: Build = { version: 0, next: 1, lead, tail, blocks: [], steps: [] };
    for (const b of blocks) build.blocks.push({ id: `b${build.next++}`, kind: b.kind, text: b.text, sep: b.sep, by });
    return this.save(id, build, by === "claude" ? "claude" : "person", "started the build");
  }

  /**
   * Writes the build after a change, as one step in its history: a snapshot of the block list, with
   * each block's text stored once under the hash of its text, so a step that changes one block stores
   * one new text. The caller holds the review's lock.
   */
  save(id: string, build: Build, by: string, what: string, block?: string): Build {
    build.version += 1;
    build.steps.push({ n: build.version, at: new Date().toISOString(), by, what, ...(block ? { block } : {}) });
    const texts = join(this.store.dirOf(id), "blocks");
    mkdirSync(texts, { recursive: true });
    const refs = build.blocks.map(({ text, ...b }) => {
      const hash = createHash("sha256").update(text).digest("hex").slice(0, 32);
      if (!existsSync(join(texts, hash))) writeAtomic(join(texts, hash), text);
      return { ...b, hash };
    });
    writeAtomic(this.path(id, `build-${build.version}.json`), JSON.stringify({ lead: build.lead, tail: build.tail, blocks: refs }) + "\n");
    writeAtomic(this.path(id), JSON.stringify(build, null, 2) + "\n");
    this.store.update(id, { title: titleOf(build) ?? this.store.meta(id).title });
    return build;
  }

  /** A build as it was after step `n`, from its snapshot. */
  at(id: string, n: number): Pick<Build, "lead" | "tail" | "blocks"> {
    const path = this.path(id, `build-${n}.json`);
    if (!existsSync(path)) throw new HoopError(`build ${id} has no step ${n}`);
    const snap = JSON.parse(readFileSync(path, "utf8")) as { lead: string; tail: string; blocks: (Omit<BuildBlock, "text"> & { hash: string })[] };
    const texts = join(this.store.dirOf(id), "blocks");
    return { ...snap, blocks: snap.blocks.map(({ hash, ...b }) => ({ ...b, text: readFileSync(join(texts, hash), "utf8") })) };
  }

  /** Applies a person's change from the page. */
  change(id: string, c: BuildChange): Build {
    return this.store.lock(id, () => {
      const build = this.read(id);
      const index = (block: string) => {
        const i = build.blocks.findIndex((b) => b.id === block);
        if (i < 0) throw new HoopError(`build ${id} has no block ${block}`);
        return i;
      };
      if (c.op === "add") {
        if (!BLOCK_KINDS.includes(c.kind)) throw new HoopError(`a block is one of ${BLOCK_KINDS.join(", ")}`);
        const at = c.after === undefined ? 0 : index(c.after) + 1;
        const block: BuildBlock = { id: `b${build.next++}`, kind: c.kind, text: STARTERS[c.kind], by: "person" };
        build.blocks.splice(at, 0, block);
        return this.save(id, build, "person", `added a ${c.kind} block`, block.id);
      }
      if (c.op === "edit") {
        const i = index(c.block);
        if (!c.text.trim()) throw new HoopError("a block needs text; remove it instead");
        const old = build.blocks[i]!;
        const parts = splitBlocks(c.text.replace(/\r\n?/g, "\n")).blocks;
        // Text that is now several blocks becomes several blocks; the first keeps the block's ID.
        const next = parts.map((p, k) => ({
          id: k ? `b${build.next++}` : old.id,
          kind: p.kind,
          text: p.text,
          sep: k + 1 < parts.length ? p.sep : old.sep,
          by: "person" as const,
        }));
        if (next.length === 1 && next[0]!.text === old.text) return build;
        build.blocks.splice(i, 1, ...next.map(({ sep, ...b }) => (sep === undefined ? b : { ...b, sep })));
        return this.save(id, build, "person", "edited a block", old.id);
      }
      if (c.op === "move") {
        const i = index(c.block);
        const j = c.to === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= build.blocks.length) return build;
        [build.blocks[i], build.blocks[j]] = [build.blocks[j]!, build.blocks[i]!];
        return this.save(id, build, "person", `moved a block ${c.to}`, c.block);
      }
      if (c.op === "remove") {
        build.blocks.splice(index(c.block), 1);
        return this.save(id, build, "person", "removed a block", c.block);
      }
      throw new HoopError('expected op "add", "edit", "move" or "remove"');
    });
  }
}

/** The build's title: its first `#` heading's text. */
export function titleOf(build: Pick<Build, "blocks">): string | undefined {
  const h1 = build.blocks.find((b) => b.kind === "h1");
  return (
    h1?.text
      .replace(/^\s{0,3}#\s*/, "")
      .replace(/\s+#+\s*$/, "")
      .trim() || undefined
  );
}
