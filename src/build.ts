import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ATX, FENCE, headingLevel, ITEM, sectionRange, swapRange, TABLE_DELIM, unitRange } from "../web/blocks.js";
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
 * What the person asks Claude for: "write" a section's text, or suggest headings: an "outline" under
 * a title, the "next" section after the last one among its siblings, or "subsections" of a section.
 */
export const ASKS = ["write", "outline", "next", "subsections"] as const;
export type Ask = (typeof ASKS)[number];
export type Suggestion = Exclude<Ask, "write">;

/**
 * The person's request to Claude about the section headed by `block`: to write it, or (with `kind`)
 * to suggest headings. It is queued until Claude's session takes it (`hoop_build_wait`), then taken
 * until Claude writes the section or its suggestions.
 */
export type GenRequest = {
  id: string;
  kind?: Suggestion;
  block: string;
  note?: string;
  at: string;
  status: "queued" | "taken" | "written";
  taken_at?: string;
  written_at?: string;
};

/**
 * A build's current state. `version` counts its changes, so the page can tell when to redraw.
 * `lead` and `tail` are the text before the first block and after the last. `undo` keeps, by
 * section heading, the section's blocks from before Claude last wrote it.
 */
/**
 * A heading Claude suggests for a request, which changes nothing in the document until the person
 * accepts it: then it becomes a heading block (`block`) where the request asked for it.
 */
export type Proposal = {
  id: string;
  request: string;
  kind: Suggestion;
  anchor: string;
  level: number;
  title: string;
  note?: string;
  status: "proposed" | "accepted" | "dismissed";
  block?: string;
};

export type Build = {
  version: number;
  next: number;
  lead: string;
  tail: string;
  blocks: BuildBlock[];
  steps: BuildStep[];
  requests?: GenRequest[];
  proposals?: Proposal[];
  undo?: Record<string, BuildBlock[]>;
};

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
export const levelOf = headingLevel;

export { sectionRange, unitRange };

/** A section Claude can write: a section or subsection heading, not the title. */
const writable = (b: BuildBlock | undefined) => b !== undefined && levelOf(b) >= 2;

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

/**
 * A change the page sends: add a block after another (or first), edit, move or remove one. A
 * heading moves with its section; removing one takes its section too when `section` is true, else
 * its blocks join the section above.
 */
export type BuildChange =
  | { op: "add"; kind: BlockKind; after?: string }
  | { op: "edit"; block: string; text: string }
  | { op: "move"; block: string; to: "up" | "down" }
  | { op: "remove"; block: string; section?: boolean }
  | { op: "generate"; block: string; note?: string }
  | { op: "suggest"; block: string; kind: Suggestion; note?: string }
  | { op: "accept"; proposal: string }
  | { op: "accept_all"; request: string }
  | { op: "dismiss"; proposal: string }
  | { op: "retitle"; proposal: string; title: string }
  | { op: "undo"; block: string };

/**
 * A request as Claude's session receives it: what to do, the section, the person's note, and the
 * text around it. A suggestion gives the heading level its headings start at.
 */
export type GenTask = {
  request: string;
  kind: Ask;
  section: string;
  heading: string;
  note?: string;
  section_markdown: string;
  markdown: string;
  level?: number;
};

/** One heading Claude suggests: its markdown (`## Costs`) and a line on what it covers. */
export type SuggestedHeading = { heading: string; note?: string };

/**
 * The level a suggestion's headings start at, which none goes above; each is at most one level
 * below the one before it. The next section is a sibling of the section it was asked on; an outline
 * or subsections sit under it.
 */
export const suggestionLevel = (kind: Suggestion, anchorLevel: number) => (kind === "next" ? anchorLevel : anchorLevel + 1);

/** Whether block `i` takes a request of `kind`: an outline on a title, subsections on a section, the next section on a section that is last among its siblings. */
function asksOn(blocks: BuildBlock[], i: number, kind: Ask): string | undefined {
  const level = levelOf(blocks[i]!);
  if (kind === "outline") return level === 1 ? undefined : "an outline is suggested under a title: ask on its # heading";
  if (kind === "subsections") return level >= 2 && level < 6 ? undefined : "subsections are suggested under a section: ask on its ## or ### heading";
  if (kind === "next") {
    if (level < 2) return "the next section is suggested after a section: ask on its ## or ### heading";
    return swapRange(blocks, i, "down") ? "the next section is suggested after the last section at its level" : undefined;
  }
  return writable(blocks[i]) ? undefined : "Claude writes a section or subsection: generate on its heading";
}

