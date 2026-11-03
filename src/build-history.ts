// Each section of a build keeps its earlier versions: the text under its heading before Claude's
// draft or rewrite was saved, before the person's edits, and before Undo or a restore. A draft or a
// rewrite waiting to be saved is never a version. The person steps through them on the page, sees
// what changed since, and saves one back: it becomes the text under the heading, and the text it
// replaces stays as a version. A heading's history is kept by its block ID while the heading is away
// because a change around it replaced it, and is there again when it comes back; only the person
// removing the heading, or making it no longer a section's, forgets it. These functions change a
// build in place; `Builds` saves each as a step.
import { parentOf, sectionRange } from "../web/blocks.js";
import type { Build, BuildBlock, BuildChange } from "./build.js";
import { levelOf } from "./build-blocks.js";
import { overtake, prune } from "./revise.js";
import { HoopError } from "./util.js";

/** The most versions a section keeps: the oldest goes when a newer one would make more. */
export const VERSIONS_MAX = 20;
/** The most histories a build keeps of headings not in the document now: the ones least recently changed go first. */
const ABSENT_MAX = 50;
/** The person's edits to a section within this long of their last one, with nothing else between, are one version. */
const EDITS_JOIN_MS = 10 * 60_000;

/** How a section's text came to be: Claude's saved draft or rewrite, or the person's edits, and when. */
type Made = { by: "claude" | "person"; how: "generated" | "continued" | "rewrote" | "edited"; at: string };

/** An earlier text of a section: its blocks, how it came to be (unknown for the text a build started with), and when it was replaced. */
type SectionVersion = { id: string; blocks: BuildBlock[]; replaced: string } & Partial<Made>;

/**
 * A section's versions, oldest first, and how its current text came to be; `restored` when it was
 * saved back from a version. `away` is the text under the heading when a change around it took it
 * out of the document, until it comes back.
 */
export type SectionHistory = { next: number; current?: Made & { restored?: string }; versions: SectionVersion[]; away?: BuildBlock[] };

const isSection = (b: { text: string } | undefined) => b !== undefined && levelOf(b) >= 2;
const indexOf = (build: Build, id: string) => build.blocks.findIndex((b) => b.id === id);

/** The section heading that holds the block at `i`, if any. */
function sectionOf(build: Build, i: number): string | undefined {
  const p = i < 0 ? -1 : parentOf(build.blocks, i);
  return p >= 0 && isSection(build.blocks[p]) ? build.blocks[p]!.id : undefined;
}

/**
 * The saved text under heading `section`: its blocks, with each of Claude's rewrites still waiting
 * shown as the blocks it would replace. Undefined when the heading is gone.
 */
function savedText(build: Build, section: string): BuildBlock[] | undefined {
  const i = indexOf(build, section);
  if (i < 0) return undefined;
  const [start, end] = sectionRange(build.blocks, i);
  const out: BuildBlock[] = [];
  const shown = new Set<string>();
  for (const b of build.blocks.slice(start, end)) {
    const c = (build.changes ?? []).find((x) => x.blocks.includes(b.id));
    if (!c) out.push(b);
    else if (!shown.has(c.id)) {
      shown.add(c.id);
      out.push(...c.before);
    }
  }
  return out;
}

const sameText = (a: BuildBlock[], b: BuildBlock[]) => a.length === b.length && a.every((x, k) => x.text === b[k]!.text);

/** A change the person is making that may make a version: the section, its saved text before, and how its new text comes to be ("back" for Undo). */
export type Watch = { section: string; before: BuildBlock[]; made: Made | "back" };

const now = () => new Date().toISOString();
const edited = (): Made => ({ by: "person", how: "edited", at: now() });

/** The section a person's edit, move or removal of `block` changes: its section, unless it is a heading. */
function editedSection(build: Build, block: string): string | undefined {
  const i = indexOf(build, block);
  return i < 0 || levelOf(build.blocks[i]!) ? undefined : sectionOf(build, i);
}

/** The section a change acts on, if any, and how its new text comes to be. */
type Seen = [string | undefined, Made | "back"] | undefined;

/** Saving Claude's draft: its heading, and how Claude made it. */
function drafted(build: Build, section: string): Seen {
  const d = build.drafts?.find((x) => x.section === section);
  return d && [section, { by: "claude", how: d.kind === "continue" ? "continued" : "generated", at: d.at }];
}

/** Saving Claude's rewrite of `block`: the section its blocks are in. */
function rewrote(build: Build, block: string): Seen {
  const change = build.changes?.find((x) => x.blocks.includes(block));
  const first = change?.blocks.map((id) => indexOf(build, id)).find((i) => i >= 0);
  return first === undefined ? undefined : [sectionOf(build, first), { by: "claude", how: "rewrote", at: now() }];
}

