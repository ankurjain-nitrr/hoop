import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sectionRange, swapRange, unitRange } from "../web/blocks.js";
import { BLOCK_KINDS, type BlockKind, kindOf, levelOf, settleKinds, splitBlocks, underTitle } from "./build-blocks.js";
import {
  acceptChange,
  addComment,
  askRewrite,
  blockTask,
  nextRequestId,
  overtake,
  prune,
  replyInThread,
  resolveThread,
  splitInChange,
  threadTask,
  undoChange,
  writeBlock,
} from "./revise.js";
import type { Store } from "./store.js";
import { HoopError, readJson, writeAtomic, writeJson } from "./util.js";

/**
 * One block of a build. `id` never changes. `text` is the block's markdown as written; `sep` is the
 * exact text between it and the next block (a blank line unless the source had another).
 */
export type BuildBlock = { id: string; kind: BlockKind; text: string; sep?: string; by: "person" | "claude"; generated?: true };

/** One change to a build: who made it, when, and what it did to which block. */
type BuildStep = { n: number; at: string; by: string; what: string; block?: string };

/**
 * What the person asks Claude for: "write" a section's text, or suggest headings: an "outline" under
 * a title, the "next" section after the last one among its siblings, or "subsections" of a section;
 * or "rewrite" one block (Generate again on it), or "revise" it as their comment on it asks.
 */
const ASKS = ["write", "outline", "next", "subsections", "rewrite", "revise"] as const;
type Ask = (typeof ASKS)[number];
const SUGGESTIONS = ["outline", "next", "subsections"] as const;
export type Suggestion = (typeof SUGGESTIONS)[number];
/** The requests about one block rather than a section. */
type BlockAsk = "rewrite" | "revise";

/**
 * The person's request to Claude about the section headed by `block`: to write it, or (with `kind`)
 * to suggest headings; or about the block itself, to write it again or revise it as the comment in
 * `thread` asks. It is queued until Claude's session takes it (`hoop_build_wait`), then taken until
 * Claude writes the section, the block or its suggestions, or replies in the thread.
 */