/** A new request's ID: one more than the highest so far, so a replaced request's ID is never reused. */
const nextRequestId = (requests: GenRequest[]) => `g${Math.max(0, ...requests.map((r) => Number(r.id.slice(1)) || 0)) + 1}`;

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
        const other = swapRange(build.blocks, i, c.to);
        if (!other) return build;
        const mine = unitRange(build.blocks, i);
        const what = levelOf(build.blocks[i]!)
          ? `moved section "${headingText(build.blocks[i]!.text)}" ${c.to === "up" ? "before" : "after"} "${headingText(build.blocks[other[0]]!.text)}"`
          : `moved a block ${c.to}`;
        // The earlier of the two goes after the later, each with its section.
        const [first, second] = c.to === "up" ? [other, mine] : [mine, other];
        build.blocks.splice(second[1] - (first[1] - first[0]), 0, ...build.blocks.splice(first[0], first[1] - first[0]));
        return this.save(id, build, "person", what, c.block);
      }
      if (c.op === "remove") {
        const i = index(c.block);
        const heading = build.blocks[i]!;
        if (!levelOf(heading)) {
          build.blocks.splice(i, 1);
          return this.save(id, build, "person", "removed a block", c.block);
        }
        const [start, end] = c.section ? unitRange(build.blocks, i) : [i, i + 1];
        const gone = build.blocks.splice(start, end - start);
        for (const b of gone) delete build.undo?.[b.id];
        const what = c.section ? `removed section "${headingText(heading.text)}" with its content` : `removed the heading "${headingText(heading.text)}"`;
        return this.save(id, build, "person", what, c.block);
      }
      if (c.op === "generate" || c.op === "suggest") {
        const i = index(c.block);
        const kind = c.op === "generate" ? undefined : c.kind;
        if (kind !== undefined && !ASKS.includes(kind)) throw new HoopError('a suggestion is "outline", "next" or "subsections"');
        const refused = asksOn(build.blocks, i, kind ?? "write");
        if (refused) throw new HoopError(refused);
        const requests = (build.requests ??= []);
        // A newer request of the same kind on the section replaces one Claude hasn't taken yet.
        build.requests = requests.filter((r) => !(r.block === c.block && r.kind === kind && r.status === "queued"));
        const note = c.note?.trim();
        build.requests.push({
          id: nextRequestId(requests),
          ...(kind ? { kind } : {}),
          block: c.block,
          ...(note ? { note } : {}),
          at: new Date().toISOString(),
          status: "queued",
        });
        const what = {
          write: "asked Claude to write a section",
          outline: "asked Claude to suggest an outline",
          next: "asked Claude to suggest the next section",
          subsections: "asked Claude to suggest subsections",
        }[kind ?? "write"];
        return this.save(id, build, "person", what, c.block);
      }
      if (c.op === "accept" || c.op === "dismiss" || c.op === "retitle") {
        const p = (build.proposals ?? []).find((x) => x.id === c.proposal && x.status === "proposed");
        if (!p) throw new HoopError(`build ${id} has no suggestion ${c.proposal} waiting`);
        if (c.op === "dismiss") {
          p.status = "dismissed";
          return this.save(id, build, "person", `dismissed the suggested section "${p.title}"`);
        }
        if (c.op === "retitle") {
          const title = c.title.replace(/\s+/g, " ").trim();
          if (!title) throw new HoopError("a suggested section needs a title; dismiss it instead");
          p.title = title;
          return this.save(id, build, "person", `edited the suggested section "${title}"`);
        }
        const block = place(build, p);
        return this.save(id, build, "person", `accepted the suggested section "${p.title}"`, block.id);
      }
      if (c.op === "accept_all") {
        const waiting = (build.proposals ?? []).filter((x) => x.request === c.request && x.status === "proposed");
        if (!waiting.length) throw new HoopError(`build ${id} has no suggestions waiting for ${c.request}`);
        for (const p of waiting) place(build, p);
        return this.save(id, build, "person", `accepted ${waiting.length} suggested ${waiting.length === 1 ? "section" : "sections"}`);
      }
      if (c.op === "undo") {
        const i = index(c.block);
        const before = build.undo?.[c.block];
        if (!before) throw new HoopError("there is nothing of Claude's to undo in this section");
        const [start, end] = sectionRange(build.blocks, i);
        build.blocks.splice(start, end - start, ...before);
        delete build.undo![c.block];
        return this.save(id, build, "person", "undid Claude's text", c.block);
      }
      throw new HoopError('expected op "add", "edit", "move", "remove", "generate", "suggest", "accept", "accept_all", "dismiss", "retitle" or "undo"');
    });
  }

  /** Takes the queued requests for Claude's session, each with its section and the document as they stand. */
  take(id: string): GenTask[] {
    return this.store.lock(id, () => {
      const build = this.read(id);
      const queued = (build.requests ?? []).filter((r) => r.status === "queued");
      if (!queued.length) return [];
      const at = new Date().toISOString();
      for (const r of queued) Object.assign(r, { status: "taken", taken_at: at });
      const writes = queued.filter((r) => !r.kind).length;
      const what =
        writes === queued.length
          ? writes === 1
            ? "started writing a section"
            : `started writing ${writes} sections`
          : queued.length === 1
            ? "started suggesting sections"
            : `started on ${queued.length} requests`;
      this.save(id, build, "claude", what);
      const markdown = joinBlocks(build);
      return queued.flatMap((r) => {
        const i = build.blocks.findIndex((b) => b.id === r.block);
        if (i < 0) return [];
        const [start, end] = sectionRange(build.blocks, i);
        const body = { lead: "", tail: "", blocks: build.blocks.slice(start, end) };
        const heading = build.blocks[i]!.text;
        const levels = r.kind ? { level: suggestionLevel(r.kind, levelOf(build.blocks[i]!)) } : {};
        return [
          {
            request: r.id,
            kind: r.kind ?? "write",
            section: r.block,
            heading,
            ...(r.note ? { note: r.note } : {}),
            section_markdown: joinBlocks(body),
            markdown,
            ...levels,
          },
        ];
      });
    });
  }

  /**
   * Claude's text for a section, after its heading, in place of what the section had; its blocks are
   * marked generated until the person edits them, and the section's old blocks are kept for Undo.
   * The text may start with the section's own heading, which is dropped, but holds no heading at the
   * section's level or above, so the outline stays the person's.
   */
  write(id: string, section: string, markdown: string): Build {
    return this.store.lock(id, () => {
      const build = this.read(id);
      const i = build.blocks.findIndex((b) => b.id === section);
      if (i < 0) throw new HoopError(`build ${id} has no block ${section}`);
      const heading = build.blocks[i]!;
      if (!writable(heading)) throw new HoopError(`block ${section} is not a section heading; write a section under its ## or ### heading`);
      const parts = splitBlocks(markdown.replace(/\r\n?/g, "\n")).blocks;
      if (parts[0] && levelOf(parts[0]) && parts[0].text.trim() === heading.text.trim()) parts.shift();
      if (!parts.length) throw new HoopError("the section needs text");
      const level = levelOf(heading);
      const over = parts.find((p) => levelOf(p) > 0 && levelOf(p) <= level);
      if (over) throw new HoopError(`a section's text can't hold a heading at its level or above ("${over.text}"); the person owns the outline`);
      const [start, end] = sectionRange(build.blocks, i);
      (build.undo ??= {})[section] = build.blocks.slice(start, end);
      const written: BuildBlock[] = parts.map((p, k) => ({
        id: `b${build.next++}`,
        kind: p.kind,
        text: p.text,
        ...(k + 1 < parts.length ? { sep: p.sep } : {}),
        by: "claude",
        generated: true,
      }));
      build.blocks.splice(start, end - start, ...written);
      const at = new Date().toISOString();
      for (const r of build.requests ?? [])
        if (r.block === section && !r.kind && r.status !== "written") Object.assign(r, { status: "written", written_at: at });
      return this.save(id, build, "claude", "wrote a section", section);
    });
  }

  /**
   * Claude's suggested headings for a suggestion request, in place of any it suggested before that
   * the person hasn't accepted or dismissed. They wait beside the document and change it only when
   * the person accepts them.
   */
  suggest(id: string, request: string, headings: SuggestedHeading[]): Build {
    return this.store.lock(id, () => {
      const build = this.read(id);
      const r = (build.requests ?? []).find((x) => x.id === request);
      if (!r) throw new HoopError(`build ${id} has no request ${request}`);
      if (!r.kind) throw new HoopError(`request ${request} asks for the section's text: write it with hoop_build_write`);
      const anchor = build.blocks.find((b) => b.id === r.block);
      if (!anchor) throw new HoopError(`the section request ${request} was on is gone`);
      if (!headings.length) throw new HoopError("suggest at least one heading");
      const top = suggestionLevel(r.kind, levelOf(anchor));
      let previous = top - 1;
      const parsed = headings.map(({ heading, note }) => {
        const text = heading.trim();
        const level = levelOf({ text });
        const title = headingText(text);
        if (!level || text.includes("\n") || !title)
          throw new HoopError(`each suggestion is one markdown heading, such as "${"#".repeat(top)} Costs" ("${heading}")`);
        if (level < top) throw new HoopError(`"${text}" is above where this was asked for: headings here start at level ${top} (${"#".repeat(top)})`);
        if (level > previous + 1)
          throw new HoopError(`"${text}" skips a level: the first heading is ${"#".repeat(top)}, and each is at most one level below the one before`);
        previous = level;
        const line = note?.replace(/\s+/g, " ").trim();
        return { level, title, ...(line ? { note: line } : {}) };
      });
      const proposals = (build.proposals ??= []);
      build.proposals = proposals.filter((p) => !(p.request === request && p.status === "proposed"));
      let n = Math.max(0, ...proposals.map((p) => Number(p.id.slice(1)) || 0));
      for (const p of parsed) build.proposals.push({ id: `p${++n}`, request, kind: r.kind, anchor: anchor.id, ...p, status: "proposed" });
      Object.assign(r, { status: "written", written_at: new Date().toISOString() });
      return this.save(id, build, "claude", `suggested ${parsed.length} ${parsed.length === 1 ? "section" : "sections"}`, anchor.id);
    });
  }
}

