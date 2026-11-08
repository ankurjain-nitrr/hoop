import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sectionRange, swapRange, unitRange } from "../web/blocks.js";
import { BLOCK_KINDS, type BlockKind, kindOf, levelOf, settleKinds, splitBlocks, underTitle } from "./build-blocks.js";
import { addContext, type Brief, type ContextDoc, contextTask, markUnreadable, removeContext, setBrief, usedSources } from "./build-context.js";
import {
  addDraft,
  continued,
  continueRefused,
  discardDraft,
  draftTask,
  emptySections,
  ownEnd,
  pruneDrafts,
  type SectionDraft,
  saveDraft,
} from "./build-drafts.js";
import { forgetHistory, pruneHistory, record, refuseWaiting, restoreVersion, type SectionHistory, watch } from "./build-history.js";
import { addNote, type BuildNote, type Contradiction, checkContradiction, claudeBlocks, noteSection, pruneNotes, resolveNote } from "./build-notes.js";
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
import { HoopError, readJson, writeAtomic, writeJson, sha256 } from "./util.js";
import { keepSection, noteRemoval, type Removed, restoreRemoval } from "./build-removed.js";
import { waitedSince } from "./wait.js";

/**
 * One block of a build. `id` never changes. `text` is the block's markdown as written; `sep` is the
 * exact text between it and the next block (a blank line unless the source had another). `sources`
 * are the context documents Claude said it drew a block it wrote from, as their links or paths.
 */
export type BuildBlock = {
  id: string;
  kind: BlockKind;
  text: string;
  sep?: string;
  by: "person" | "claude";
  generated?: true;
  sources?: string[];
};

/** One change to a build: who made it, when, and what it did to which block. */
type BuildStep = { n: number; at: string; by: string; what: string; block?: string };

/**
 * What the person asks Claude for: "write" a section's text, or "continue" it with blocks after its
 * own last one; or suggest headings: an "outline" under a title, the "next" section after the last
 * one among its siblings, or "subsections" of a section; or "rewrite" one block (Generate again on
 * it), or "revise" it as their comment on it asks.
 */
const ASKS = ["write", "continue", "outline", "next", "subsections", "rewrite", "revise"] as const;
type Ask = (typeof ASKS)[number];
/** The one-press refinements Generate again offers, each a request with that instruction. */
const REFINES = ["shorter", "longer", "simpler", "more_detail"] as const;
type Refine = (typeof REFINES)[number];
const SUGGESTIONS = ["outline", "next", "subsections"] as const;
export type Suggestion = (typeof SUGGESTIONS)[number];
/** The requests about one block rather than a section. */
type BlockAsk = "rewrite" | "revise";

/**
 * The person's request to Claude about the section headed by `block`: to write it, or (with `kind`)
 * to suggest headings; or about the block itself, to write it again or revise it as the comment in
 * `thread` asks. It is queued until Claude's session takes it (`hoop_build_wait`), then taken until
 * Claude writes the section, the block or its suggestions, or replies in the thread. One taken but
 * not answered within `TAKEN_LIMIT_MS` is queued again (`retried`), keeping `taken_at`.
 */
