// Claude's text for a section arrives as a draft beside it: nothing in the document changes until the
// person saves it, and discarding it leaves the section exactly as it was. A draft from Generate
// replaces everything under the heading when saved; one from Continue writing adds blocks after the
// heading's own last block, leaving the blocks already there byte-identical. These functions change a
// build in place; `Builds` saves each as a step.
import { sectionRange } from "../web/blocks.js";
import type { Build, BuildBlock } from "./build.js";
import { type BlockKind, levelOf } from "./build-blocks.js";
import { overtake, prune } from "./revise.js";
import { HoopError } from "./util.js";

/**
 * Claude's text for the section headed by `section`, waiting for the person to save or discard it.
 * `kind` "write" replaces the section's blocks; "continue" adds `blocks` after its own last block.
 * `request` is the request it answers, if any. A section holds one draft: a newer one replaces it.
 */
export type SectionDraft = { section: string; kind: "write" | "continue"; request?: string; blocks: BuildBlock[]; at: string };

/** A block of Claude's text as `splitBlocks` gives it. */
type Part = { kind: BlockKind; text: string; sep: string };

/**
 * The end of the heading's own blocks at `i`: up to its first subheading, or the end of its section.
 * A Continue writing's blocks go there.
 */
export function ownEnd(blocks: { text: string }[], i: number): number {
  const [start, end] = sectionRange(blocks, i);
  for (let k = start; k < end; k++) if (levelOf(blocks[k]!)) return k;
  return end;
}

/**
 * The new blocks of a Continue writing write: Claude may send only them, or the heading's own blocks
 * first, exactly as they are, then the new ones. A write that starts with the first of them but
 * changes one is refused, since the blocks already there stay byte-identical; so is one that repeats
 * a subheading already under the heading, since the new blocks go before its subheadings.
 */
export function continued(build: Build, i: number, parts: Part[]): Part[] {
  const own = build.blocks.slice(i + 1, ownEnd(build.blocks, i));
  const echoed = own.length > 0 && parts[0]?.text === own[0]!.text;
  const k = echoed ? own.findIndex((b, n) => parts[n]?.text !== b.text) : -1;
  if (k >= 0)
    throw new HoopError(
      `Continue writing keeps the blocks already under the heading byte-identical, but your text changes block ${own[k]!.id}; send only the blocks to add after them`,
    );
  const added = echoed ? parts.slice(own.length) : parts;
  const [start, end] = sectionRange(build.blocks, i);
  const there = new Set(
    build.blocks
      .slice(start, end)
      .filter((b) => levelOf(b))
      .map((b) => b.text.trim()),
  );
  const repeated = added.find((p) => levelOf(p) && there.has(p.text.trim()));
  if (repeated)
    throw new HoopError(
      `Continue writing adds blocks after the heading's own text, before its subheadings, but your text repeats the subheading "${repeated.text.trim()}"; send only the new blocks`,
    );
  return added;
}

/** Why the person can't ask for Continue writing on heading `section` now: Claude's draft there replaces everything under it. */
export function continueRefused(build: Build, section: string): string | undefined {
  const d = build.drafts?.find((x) => x.section === section);
  return d?.kind === "write"
    ? "Claude's draft under this heading replaces everything under it: save or discard it before asking Claude to continue writing"
    : undefined;
}

/** Puts Claude's draft beside the section, in place of one waiting there. */
export function addDraft(build: Build, draft: SectionDraft): void {
  build.drafts = [...(build.drafts ?? []).filter((d) => d.section !== draft.section), draft];
}

/** The draft waiting on heading `section`, or the refusal. */
function draftOf(build: Build, section: string): SectionDraft {
  const d = (build.drafts ?? []).find((x) => x.section === section);
  if (!d) throw new HoopError(`there is no draft of Claude's waiting under block ${section}`);
  return d;
}

/**
 * Saves Claude's draft into the document: a written section's blocks replace what was under the
 * heading, a continued one's go after the heading's own last block. Undo on the heading puts back
 * the section as it was before.
 */
export function saveDraft(build: Build, section: string): string {
  const d = draftOf(build, section);
  const i = build.blocks.findIndex((b) => b.id === section);
  if (i < 0) throw new HoopError(`the heading Claude's draft was for is gone`);
  const [start, end] = sectionRange(build.blocks, i);
  (build.undo ??= {})[section] = build.blocks.slice(start, end);
  if (d.kind === "continue") build.blocks.splice(ownEnd(build.blocks, i), 0, ...d.blocks);
  else
    overtake(
      build,
      build.blocks.splice(start, end - start, ...d.blocks).map((b) => b.id),
    );
  prune(build);
  build.drafts = build.drafts!.filter((x) => x !== d);
  return d.kind === "continue" ? "saved Claude's added text under a heading" : "saved Claude's draft under a heading";
}

/** A draft as the page showed it when the person chose to finish without it: its heading and its first block, whose ID no other draft takes. */
export type DraftSeen = { section: string; block: string };

/**
 * How many of Claude's drafts Finish leaves out, or the refusal: while a draft waits, unless the
 * person chose to finish without the drafts they saw (`shown`), and then while one waits that they
 * didn't see, as when Claude sent it while they were deciding.
 */
export function draftsLeftOut(build: Build, shown: DraftSeen[] | undefined): number {
  const drafts = build.drafts ?? [];
  const n = drafts.length;
  const them = n === 1 ? "it" : "them";
  if (n && !shown) throw new HoopError(`Claude's ${n} ${n === 1 ? "draft isn't" : "drafts aren't"} saved: save or discard ${them}, or finish without ${them}`);
  const unseen = drafts.some((d) => !shown?.some((s) => s.section === d.section && s.block === d.blocks[0]?.id));
  if (unseen) throw new HoopError("Claude sent a draft while you were deciding. Look at it, then finish again.");
  return n;
}

/** Throws Claude's draft away: the section stays exactly as it was. */
export function discardDraft(build: Build, section: string): string {
  const d = draftOf(build, section);
  build.drafts = build.drafts!.filter((x) => x !== d);
  return "discarded Claude's draft under a heading";
}

/** Drops the drafts whose heading is gone, or is no longer a section heading. */
export function pruneDrafts(build: Build): void {
  if (!build.drafts) return;
  const sections = new Set(build.blocks.filter((b) => levelOf(b) >= 2).map((b) => b.id));
  build.drafts = build.drafts.filter((d) => sections.has(d.section));
  if (!build.drafts.length) delete build.drafts;
}

/** What a request's task carries about a draft waiting on its section: the draft's markdown, which a refinement works from. */
export function draftTask(build: Build, section: string) {
  const d = build.drafts?.find((x) => x.section === section);
  if (!d) return {};
  const text = d.blocks.map((b, k) => b.text + (k + 1 < d.blocks.length ? b.sep || "\n\n" : "")).join("");
  return { draft_kind: d.kind, draft_markdown: text };
}

/**
 * The headings Generate all asks Claude to write: every section heading with nothing under it, no
 * request open on it and no draft waiting.
 */
export function emptySections(build: Build): string[] {
  const blocks = build.blocks;
  const asked = new Set((build.requests ?? []).filter((r) => r.status !== "written").map((r) => r.block));
  const drafted = new Set((build.drafts ?? []).map((d) => d.section));
  return blocks.filter((b, i) => levelOf(b) >= 2 && sectionRange(blocks, i)[1] === i + 1 && !asked.has(b.id) && !drafted.has(b.id)).map((b) => b.id);
}