/** A block the person adds: after a heading it starts that heading's text, after a block it joins its section. A heading makes no version. */
function added(build: Build, c: Extract<BuildChange, { op: "add" }>): Seen {
  const i = c.after === undefined ? -1 : indexOf(build, c.after);
  if (["h1", "h2", "h3"].includes(c.kind) || i < 0) return undefined;
  return [isSection(build.blocks[i]) ? c.after : sectionOf(build, i), edited()];
}

/** For a change that can make a version: the section it changes, and how its new text comes to be. */
function seen(build: Build, c: BuildChange): Seen {
  switch (c.op) {
    case "save_draft":
      return drafted(build, c.block);
    case "accept_change":
      return rewrote(build, c.block);
    case "undo":
      return [c.block, "back"];
    case "edit":
    case "move":
    case "remove":
      return [editedSection(build, c.block), edited()];
    case "add":
      return added(build, c);
    default:
      return undefined;
  }
}

/** What a person's change would make a version of, read before the change applies; undefined when it makes none. */
export function watch(build: Build, c: BuildChange): Watch | undefined {
  const [section, made] = seen(build, c) ?? [];
  const before = section === undefined ? undefined : savedText(build, section);
  return before && made && { section: section!, before, made };
}

function historyOf(build: Build, section: string): SectionHistory {
  build.history ??= {};
  return (build.history[section] ??= { next: 0, versions: [] });
}

/**
 * Keeps `blocks` as the section's newest version, with how its text came to be, dropping the oldest
 * past `VERSIONS_MAX`, and returns it. A heading with nothing under it has no text to keep.
 */
function keep(h: SectionHistory, blocks: BuildBlock[]): SectionVersion | undefined {
  if (!blocks.length) return undefined;
  const { restored: _, ...made } = h.current ?? {};
  const v: SectionVersion = { id: `v${++h.next}`, blocks, replaced: now(), ...made };
  h.versions.push(v);
  if (h.versions.length > VERSIONS_MAX) h.versions.splice(0, h.versions.length - VERSIONS_MAX);
  return v;
}

/** Whether a person's edit joins the version their last edit made: within `EDITS_JOIN_MS`, with nothing else between. */
function joins(current: SectionHistory["current"], made: Made): boolean {
  if (made.by !== "person" || current?.by !== "person" || current.how !== "edited" || current.restored) return false;
  return Date.parse(made.at) - Date.parse(current.at) < EDITS_JOIN_MS;
}

/**
 * After the text under a heading was replaced (`before` was its text), its subheadings' histories
 * follow, made as `made` says. One still in the document keeps its replaced text as a version; one
 * that left keeps the text it had (`away`); one that came back with other text than it left with
 * keeps that text as a version.
 */
function subVersions(build: Build, before: BuildBlock[], made: SectionHistory["current"]): void {
  before.forEach((b, k) => {
    if (!isSection(b)) return;
    const old = before.slice(k + 1, sectionRange(before, k)[1]);
    if (indexOf(build, b.id) >= 0) subVersion(build, b.id, old, made);
    else if (old.length) historyOf(build, b.id).away = old;
  });
  // A heading in the document whose history says it is away has just come back.
  for (const b of build.blocks) {
    const away = build.history?.[b.id]?.away;
    if (away && isSection(b)) subVersion(build, b.id, away, made);
  }
}

/** A subheading in the document whose text a change under its parent replaced: its text before (`old`), when other, becomes a version. */
function subVersion(build: Build, section: string, old: BuildBlock[], made: SectionHistory["current"]): void {
  delete build.history?.[section]?.away;
  const after = savedText(build, section);
  if (!after || sameText(after, old)) return;
  const h = historyOf(build, section);
  keep(h, old);
  h.current = made;
}

/**
 * After a watched change: when the section's saved text changed, its text before becomes a version.
 * Undo puts back an earlier text: the version that holds it becomes current again, if it is still
 * kept, and the text Undo replaced becomes a version. Subheadings keep their history either way.
 */
export function record(build: Build, w: Watch | undefined): void {
  const after = w && savedText(build, w.section);
  if (!w || !after || sameText(after, w.before)) return;
  const h = historyOf(build, w.section);
  if (w.made === "back") back(build, w.section, after, w.before);
  else if (joins(h.current, w.made)) h.current!.at = w.made.at;
  else {
    keep(h, w.before);
    h.current = w.made;
    subVersions(build, w.before, w.made);
  }
}

/** Makes the newest version holding `text` current again, and keeps the text it replaced (`replaced`) as a version. */
function back(build: Build, section: string, text: BuildBlock[], replaced: BuildBlock[]): void {
  const h = historyOf(build, section);
  const v = h.versions.filter((x) => sameText(x.blocks, text)).at(-1);
  h.versions = h.versions.filter((x) => x !== v);
  putBack(build, section, v, replaced);
}

