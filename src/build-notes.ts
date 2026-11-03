// Claude's contradiction notes on a build: when Claude writes text that contradicts other text it
// wrote, it names that block with a one-line note. The note sits with the section Claude wrote,
// naming both places, until the person resolves it. Claude flags only its own text, so a note never
// names a block the person wrote or edited, and it never asks for an edit. These functions change a
// build in place; `Builds` saves each as a step.
import { parentOf } from "../web/blocks.js";
import type { Build, BuildBlock } from "./build.js";
import { levelOf } from "./build-blocks.js";
import { HoopError } from "./util.js";
import { freshId } from "./build-removed.js";

/** What Claude's write says it contradicts: another block Claude wrote, and why, in one line. */
export type Contradiction = { block: string; note: string };

/**
 * A contradiction note: on the section heading (or, for a block under no section, the block) that
 * holds Claude's new text, whose first block is `with`; naming the other block, `block`.
 */
export type BuildNote = { id: string; section: string; with: string; block: string; note: string; at: string; status: "open" | "resolved" };

/** The longest note. */
const NOTE_MAX = 500;

/**
 * Whether a block is text Claude wrote with `hoop_build_write` and the person hasn't edited: not a
 * heading, nor the title and notes a build starts with, which are the person's words.
 */
const ownText = (b: BuildBlock) => b.by === "claude" && b.generated === true && !levelOf(b);

/**
 * A contradiction a write names, checked before the write changes anything: the other block must be
 * one of Claude's blocks of text in the document, and not one the write replaces (`replaced`).
 */
export function checkContradiction(build: Build, c: Contradiction | undefined, replaced: string[]): Contradiction | undefined {
  if (!c) return undefined;
  const other = build.blocks.find((b) => b.id === c.block);
  if (!other) throw new HoopError(`the build has no block ${c.block}; name a block you wrote, from the request's claude_blocks`);
  if (!ownText(other))
    throw new HoopError(
      `block ${c.block} isn't text you wrote (the person wrote or edited it, or you didn't write it with hoop_build_write): flag only your own text`,
    );
  if (replaced.includes(c.block)) throw new HoopError(`block ${c.block} is text this write replaces; name another block you wrote`);
  const note = c.note.replace(/\s+/g, " ").trim();
  if (!note) throw new HoopError("say in one line what contradicts what");
  if (note.length > NOTE_MAX) throw new HoopError(`a contradiction note is at most ${NOTE_MAX} characters`);
  return { block: c.block, note };
}

/** Puts Claude's note on `section`, about its new text starting at block `first`; nothing when the write names no contradiction. */
export function addNote(build: Build, section: string, first: string, c: Contradiction | undefined): void {
  if (!c) return;
  const notes = (build.notes ??= []);
  notes.push({ id: freshId(build, "n"), section, with: first, block: c.block, note: c.note, at: new Date().toISOString(), status: "open" });
}

/** The heading a rewrite of the block at `i` is under, which its note sits with; the block itself when it is under none. */
export function noteSection(blocks: BuildBlock[], i: number, first: string): string {
  const p = parentOf(blocks, i);
  return p >= 0 ? blocks[p]!.id : first;
}

/** The person resolves a note: it leaves the page. Resolving it again changes nothing (undefined). */
export function resolveNote(build: Build, note: string): string | undefined {
  const n = (build.notes ?? []).find((x) => x.id === note);
  if (!n) throw new HoopError(`the build has no note ${note}`);
  if (n.status === "resolved") return undefined;
  n.status = "resolved";
  return "resolved Claude's note on a contradiction";
}

/**
 * Drops each open note whose text is gone: its section heading, the other block, or Claude's text
 * (in the document, or in a draft still waiting), as when the person discarded the draft.
 */
export function pruneNotes(build: Build): void {
  if (!build.notes) return;
  const here = new Set([...build.blocks, ...(build.drafts ?? []).flatMap((d) => d.blocks)].map((b) => b.id));
  build.notes = build.notes.filter((n) => n.status === "resolved" || (here.has(n.section) && here.has(n.with) && here.has(n.block)));
  if (!build.notes.length) delete build.notes;
}

/** What every request carries so Claude can name its own text in a note: each block of text Claude wrote, its heading, and how it starts. */
export function claudeBlocks(build: Build) {
  const list = build.blocks.flatMap((b, i) => {
    if (!ownText(b)) return [];
    const line = b.text.replace(/\s+/g, " ").trim();
    const p = parentOf(build.blocks, i);
    return [{ block: b.id, heading: p >= 0 ? build.blocks[p]!.text : "", starts: line.length > 80 ? `${line.slice(0, 79)}…` : line }];
  });
  return list.length ? { claude_blocks: list } : {};
}