export type GenRequest = {
  id: string;
  kind?: Suggestion | BlockAsk | "continue";
  block: string;
  note?: string;
  /** For Generate again: the refinement the person pressed (Shorter, Longer, Simpler or More detail). */
  refine?: Refine;
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
  /** Closed because the person withdrew it: a late answer from Claude is refused. */
  withdrawn?: true;
  /** How many times it went back to the queue because Claude didn't answer it in time. */
  retried?: number;
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
  /** Claude's section texts waiting for the person to save or discard them, one per heading. */
  drafts?: SectionDraft[];
  changes?: BlockChange[];
  threads?: BuildThread[];
  /** The documents Claude writes from, in the person's order, and the last document ID given. */
  context?: ContextDoc[];
  next_doc?: number;
  /** The next number for a change Claude makes waiting and for a note, so no ID comes back after one is dropped (freshId). */
  next_change?: number;
  next_note?: number;
  brief?: Brief;
  /** Each section's earlier versions, by its heading's block ID. */
  history?: Record<string, SectionHistory>;
  /** Claude's notes on text it wrote that contradicts other text it wrote. */
  notes?: BuildNote[];
  /** What the person's last change removed, which Undo puts back until the person makes another change. */
  removed?: Removed;
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
 * Claude's rewrite of one block, waiting for the person to save or discard it: the blocks it wrote,
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
  | { op: "remove"; block: string; section?: boolean; name?: string }
  | { op: "generate"; block: string; note?: string; refine?: string }
  | { op: "continue"; block: string; note?: string }
  | { op: "generate_all" }
  | { op: "save_draft"; block: string }
  | { op: "discard_draft"; block: string }
  | { op: "suggest"; block: string; kind: Suggestion; note?: string }
  | { op: "withdraw"; request: string }
  | { op: "accept"; proposal: string }
  | { op: "accept_all"; request: string }
  | { op: "dismiss"; proposal: string }
  | { op: "undo_dismiss"; proposal: string }
  | { op: "undo_remove" }
  | { op: "retitle"; proposal: string; title: string }
  | { op: "undo"; block: string }
  | { op: "rewrite"; block: string; note?: string; refine?: string }
  | { op: "comment"; block: string; comment: string; selection?: string; occurrence?: number }
  | { op: "resolve"; thread: string }
  | { op: "resolve_note"; note: string }
  | { op: "restore"; block: string; version: string }
  | { op: "accept_change"; block: string }
  | { op: "undo_change"; block: string }
  | { op: "context_add"; ref: string }
  | { op: "context_remove"; doc: string }
  | ({ op: "brief" } & Brief);

/**
 * A request as Claude's session receives it: what to do, the section, the person's note, and the
 * text around it, with the build's context documents and brief as they stand when Claude takes it. A
 * suggestion gives the heading level its headings start at.
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
  refine?: Refine;
  draft_kind?: SectionDraft["kind"];
  draft_markdown?: string;
} & ReturnType<typeof contextTask> &
  ReturnType<typeof claudeBlocks>;

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
  if (!writable(blocks[i])) return "Claude writes everything under a heading: press Generate on the heading";
  if (kind === "continue" && sectionRange(blocks, i)[1] === i + 1) return "There's nothing under this heading to continue yet: press Generate on it";
  return undefined;
}

/** The refusal for a change the page sent that isn't one of the build's. */
export const EXPECTED_OP =
  'expected op "add", "edit", "move", "remove", "generate", "continue", "generate_all", "save_draft", "discard_draft", "suggest", "withdraw", "accept", "accept_all", "dismiss", "undo_dismiss", "undo_remove", "retitle", "undo", "rewrite", "comment", "resolve", "resolve_note", "restore", "accept_change", "undo_change", "context_add", "context_remove" or "brief"';

/** A refinement as sent, checked: one of `REFINES`, or undefined when none was sent. */
function refineOf(refine: unknown): Refine | undefined {
  if (refine === undefined) return undefined;
  const r = REFINES.find((x) => x === refine);
  if (!r) throw new HoopError(`a refinement is one of ${REFINES.map((x) => `"${x}"`).join(", ")}`);
  return r;
}

/** What a person's change did, for the build's history, and the block it was on; nothing when it changed nothing. */
type Done = { what: string; block?: string } | undefined;
/** The build a change applies to: its ID, and the index of one of its blocks, which refuses a block it lacks. */
type ChangeAt = { id: string; index: (block: string) => number; removed?: Build["removed"] };
type Change<C extends BuildChange> = (build: Build, c: C, at: ChangeAt) => Done;

function addBlock(build: Build, c: Extract<BuildChange, { op: "add" }>, { index }: ChangeAt): Done {
  if (!BLOCK_KINDS.includes(c.kind)) throw new HoopError(`a block is one of ${BLOCK_KINDS.join(", ")}`);
  const at = c.after === undefined ? 0 : index(c.after) + 1;
  if (c.kind === "subtitle" && (!underTitle(build.blocks, at) || build.blocks[1]?.kind === "subtitle"))
    throw new HoopError("a subtitle goes right under the title, and a document has one");
  const block: BuildBlock = { id: `b${build.next++}`, kind: c.kind, text: STARTERS[c.kind], by: "person" };
  build.blocks.splice(at, 0, block);
  return { what: `added ${ADDED[c.kind]}`, block: block.id };
}

function editBlock(build: Build, c: Extract<BuildChange, { op: "edit" }>, { index }: ChangeAt): Done {
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
  if (next.length === 1 && next[0]!.text === old.text) return undefined;
  build.blocks.splice(i, 1, ...next.map(({ sep, ...b }) => (sep === undefined ? b : { ...b, sep })));
  // The person's text wins over a rewrite Claude hasn't sent yet, and a waiting change covers all of it.
  overtake(build, [old.id]);
  splitInChange(
    build,
    old.id,
    next.map((b) => b.id),
  );
  return { what: "edited a block", block: old.id };
}

function moveBlock(build: Build, c: Extract<BuildChange, { op: "move" }>, { index }: ChangeAt): Done {
  const i = index(c.block);
  const other = swapRange(build.blocks, i, c.to);
  if (!other) return undefined;
  const mine = unitRange(build.blocks, i);
  const what = levelOf(build.blocks[i]!)
    ? `moved the heading "${headingText(build.blocks[i]!.text)}" ${c.to === "up" ? "before" : "after"} "${headingText(build.blocks[other[0]]!.text)}"`
    : `moved a block ${c.to}`;
  // The earlier of the two goes after the later, each with its section.
  const [first, second] = c.to === "up" ? [other, mine] : [mine, other];
  build.blocks.splice(second[1] - (first[1] - first[0]), 0, ...build.blocks.splice(first[0], first[1] - first[0]));
  return { what, block: c.block };
}

function removeBlock(build: Build, c: Extract<BuildChange, { op: "remove" }>, { index }: ChangeAt): Done {
  const i = index(c.block);
  const heading = build.blocks[i]!;
  if (!levelOf(heading)) {
    // Undo puts back the block and what went with it.
    build.removed = noteRemoval(build, i, i + 1, c.name ?? "a block");
    const gone = build.blocks.splice(i, 1);
    overtake(
      build,
      gone.map((b) => b.id),
    );
    prune(build);
    return { what: "removed a block", block: c.block };
  }
  const [start, end] = c.section ? unitRange(build.blocks, i) : [i, i + 1];
  const named = `the heading "${headingText(heading.text)}"`;
  build.removed = noteRemoval(build, start, end, c.section ? `${named} and everything under it` : named);
  const gone = build.blocks.splice(start, end - start);
  overtake(
    build,
    gone.map((b) => b.id),
  );
  prune(build);
  for (const b of gone) delete build.undo?.[b.id];
  // The person removed these headings, so their histories go too.
  forgetHistory(
    build,
    gone.map((b) => b.id),
  );
  return { what: `removed ${build.removed.what}`, block: c.block };
}

/**
 * Undo, right after a removal: puts the blocks the person's last change removed back where they
 * were, with Claude's waiting rewrites and drafts, Save's Undo, earlier versions, notes and the
 * requests open on them (restoreRemoval).
 */
function undoRemove(build: Build, _c: BuildChange, { removed: r }: ChangeAt): Done {
  if (!r) throw new HoopError("there is nothing removed to put back");
  restoreRemoval(build, r);
  return { what: `put back ${r.what}`, block: r.blocks[0]!.id };
}

/** The requests the person makes on a heading, by kind ("write" for Generate). */
type HeadingAsk = "write" | "continue" | Suggestion;

/** What asking Claude for each kind of request says in the history. */
const ASKED: Record<HeadingAsk, string> = {
  write: "asked Claude to write under a heading",
  continue: "asked Claude to continue writing under a heading",
  outline: "asked Claude to suggest an outline",
  next: "asked Claude to suggest the next heading",
  subsections: "asked Claude to suggest subheadings",
};

/** The kind of request a Generate, Continue writing or Suggest makes: undefined for Generate. */
function askKind(c: Extract<BuildChange, { op: "generate" | "continue" | "suggest" }>): Exclude<HeadingAsk, "write"> | undefined {
  if (c.op === "generate") return undefined;
  if (c.op === "continue") return "continue";
  if (!SUGGESTIONS.includes(c.kind)) throw new HoopError('a suggestion is "outline", "next" or "subsections"');
  return c.kind;
}

/**
 * The kind a heading's request takes, given Claude's draft waiting there: Continue writing is refused
 * while a draft that replaces the section waits, and a refinement of a draft that adds to the
 * section's text refines that draft, so it stays a Continue writing.
 */
function withDraft(build: Build, c: Extract<BuildChange, { op: "generate" | "continue" | "suggest" }>, refine: Refine | undefined) {
  const kind = askKind(c);
  if (kind === "continue") {
    const refused = continueRefused(build, c.block);
    if (refused) throw new HoopError(refused);
  }
  const adds = build.drafts?.some((d) => d.section === c.block && d.kind === "continue");
  return refine && kind === undefined && adds ? "continue" : kind;
}

function askClaude(build: Build, c: Extract<BuildChange, { op: "generate" | "continue" | "suggest" }>, { index }: ChangeAt): Done {
  const i = index(c.block);
  const refine = c.op === "generate" ? refineOf(c.refine) : undefined;
  const kind = withDraft(build, c, refine);
  const refused = asksOn(build.blocks, i, kind ?? "write");
  if (refused) throw new HoopError(refused);
  const requests = (build.requests ??= []);
  // One request of a kind on a section at a time: the person withdraws it to ask again.
  if (requests.some((r) => r.block === c.block && r.kind === kind && r.status !== "written"))
    throw new HoopError("Claude already has this request on the heading; withdraw it to ask again");
  const note = c.note?.trim();
  requests.push({
    id: nextRequestId(requests),
    ...(kind ? { kind } : {}),
    block: c.block,
    ...(note ? { note } : {}),
    ...(refine ? { refine } : {}),
    at: new Date().toISOString(),
    status: "queued",
  });
  return { what: ASKED[kind ?? "write"], block: c.block };
}

/** Generate all, on the title: a Generate on every section with nothing under it, no request open and no draft waiting. */
function generateAll(build: Build): Done {
  const empty = emptySections(build);
  if (!empty.length) throw new HoopError("Every heading already has text, a draft or a request waiting.");
  const requests = (build.requests ??= []);
  const at = new Date().toISOString();
  for (const block of empty) requests.push({ id: nextRequestId(requests), block, at, status: "queued" });
  return { what: `asked Claude to write under ${empty.length} ${empty.length === 1 ? "heading" : "headings"}` };
}

/** What withdrawing each kind of request says in the history. */
const WITHDRAWN: Record<HeadingAsk, string> = {
  write: "withdrew a request to write under a heading",
  continue: "withdrew a request to continue writing under a heading",
  outline: "withdrew a request for an outline",
  next: "withdrew a request for the next heading",
  subsections: "withdrew a request for subheadings",
};

/**
 * The person withdraws a Generate or Suggest on a heading, queued or taken, which frees the heading for
 * a new one. One Claude already answered changes nothing.
 */
function withdrawRequest(build: Build, c: Extract<BuildChange, { op: "withdraw" }>, { id }: ChangeAt): Done {
  const r = (build.requests ?? []).find((x) => x.id === c.request);
  if (!r) throw new HoopError(`build ${id} has no request ${c.request}`);
  const kind = r.kind;
  if (kind === "rewrite" || kind === "revise") throw new HoopError("only a Generate or Suggest on a heading can be withdrawn");
  if (r.status === "written") return undefined;
  Object.assign(r, { status: "written", written_at: new Date().toISOString(), withdrawn: true });
  return { what: WITHDRAWN[kind ?? "write"], block: r.block };
}

/** Undo, after a suggested heading was dismissed: it waits to be accepted again. */
function undoDismiss(build: Build, c: Extract<BuildChange, { op: "undo_dismiss" }>, { id }: ChangeAt): Done {
  const p = (build.proposals ?? []).find((x) => x.id === c.proposal && x.status === "dismissed");
  if (!p) throw new HoopError(`build ${id} has no dismissed suggestion ${c.proposal}`);
  p.status = "proposed";
  return { what: `put back the suggested heading "${p.title}"` };
}

function answerProposal(build: Build, c: Extract<BuildChange, { op: "accept" | "dismiss" | "retitle" }>, { id }: ChangeAt): Done {
  const p = (build.proposals ?? []).find((x) => x.id === c.proposal && x.status === "proposed");
  if (!p) throw new HoopError(`build ${id} has no suggestion ${c.proposal} waiting`);
  if (c.op === "dismiss") {
    p.status = "dismissed";
    return { what: `dismissed the suggested heading "${p.title}"` };
  }
  if (c.op === "retitle") {
    const title = c.title.replace(/\s+/g, " ").trim();
    if (!title) throw new HoopError("a suggested heading needs words; dismiss it instead");
    p.title = title;
    return { what: `edited the suggested heading "${title}"` };
  }
  const block = place(build, p);
  return { what: `accepted the suggested heading "${p.title}"`, block: block.id };
}

function acceptAll(build: Build, c: Extract<BuildChange, { op: "accept_all" }>, { id }: ChangeAt): Done {
  const waiting = (build.proposals ?? []).filter((x) => x.request === c.request && x.status === "proposed");
  if (!waiting.length) throw new HoopError(`build ${id} has no suggestions waiting for ${c.request}`);
  for (const p of waiting) place(build, p);
  return { what: `accepted ${waiting.length} suggested ${waiting.length === 1 ? "heading" : "headings"}` };
}

function undoClaude(build: Build, c: Extract<BuildChange, { op: "undo" }>, { index }: ChangeAt): Done {
  const i = index(c.block);
  const before = build.undo?.[c.block];
  if (!before) throw new HoopError("there is nothing of Claude's to undo under this heading");
  refuseWaiting(build, i, true);
  const [start, end] = sectionRange(build.blocks, i);
  overtake(
    build,
    build.blocks.splice(start, end - start, ...before).map((b) => b.id),
  );
  prune(build);
  delete build.undo![c.block];
  return { what: "undid Claude's text", block: c.block };
}

/** Each change a person makes on the build page, by its op. */
const CHANGES: { [K in BuildChange["op"]]: Change<Extract<BuildChange, { op: K }>> } = {
  add: addBlock,
  edit: editBlock,
  move: moveBlock,
  remove: removeBlock,
  generate: askClaude,
  continue: askClaude,
  generate_all: (build) => generateAll(build),
  save_draft: (build, c, { index }) => {
    const i = index(c.block);
    // A draft that replaces the section would drop a draft waiting on a subheading in it.
    if (build.drafts?.find((d) => d.section === c.block)?.kind === "write") refuseWaiting(build, i, false);
    return { what: saveDraft(build, c.block), block: c.block };
  },
  discard_draft: (build, c) => ({ what: discardDraft(build, c.block), block: c.block }),
  suggest: askClaude,
  withdraw: withdrawRequest,
  accept: answerProposal,
  dismiss: answerProposal,
  undo_dismiss: undoDismiss,
  undo_remove: undoRemove,
  retitle: answerProposal,
  accept_all: acceptAll,
  undo: undoClaude,
  rewrite: (build, c) => ({ what: askRewrite(build, c.block, c.note, refineOf(c.refine)), block: c.block }),
  comment: (build, c, { id }) => ({ what: addComment(build, id, c.block, c.comment, c.selection, c.occurrence), block: c.block }),
  resolve: (build, c) => {
    const what = resolveThread(build, c.thread);
    return what ? { what } : undefined;
  },
  resolve_note: (build, c) => {
    const what = resolveNote(build, c.note);
    return what ? { what } : undefined;
  },
  restore: (build, c) => ({ what: restoreVersion(build, c.block, c.version), block: c.block }),
  accept_change: (build, c) => ({ what: acceptChange(build, c.block), block: c.block }),
  undo_change: (build, c) => ({ what: undoChange(build, c.block), block: c.block }),
  context_add: (build, c) => ({ what: addContext(build, c.ref) }),
  context_remove: (build, c) => ({ what: removeContext(build, c.doc) }),
  brief: (build, { op: _, ...fields }) => {
    const what = setBrief(build, fields);
    return what ? { what } : undefined;
  },
};

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
    // A draft whose heading is gone, or is no longer a section's, has nowhere to go; nor has its history.
    pruneDrafts(build);
    pruneHistory(build);
    pruneNotes(build);
    build.version += 1;
    build.steps.push({ n: build.version, at: new Date().toISOString(), by, what, ...(block ? { block } : {}) });
    const texts = join(this.store.dirOf(id), "blocks");
    mkdirSync(texts, { recursive: true });
    const refs = build.blocks.map(({ text, ...b }) => {
      const hash = sha256(text).slice(0, 32);
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
    if (!Object.hasOwn(CHANGES, c.op)) throw new HoopError(EXPECTED_OP);
    const apply = CHANGES[c.op] as Change<BuildChange>;
    const index = (block: string) => {
      const i = build.blocks.findIndex((b) => b.id === block);
      if (i < 0) throw new HoopError(`build ${id} has no block ${block}`);
      return i;
    };
    // A change to a section's saved text keeps the text it replaces as a version.
    const watched = watch(build, c);
    // Undo puts back only what the person's last change removed, so any change forgets it.
    const removed = build.removed;
    delete build.removed;
    const done = apply(build, c, { id, index, removed });
    // A removal's Undo takes back the version it gives its section, too.
    if (c.op === "remove" && watched && build.removed) keepSection(build.removed, build, watched.section);
    if (done) record(build, watched);
    return done ? this.save(id, build, "person", done.what, done.block) : build;
  }

  /** Claude's reply in a comment's thread on a build. */
  reply(id: string, thread: string, body: string): Build {
    const build = this.read(id);
    return this.save(id, build, "claude", replyInThread(build, thread, body));
  }

  /**
   * Claude's new text for one block, from a rewrite or revise request: it waits for the person to save
   * or discard it. `contradicts` names another block Claude wrote that the new text contradicts.
   */
  writeBlock(id: string, block: string, markdown: string, request?: string, used?: string[], contradicts?: Contradiction): Build {
    const build = this.read(id);
    const note = checkContradiction(build, contradicts, [block]);
    const i = build.blocks.findIndex((b) => b.id === block);
    const what = writeBlock(build, block, markdown, request, usedSources(build, used));
    if (note) {
      const first = build.blocks[i]!.id;
      addNote(build, noteSection(build.blocks, i, first), first, note);
    }
    prune(build);
    return this.save(id, build, "claude", what, block);
  }

  /** Claude couldn't open one of the build's context documents, for `reason`. */
  unreadable(id: string, doc: string, reason: string): Build {
    const build = this.read(id);
    return this.save(id, build, "claude", markUnreadable(build, doc, reason));
  }

  /**
   * Takes the queued requests for Claude's session, each with its section and the document as they
   * stand, after queueing again those it took but hasn't answered in time (`requeue`).
   */
  take(id: string, now = Date.now()): GenTask[] {
    const build = this.read(id);
    requeue(build, now);
    const here = new Set(build.blocks.map((b) => b.id));
    // A request on a block that is gone closes, so it never waits as taken.
    for (const r of build.requests ?? []) if (r.status === "queued" && !here.has(r.block)) Object.assign(r, { status: "written", overtaken: true });
    const queued = (build.requests ?? []).filter((r) => r.status === "queued" && here.has(r.block));
    if (!queued.length) return [];
    const at = new Date(now).toISOString();
    for (const r of queued) Object.assign(r, { status: "taken", taken_at: at });
    for (const r of queued.filter(onBlock)) Object.assign(r, { given_block: r.block, given: build.blocks.find((b) => b.id === r.block)!.text });
    this.save(id, build, "claude", startedLine(queued));
    const around = { markdown: joinBlocks(build), ...contextTask(build), ...claudeBlocks(build) };
    return queued.flatMap((r): GenTask[] => {
      const i = build.blocks.findIndex((b) => b.id === r.block);
      if (i < 0) return [];
      return [{ ...(onBlock(r) ? blockRequestTask(build, r) : headingRequestTask(build, r, i)), ...around }];
    });
  }

  /**
   * Claude's text for a section, after its heading, as a draft beside it: nothing in the document
   * changes until the person saves it. For a Generate it replaces what the section has when saved;
   * for a Continue writing (`request`, or the one Claude took on the section) it adds blocks after
   * the heading's own last block, which stay byte-identical. Its blocks are marked generated until
   * the person edits them. The text may start with the section's own heading, which is dropped, but
   * holds no heading at the section's level or above, so the outline stays the person's. `used`
   * names the context documents Claude drew it from, and `contradicts` another block Claude wrote
   * that this text contradicts.
   */
  write(id: string, section: string, markdown: string, used?: string[], request?: string, contradicts?: Contradiction): Build {
    const build = this.read(id);
    const i = build.blocks.findIndex((b) => b.id === section);
    if (i < 0) throw new HoopError(`build ${id} has no block ${section}`);
    const heading = build.blocks[i]!;
    const rewrite = (build.requests ?? []).find((r) => onBlock(r) && r.block === section && r.status === "taken");
    if (rewrite) throw new HoopError(`request ${rewrite.id} is a rewrite: pass block instead of section`);
    const answers = sectionRequest(build, section, request);
    const withdrawn = request === undefined ? withdrawnWrite(build, section) : undefined;
    // Only the late answer: once Claude's session waits on the build again, it writes the section freely.
    if (withdrawn && !waitedSince(this.store.home, id, withdrawn.written_at!))
      throw new HoopError(`the person withdrew request ${withdrawn.id} after you took it, so their text stays; call hoop_build_wait again`);
    if (!writable(heading)) throw new HoopError(`block ${section} is not a section heading; write a section under its ## or ### heading`);
    const kind = answers?.kind === "continue" ? "continue" : "write";
    const note = checkContradiction(build, contradicts, replacedBy(build, i, kind));
    const parts = draftParts(build, i, markdown, kind);
    const sources = usedSources(build, used);
    const blocks: BuildBlock[] = parts.map((p, k) => ({
      id: `b${build.next++}`,
      kind: p.kind,
      text: p.text,
      ...(k + 1 < parts.length ? { sep: p.sep } : {}),
      by: "claude",
      generated: true,
      ...(sources ? { sources } : {}),
    }));
    const at = new Date().toISOString();
    addDraft(build, { section, kind, ...(answers ? { request: answers.id } : {}), blocks, at });
    addNote(build, section, blocks[0]!.id, note);
    // The draft answers its request, and a Generate's answers every open Generate on the heading.
    const answered = (r: GenRequest) => r === answers || (kind === "write" && r.block === section && !r.kind);
    for (const r of build.requests ?? []) if (r.status !== "written" && answered(r)) Object.assign(r, { status: "written", written_at: at });
    return this.save(id, build, "claude", kind === "continue" ? "drafted more text under a heading" : "drafted the text under a heading", section);
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
    if (r.withdrawn) throw new HoopError(`the person withdrew request ${request}, so it is closed; call hoop_build_wait again`);
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
  const where = placeAt(blocks, before, after, anchor);
  const block: BuildBlock = { id: `b${build.next++}`, kind: kindOf(`${"#".repeat(p.level)} x`), text: `${"#".repeat(p.level)} ${p.title}`, by: "claude" };
  blocks.splice(where, 0, block);
  Object.assign(p, { status: "accepted", block: block.id });
  return block;
}

/** Where `place` puts a heading: after the earlier accepted one's section, before the later one, or after the anchor's section. */
function placeAt(blocks: BuildBlock[], before: number | undefined, after: number | undefined, anchor: number): number {
  if (before !== undefined) return unitRange(blocks, before)[1];
  if (after !== undefined) return after;
  return anchor >= 0 ? unitRange(blocks, anchor)[1] : blocks.length;
}

/** How long a request Claude took may go unanswered before it is queued again. */
export const TAKEN_LIMIT_MS = 10 * 60_000;

/**
 * Queues again each request Claude took but hasn't answered within `TAKEN_LIMIT_MS` of `now`, as
 * when the call that took it never reached Claude, and returns them. The build page and the Stop
 * gate read a build through this too, so a stuck request shows as queued before Claude takes it again.
 */
export function requeue(build: Build, now = Date.now()): GenRequest[] {
  const stale = (build.requests ?? []).filter((r) => r.status === "taken" && r.taken_at && now - Date.parse(r.taken_at) >= TAKEN_LIMIT_MS);
  for (const r of stale) Object.assign(r, { status: "queued", retried: (r.retried ?? 0) + 1 });
  return stale;
}

/**
 * The withdrawn request a write of `section` would answer, if any: when no open Generate on it was
 * ever taken, the last one Claude took there, if the person withdrew it. A write then can't answer
 * a newer request, which Claude hasn't seen.
 */
function withdrawnWrite(build: Build, section: string): GenRequest | undefined {
  const writes = (build.requests ?? []).filter((r) => writesSection(r, section));
  if (writes.some((r) => r.status !== "written" && r.taken_at)) return undefined;
  const last = writes.reverse().find((r) => r.taken_at);
  return last?.withdrawn ? last : undefined;
}

/** What the person asked with a request, beyond its kind: their note and the refinement they pressed. */
const askedWith = (r: GenRequest) => ({ ...(r.note ? { note: r.note } : {}), ...(r.refine ? { refine: r.refine } : {}) });

/** A block request's task: the block, its text, the section it sits in, and the comment it came from. */
function blockRequestTask(build: Build, r: GenRequest & { kind: BlockAsk }): Omit<GenTask, "markdown"> {
  const t = blockTask(build, r.block)!;
  const under = build.blocks.findIndex((b) => b.id === t.section);
  const [s, e] = under < 0 ? [0, build.blocks.length] : sectionRange(build.blocks, under);
  return {
    request: r.id,
    kind: r.kind,
    section: t.section,
    heading: t.heading,
    block: r.block,
    block_markdown: t.block_markdown,
    ...askedWith(r),
    ...threadTask(build, r.thread),
    section_markdown: joinBlocks({ lead: "", tail: "", blocks: build.blocks.slice(s, e) }),
  };
}

/**
 * A heading request's task: the section's text (for Continue writing, only the heading's own text,
 * which the new blocks follow, before its subheadings), the level a suggestion starts at, and
 * Claude's draft waiting there.
 */
function headingRequestTask(build: Build, r: GenRequest, i: number): Omit<GenTask, "markdown"> {
  const [start, end] = r.kind === "continue" ? [i + 1, ownEnd(build.blocks, i)] : sectionRange(build.blocks, i);
  const writes = !r.kind || r.kind === "continue";
  return {
    request: r.id,
    kind: r.kind ?? "write",
    section: r.block,
    heading: build.blocks[i]!.text,
    ...askedWith(r),
    section_markdown: joinBlocks({ lead: "", tail: "", blocks: build.blocks.slice(start, end) }),
    ...(writes ? draftTask(build, r.block) : { level: suggestionLevel(r.kind as Suggestion, levelOf(build.blocks[i]!)) }),
  };
}

/**
 * The blocks of Claude's text for the section headed at `i`, or the refusal: without the section's
 * own heading when it repeats it, for a Continue writing only the blocks to add, and never a heading
 * at the section's level or above.
 */
function draftParts(build: Build, i: number, markdown: string, kind: SectionDraft["kind"]) {
  const heading = build.blocks[i]!;
  let parts = splitBlocks(markdown.replace(/\r\n?/g, "\n")).blocks;
  if (parts[0] && levelOf(parts[0]) && parts[0].text.trim() === heading.text.trim()) parts.shift();
  if (kind === "continue") parts = continued(build, i, parts);
  if (!parts.length) throw new HoopError(kind === "continue" ? "Continue writing needs blocks to add after the ones there" : "the section needs text");
  const over = parts.find((p) => levelOf(p) > 0 && levelOf(p) <= levelOf(heading));
  if (over) throw new HoopError(`a section's text can't hold a heading at its level or above ("${over.text}"); the person owns the outline`);
  return parts;
}

/** The blocks a section write's draft replaces when saved: everything under the heading at `i` for a Generate, none for a Continue writing. */
function replacedBy(build: Build, i: number, kind: SectionDraft["kind"]): string[] {
  const [start, end] = sectionRange(build.blocks, i);
  return kind === "write" ? build.blocks.slice(start, end).map((b) => b.id) : [];
}

/** Whether a request asks Claude to write under heading `section`: a Generate or a Continue writing. */
const writesSection = (r: GenRequest, section: string) => r.block === section && (!r.kind || r.kind === "continue");

/**
 * The request a write of `section` answers: `request` when Claude names it, else the Generate or
 * Continue writing Claude took there, if any. Refuses a request that isn't one on the section, one
 * the person withdrew, and a choice between a Generate and a Continue writing both taken.
 */
function sectionRequest(build: Build, section: string, request: string | undefined): GenRequest | undefined {
  const requests = build.requests ?? [];
  if (request !== undefined) {
    const r = requests.find((x) => x.id === request);
    if (!r || !writesSection(r, section)) throw new HoopError(`request ${request} isn't a Generate or Continue writing on block ${section}`);
    if (r.withdrawn) throw new HoopError(`the person withdrew request ${request}, so it is closed; call hoop_build_wait again`);
    return r;
  }
  const taken = requests.filter((r) => writesSection(r, section) && r.status === "taken");
  if (new Set(taken.map((r) => r.kind ?? "write")).size > 1)
    throw new HoopError(`requests ${taken.map((r) => r.id).join(" and ")} are both taken on block ${section}: pass request to say which this answers`);
  return taken[0];
}

/** What Claude's session taking requests says in the build's history. */
function startedLine(queued: GenRequest[]): string {
  const writes = queued.filter((r) => !r.kind).length;
  if (writes === queued.length) return writes === 1 ? "started writing under a heading" : `started writing under ${writes} headings`;
  if (queued.length > 1) return `started on ${queued.length} requests`;
  if (queued[0]!.kind === "continue") return "started continuing a heading";
  return onBlock(queued[0]!) ? "started on a block" : "started suggesting headings";
}

/** A heading block's text without its `#`s, and without a closing run of `#`s after a space. */
export function headingText(text: string): string {
  const s = text.replace(/^\s{0,3}#{1,6}\s*/, "").trimEnd();
  let end = s.length;
  while (end > 0 && s[end - 1] === "#") end--;
  return (end < s.length && /\s/.test(s[end - 1] ?? "") ? s.slice(0, end) : s).trim();
}

/** The build's title: its first `#` heading's text. */
function titleOf(build: Pick<Build, "blocks">): string | undefined {
  const h1 = build.blocks.find((b) => b.kind === "h1");
  return (h1 && headingText(h1.text)) || undefined;
}