/** Version `v` (if any) is the section's text again, and the text it replaced (`replaced`) its newest version; subheadings keep their history. */
function putBack(build: Build, section: string, v: SectionVersion | undefined, replaced: BuildBlock[]): void {
  const h = historyOf(build, section);
  keep(h, replaced);
  h.current = restoredFrom(v);
  subVersions(build, replaced, h.current);
}

/** How a version's text came to be, as the current text's once it is put back; unknown for the text a build started with. */
const restoredFrom = (v: SectionVersion | undefined): SectionHistory["current"] =>
  v?.by && v.how && v.at ? { by: v.by, how: v.how, at: v.at, restored: now() } : undefined;

/** A heading's text without its `#`s. */
const words = (text: string) => text.replace(/^\s{0,3}#{1,6}\s*/, "").trim();

/**
 * Refuses replacing the text under the heading at `i` while Claude's draft waits on a subheading
 * inside it, or (with `changes`) Claude's rewrite waits there: replacing it would drop them unseen.
 */
export function refuseWaiting(build: Build, i: number, changes: boolean): void {
  const [start, end] = sectionRange(build.blocks, i);
  const ids = new Set(build.blocks.slice(start, end).map((b) => b.id));
  const draft = (build.drafts ?? []).find((d) => ids.has(d.section));
  const sub = draft && build.blocks.find((b) => b.id === draft.section);
  if (sub) throw new HoopError(`Claude's draft waits under the subheading “${words(sub.text)}”: save or discard it first`);
  if (changes && (build.changes ?? []).some((c) => c.blocks.some((id) => ids.has(id))))
    throw new HoopError("Claude's change waits under this heading: save or discard it first");
}

/**
 * The person saves version `version` of heading `section` back: its blocks replace the text under
 * the heading, and that text becomes a version. Refused while Claude's draft waits on a subheading
 * or Claude's rewrite waits in the section, since it would act on text that is gone. A block put
 * back as it was, with its ID, keeps its open requests.
 */
export function restoreVersion(build: Build, section: string, version: string): string {
  const i = indexOf(build, section);
  if (i < 0) throw new HoopError(`the build has no block ${section}`);
  const v = build.history?.[section]?.versions.find((x) => x.id === version);
  if (!v) throw new HoopError(`this heading has no version ${version}: it keeps its last ${VERSIONS_MAX}`);
  refuseWaiting(build, i, true);
  const [start, end] = sectionRange(build.blocks, i);
  const here = build.blocks.slice(start, end);
  // A block of the version whose ID another block took since gets a new one.
  const taken = new Set([...build.blocks.filter((b) => !here.includes(b)), ...(build.drafts ?? []).flatMap((d) => d.blocks)].map((b) => b.id));
  const blocks = v.blocks.map((b) => (taken.has(b.id) ? renamed(build, b) : b));
  build.blocks.splice(start, end - start, ...blocks);
  overtake(
    build,
    here.filter((b) => !blocks.some((x) => x.id === b.id && x.text === b.text)).map((b) => b.id),
  );
  prune(build);
  // Undo would put back text from before a save that is now a version too, here or under a subheading.
  for (const b of [build.blocks[i]!, ...here]) delete build.undo?.[b.id];
  const h = historyOf(build, section);
  h.versions = h.versions.filter((x) => x !== v);
  putBack(build, section, v, here);
  return "saved an earlier version of the text under a heading";
}

/**
 * A block of a version put back whose ID another block took since, with a new ID. A heading's copy
 * takes a copy of its history, with the text under the heading that kept the ID as the text it
 * comes back from, so a copy put back with other text keeps that text as a version.
 */
function renamed(build: Build, b: BuildBlock): BuildBlock {
  const copy = { ...b, id: `b${build.next++}` };
  const h = build.history?.[b.id];
  if (h && isSection(b)) build.history![copy.id] = { ...structuredClone(h), away: savedText(build, b.id) ?? [] };
  return copy;
}

/** Forgets the history of headings the person removed (`ids`). */
export function forgetHistory(build: Build, ids: string[]): void {
  for (const id of ids) delete build.history?.[id];
}

/** When a history last changed: its newest version's replacement, or its current text's. */
const lastChange = (h: SectionHistory) => [...h.versions.map((v) => v.replaced), h.current?.at ?? ""].sort().at(-1) ?? "";

/**
 * Drops the history of each heading that is no longer a section's, and keeps at most `ABSENT_MAX` of
 * headings not in the document now, dropping those least recently changed.
 */
export function pruneHistory(build: Build): void {
  if (!build.history) return;
  const here = new Map(build.blocks.map((b) => [b.id, b]));
  for (const id of Object.keys(build.history)) if (here.has(id) && !isSection(here.get(id))) delete build.history[id];
  const absent = Object.keys(build.history)
    .filter((id) => !here.has(id))
    .sort((a, b) => lastChange(build.history![b]!).localeCompare(lastChange(build.history![a]!)));
  for (const id of absent.slice(ABSENT_MAX)) delete build.history[id];
  if (!Object.keys(build.history).length) delete build.history;
}