/**
 * Makes an accepted suggestion a heading block: after the nearest earlier suggestion of its request
 * already in the document, with that one's section; else before the nearest later one; else at the
 * end of what was asked about (the anchor's section, which the next section follows).
 */
function place(build: Build, p: Proposal): BuildBlock {
  const blocks = build.blocks;
  const siblings = (build.proposals ?? []).filter((x) => x.request === p.request);
  const k = siblings.indexOf(p);
  const at = (x: Proposal | undefined) => (x?.status === "accepted" ? blocks.findIndex((b) => b.id === x.block) : -1);
  const before = siblings
    .slice(0, k)
    .reverse()
    .map(at)
    .find((i) => i >= 0);
  const after = siblings
    .slice(k + 1)
    .map(at)
    .find((i) => i >= 0);
  const anchor = blocks.findIndex((b) => b.id === p.anchor);
  const where = before !== undefined ? unitRange(blocks, before)[1] : after !== undefined ? after : anchor >= 0 ? unitRange(blocks, anchor)[1] : blocks.length;
  const block: BuildBlock = { id: `b${build.next++}`, kind: kindOf(`${"#".repeat(p.level)} x`), text: `${"#".repeat(p.level)} ${p.title}`, by: "claude" };
  blocks.splice(where, 0, block);
  Object.assign(p, { status: "accepted", block: block.id });
  return block;
}

/** A heading block's text without its `#`s. */
export const headingText = (text: string) =>
  text
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/\s+#+\s*$/, "")
    .trim();

/** The build's title: its first `#` heading's text. */
export function titleOf(build: Pick<Build, "blocks">): string | undefined {
  const h1 = build.blocks.find((b) => b.kind === "h1");
  return (h1 && headingText(h1.text)) || undefined;
}