export type GenRequest = {
  id: string;
  kind?: Suggestion | BlockAsk;
  block: string;
  note?: string;
  thread?: string;
  at: string;
  status: "queued" | "taken" | "written";
  /** For a rewrite Claude took: the block's ID and text as handed to Claude, so a late write can tell the person changed it. */
  given_block?: string;
  given?: string;
  /** Closed without Claude's text: the person edited, removed or undid the block first. */
  overtaken?: true;
  /** Closed because the person resolved the comment it came from. */
  resolved?: true;
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
type Proposal = {
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
  changes?: BlockChange[];
  threads?: BuildThread[];
};

/**
 * The person's comment on a block in Preview, with the words they selected, if any, and Claude's
 * replies. It stays beside the block, following it through Claude's rewrites, until the person
 * resolves it.
 */
export type BuildThread = {
  id: string;
  block: string;
  selection?: string;
  /** Which occurrence of `selection` in the block's shown text, from 0, when it occurs more than once. */
  occurrence?: number;
  /** The quoted words are gone from the block after Claude rewrote it. */
  outdated?: true;
  comment: string;
  at: string;
  request: string;
  status: "open" | "resolved";
  replies: { by: "claude" | "person"; body: string; at: string }[];
};

/**
 * Claude's rewrite of one block, waiting for the person to accept or undo it: the blocks it wrote,
 * and the block as it was before.
 */
type BlockChange = { id: string; request?: string; blocks: string[]; before: BuildBlock[] };

/** A section Claude can write: a section or subsection heading, not the title. */
const writable = (b: BuildBlock | undefined) => b !== undefined && levelOf(b) >= 2;

/** A build's markdown: its blocks' text in order, each followed by its separator, or a blank line when it has none. */
export function joinBlocks(build: { lead: string; tail: string; blocks: { text: string; sep?: string }[] }): string {
  const body = build.blocks.map((b, i) => b.text + (i + 1 < build.blocks.length ? b.sep || "\n\n" : "")).join("");
  return build.lead + body + build.tail;
}

/** The text a new block of each kind starts with. */
const STARTERS: Record<BlockKind, string> = {
  h1: "# Title",
  subtitle: "*Subtitle*",
  h2: "## New heading",
  h3: "### New heading",
  paragraph: "Write here.",
  list: "- First point\n- Second point",
  table: "| Column | Column |\n|---|---|\n| | |",
  code: "```\ncode\n```",
  diagram: "```mermaid\nflowchart LR\n  a[Start] --> b[End]\n```",
};

/** What the build's history says the person added, for each kind of block. */
const ADDED: Record<BlockKind, string> = {
  h1: "a title",
  subtitle: "a subtitle",
  h2: "a Heading 1",
  h3: "a Heading 2",
  paragraph: "a paragraph",
  list: "a list",
  table: "a table",
  code: "code",
  diagram: "a diagram",
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
  | { op: "undo"; block: string }
  | { op: "rewrite"; block: string; note?: string }
  | { op: "comment"; block: string; comment: string; selection?: string; occurrence?: number }
  | { op: "resolve"; thread: string }
  | { op: "accept_change"; block: string }
  | { op: "undo_change"; block: string };

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
  block?: string;
  block_markdown?: string;
  selection?: string;
  occurrence?: number;
  comment?: string;
  thread?: string;
};

/** Whether a request is about one block (Generate again, or a comment) rather than a section. */
const onBlock = (r: Pick<GenRequest, "kind">): r is GenRequest & { kind: BlockAsk } => r.kind === "rewrite" || r.kind === "revise";

/** One heading Claude suggests: its markdown (`## Costs`) and a line on what it covers. */
export type SuggestedHeading = { heading: string; note?: string };

/**
 * The level a suggestion's headings start at, which none goes above; each is at most one level
 * below the one before it. The next section is a sibling of the section it was asked on; an outline
 * or subsections sit under it.
 */
const suggestionLevel = (kind: Suggestion, anchorLevel: number) => (kind === "next" ? anchorLevel : anchorLevel + 1);

/** Whether block `i` takes a request of `kind`: an outline on a title, subsections on a section, the next section on a section that is last among its siblings. */
function asksOn(blocks: BuildBlock[], i: number, kind: Ask): string | undefined {
  const level = levelOf(blocks[i]!);
  if (kind === "outline") return level === 1 ? undefined : "Claude suggests an outline under the title: ask on the title";
  if (kind === "subsections") return level >= 2 && level < 6 ? undefined : "Claude suggests subheadings under a heading: ask on the heading";
  if (kind === "next") {
    if (level < 2) return "Claude suggests the next heading after a heading: ask on the heading";
    return swapRange(blocks, i, "down") ? "Claude suggests the next heading only after the last heading of its size" : undefined;
  }
  return writable(blocks[i]) ? undefined : "Claude writes everything under a heading: press Generate on the heading";
}

/** The refusal for a change the page sent that isn't one of the build's. */
export const EXPECTED_OP =
  'expected op "add", "edit", "move", "remove", "generate", "suggest", "accept", "accept_all", "dismiss", "retitle", "undo", "rewrite", "comment", "resolve", "accept_change" or "undo_change"';

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
    return readJson<Build>(this.path(id));
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
   * one new text.
   */
  save(id: string, build: Build, by: string, what: string, block?: string): Build {
    // A move, a removal or an edit can put a line of emphasis under the title or take it away.
    settleKinds(build.blocks);
    build.version += 1;
    build.steps.push({ n: build.version, at: new Date().toISOString(), by, what, ...(block ? { block } : {}) });
    const texts = join(this.store.dirOf(id), "blocks");
    mkdirSync(texts, { recursive: true });
    const refs = build.blocks.map(({ text, ...b }) => {
      const hash = createHash("sha256").update(text).digest("hex").slice(0, 32);
      if (!existsSync(join(texts, hash))) writeAtomic(join(texts, hash), text);
      return { ...b, hash };
    });
    writeJson(this.path(id, `build-${build.version}.json`), { lead: build.lead, tail: build.tail, blocks: refs }, { compact: true });
    writeJson(this.path(id), build);
    this.store.update(id, { title: titleOf(build) ?? this.store.meta(id).title });
    return build;
  }

  /** A build as it was after step `n`, from its snapshot. */
  at(id: string, n: number): Pick<Build, "lead" | "tail" | "blocks"> {
    const path = this.path(id, `build-${n}.json`);
    if (!existsSync(path)) throw new HoopError(`build ${id} has no step ${n}`);
    const snap = readJson<{ lead: string; tail: string; blocks: (Omit<BuildBlock, "text"> & { hash: string })[] }>(path);
    const texts = join(this.store.dirOf(id), "blocks");
    return { ...snap, blocks: snap.blocks.map(({ hash, ...b }) => ({ ...b, text: readFileSync(join(texts, hash), "utf8") })) };
  }

  /** Applies a person's change from the page. */
  change(id: string, c: BuildChange): Build {
    const build = this.read(id);
    const index = (block: string) => {
      const i = build.blocks.findIndex((b) => b.id === block);
      if (i < 0) throw new HoopError(`build ${id} has no block ${block}`);
      return i;
    };
    if (c.op === "add") {
      if (!BLOCK_KINDS.includes(c.kind)) throw new HoopError(`a block is one of ${BLOCK_KINDS.join(", ")}`);
      const at = c.after === undefined ? 0 : index(c.after) + 1;
      if (c.kind === "subtitle" && (!underTitle(build.blocks, at) || build.blocks[1]?.kind === "subtitle"))
        throw new HoopError("a subtitle goes right under the title, and a document has one");
      const block: BuildBlock = { id: `b${build.next++}`, kind: c.kind, text: STARTERS[c.kind], by: "person" };
      build.blocks.splice(at, 0, block);
      return this.save(id, build, "person", `added ${ADDED[c.kind]}`, block.id);
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
      // The person's text wins over a rewrite Claude hasn't sent yet, and a waiting change covers all of it.
      overtake(build, [old.id]);
      splitInChange(
        build,
        old.id,
        next.map((b) => b.id),
      );
      return this.save(id, build, "person", "edited a block", old.id);
    }
    if (c.op === "move") {
      const i = index(c.block);
      const other = swapRange(build.blocks, i, c.to);
      if (!other) return build;
      const mine = unitRange(build.blocks, i);
      const what = levelOf(build.blocks[i]!)
        ? `moved the heading "${headingText(build.blocks[i]!.text)}" ${c.to === "up" ? "before" : "after"} "${headingText(build.blocks[other[0]]!.text)}"`
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
        overtake(
          build,
          build.blocks.splice(i, 1).map((b) => b.id),
        );
        prune(build);
        return this.save(id, build, "person", "removed a block", c.block);
      }
      const [start, end] = c.section ? unitRange(build.blocks, i) : [i, i + 1];
      const gone = build.blocks.splice(start, end - start);
      overtake(
        build,
        gone.map((b) => b.id),
      );
      prune(build);
      for (const b of gone) delete build.undo?.[b.id];
      const what = c.section
        ? `removed the heading "${headingText(heading.text)}" and everything under it`
        : `removed the heading "${headingText(heading.text)}"`;
      return this.save(id, build, "person", what, c.block);
    }
    if (c.op === "generate" || c.op === "suggest") {
      const i = index(c.block);
      const kind = c.op === "generate" ? undefined : c.kind;
      if (kind !== undefined && !SUGGESTIONS.includes(kind)) throw new HoopError('a suggestion is "outline", "next" or "subsections"');
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
        write: "asked Claude to write under a heading",
        outline: "asked Claude to suggest an outline",
        next: "asked Claude to suggest the next heading",
        subsections: "asked Claude to suggest subheadings",
      }[kind ?? "write"];
      return this.save(id, build, "person", what, c.block);
    }
    if (c.op === "accept" || c.op === "dismiss" || c.op === "retitle") {
      const p = (build.proposals ?? []).find((x) => x.id === c.proposal && x.status === "proposed");
      if (!p) throw new HoopError(`build ${id} has no suggestion ${c.proposal} waiting`);
      if (c.op === "dismiss") {
        p.status = "dismissed";
        return this.save(id, build, "person", `dismissed the suggested heading "${p.title}"`);
      }
      if (c.op === "retitle") {
        const title = c.title.replace(/\s+/g, " ").trim();
        if (!title) throw new HoopError("a suggested heading needs words; dismiss it instead");
        p.title = title;
        return this.save(id, build, "person", `edited the suggested heading "${title}"`);
      }
      const block = place(build, p);
      return this.save(id, build, "person", `accepted the suggested heading "${p.title}"`, block.id);
    }
    if (c.op === "accept_all") {
      const waiting = (build.proposals ?? []).filter((x) => x.request === c.request && x.status === "proposed");
      if (!waiting.length) throw new HoopError(`build ${id} has no suggestions waiting for ${c.request}`);
      for (const p of waiting) place(build, p);
      return this.save(id, build, "person", `accepted ${waiting.length} suggested ${waiting.length === 1 ? "heading" : "headings"}`);
    }
    if (c.op === "undo") {
      const i = index(c.block);
      const before = build.undo?.[c.block];
      if (!before) throw new HoopError("there is nothing of Claude's to undo under this heading");
      const [start, end] = sectionRange(build.blocks, i);
      overtake(
        build,
        build.blocks.splice(start, end - start, ...before).map((b) => b.id),
      );
      prune(build);
      delete build.undo![c.block];
      return this.save(id, build, "person", "undid Claude's text", c.block);
    }
    if (c.op === "rewrite") return this.save(id, build, "person", askRewrite(build, c.block, c.note), c.block);
    if (c.op === "comment") return this.save(id, build, "person", addComment(build, id, c.block, c.comment, c.selection, c.occurrence), c.block);
    if (c.op === "resolve") {
      const what = resolveThread(build, c.thread);
      return what ? this.save(id, build, "person", what) : build;
    }
    if (c.op === "accept_change") return this.save(id, build, "person", acceptChange(build, c.block), c.block);
    if (c.op === "undo_change") return this.save(id, build, "person", undoChange(build, c.block), c.block);
    throw new HoopError(EXPECTED_OP);
  }

  /** Claude's reply in a comment's thread on a build. */
  reply(id: string, thread: string, body: string): Build {
    const build = this.read(id);
    return this.save(id, build, "claude", replyInThread(build, thread, body));
  }

  /** Claude's new text for one block, from a rewrite or revise request: it waits for the person to accept or undo it. */
  writeBlock(id: string, block: string, markdown: string, request?: string): Build {
    const build = this.read(id);
    const what = writeBlock(build, block, markdown, request);
    prune(build);
    return this.save(id, build, "claude", what, block);
  }

  /** Takes the queued requests for Claude's session, each with its section and the document as they stand. */
  take(id: string): GenTask[] {
    const build = this.read(id);
    const here = new Set(build.blocks.map((b) => b.id));
    // A request on a block that is gone closes, so it never waits as taken.
    for (const r of build.requests ?? []) if (r.status === "queued" && !here.has(r.block)) Object.assign(r, { status: "written", overtaken: true });
    const queued = (build.requests ?? []).filter((r) => r.status === "queued" && here.has(r.block));
    if (!queued.length) return [];
    const at = new Date().toISOString();
    for (const r of queued) Object.assign(r, { status: "taken", taken_at: at });
    for (const r of queued.filter(onBlock)) Object.assign(r, { given_block: r.block, given: build.blocks.find((b) => b.id === r.block)!.text });
    const writes = queued.filter((r) => !r.kind).length;
    const what =
      writes === queued.length
        ? writes === 1
          ? "started writing under a heading"
          : `started writing under ${writes} headings`
        : queued.length === 1
          ? onBlock(queued[0]!)
            ? "started on a block"
            : "started suggesting headings"
          : `started on ${queued.length} requests`;
    this.save(id, build, "claude", what);
    const markdown = joinBlocks(build);
    return queued.flatMap((r): GenTask[] => {
      const i = build.blocks.findIndex((b) => b.id === r.block);
      if (i < 0) return [];
      if (onBlock(r)) {
        const t = blockTask(build, r.block)!;
        const under = build.blocks.findIndex((b) => b.id === t.section);
        const [s, e] = under < 0 ? [0, build.blocks.length] : sectionRange(build.blocks, under);
        return [
          {
            request: r.id,
            kind: r.kind,
            section: t.section,
            heading: t.heading,
            block: r.block,
            block_markdown: t.block_markdown,
            ...(r.note ? { note: r.note } : {}),
            ...threadTask(build, r.thread),
            section_markdown: joinBlocks({ lead: "", tail: "", blocks: build.blocks.slice(s, e) }),
            markdown,
          },
        ];
      }
      const [start, end] = sectionRange(build.blocks, i);
      const body = { lead: "", tail: "", blocks: build.blocks.slice(start, end) };
      const heading = build.blocks[i]!.text;
      const levels = r.kind ? { level: suggestionLevel(r.kind as Suggestion, levelOf(build.blocks[i]!)) } : {};
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
  }

  /**
   * Claude's text for a section, after its heading, in place of what the section had; its blocks are
   * marked generated until the person edits them, and the section's old blocks are kept for Undo.
   * The text may start with the section's own heading, which is dropped, but holds no heading at the
   * section's level or above, so the outline stays the person's.
   */
  write(id: string, section: string, markdown: string): Build {
    const build = this.read(id);
    const i = build.blocks.findIndex((b) => b.id === section);
    if (i < 0) throw new HoopError(`build ${id} has no block ${section}`);
    const heading = build.blocks[i]!;
    const rewrite = (build.requests ?? []).find((r) => onBlock(r) && r.block === section && r.status === "taken");
    if (rewrite) throw new HoopError(`request ${rewrite.id} is a rewrite: pass block instead of section`);
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
    overtake(
      build,
      build.blocks.splice(start, end - start, ...written).map((b) => b.id),
    );
    prune(build);
    const at = new Date().toISOString();
    for (const r of build.requests ?? []) if (r.block === section && !r.kind && r.status !== "written") Object.assign(r, { status: "written", written_at: at });
    return this.save(id, build, "claude", "wrote under a heading", section);
  }

  /**
   * Claude's suggested headings for a suggestion request, in place of any it suggested before that
   * the person hasn't accepted or dismissed. They wait beside the document and change it only when
   * the person accepts them.
   */
  suggest(id: string, request: string, headings: SuggestedHeading[]): Build {
    const build = this.read(id);
    const r = (build.requests ?? []).find((x) => x.id === request);
    if (!r) throw new HoopError(`build ${id} has no request ${request}`);
    if (!r.kind) throw new HoopError(`request ${request} asks for the section's text: write it with hoop_build_write`);
    if (onBlock(r)) throw new HoopError(`request ${request} is about block ${r.block}: write it with hoop_build_write and block`);
    const kind = r.kind as Suggestion;
    const anchor = build.blocks.find((b) => b.id === r.block);
    if (!anchor) throw new HoopError(`the section request ${request} was on is gone`);
    if (!headings.length) throw new HoopError("suggest at least one heading");
    const top = suggestionLevel(kind, levelOf(anchor));
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
    for (const p of parsed) build.proposals.push({ id: `p${++n}`, request, kind, anchor: anchor.id, ...p, status: "proposed" });
    Object.assign(r, { status: "written", written_at: new Date().toISOString() });
    return this.save(id, build, "claude", `suggested ${parsed.length} ${parsed.length === 1 ? "heading" : "headings"}`, anchor.id);
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
function titleOf(build: Pick<Build, "blocks">): string | undefined {
  const h1 = build.blocks.find((b) => b.kind === "h1");
  return (h1 && headingText(h1.text)) || undefined;
}
