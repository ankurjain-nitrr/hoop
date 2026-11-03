// Undo right after the person removes blocks from a build: the removal keeps everything that goes
// with the blocks (Claude's waiting rewrites and drafts, Save's Undo, earlier versions, notes and open
// requests), and Undo puts all of it back, so the build is as it was before the removal.
import type { Build, BuildBlock } from "./build.js";
import type { SectionHistory } from "./build-history.js";
import { levelOf } from "./build-blocks.js";
import { HoopError } from "./util.js";

/**
 * What goes with the removed blocks, as it was just before the removal; and the history of the
 * section the removal changed, which it gave a version, as it was (`section`, absent: it had none).
 */
type Kept = Pick<Build, "changes" | "drafts" | "notes" | "requests" | "undo" | "history"> & {
  section?: { id: string; history?: SectionHistory };
};

/**
 * The person's last removal: its blocks, the blocks just before and after them (null at either end),
 * what it removed in words, the level of its first block (0 for one that isn't a heading), and what
 * went with it.
 */
export type Removed = {
  blocks: BuildBlock[];
  after: string | null;
  before: string | null;
  what: string;
  level: number;
  kept: Kept;
};

const copy = <T>(v: T): T => structuredClone(v);

/** The entries of `record` whose key is one of `ids`, or undefined when there are none. */
function picked<T>(record: Record<string, T> | undefined, ids: Set<string>): Record<string, T> | undefined {
  const out = Object.fromEntries(Object.entries(record ?? {}).filter(([k]) => ids.has(k)));
  return Object.keys(out).length ? copy(out) : undefined;
}

/**
 * Records a removal before it changes anything: blocks `start` to `end` and what goes with them.
 * Call it first, then remove.
 */
export function noteRemoval(build: Build, start: number, end: number, what: string): Removed {
  const blocks = build.blocks.slice(start, end);
  const ids = new Set(blocks.map((b) => b.id));
  const kept: Kept = {
    // Changes whose blocks all go, which the removal drops.
    changes: copy((build.changes ?? []).filter((c) => c.blocks.every((id) => ids.has(id)))),
    drafts: copy((build.drafts ?? []).filter((d) => ids.has(d.section))),
    notes: copy((build.notes ?? []).filter((n) => ids.has(n.section) || ids.has(n.with) || ids.has(n.block))),
    // Requests still open on the blocks, which close once their block is gone.
    requests: copy((build.requests ?? []).filter((r) => r.status !== "written" && ids.has(r.block))),
    undo: picked(build.undo, ids),
    history: picked(build.history, ids),
  };
  return {
    blocks: copy(blocks),
    after: build.blocks[start - 1]?.id ?? null,
    before: build.blocks[end]?.id ?? null,
    what,
    level: levelOf(blocks[0]!),
    kept,
  };
}

/** Keeps the history of `section`, the one the removal is about to give a version, as it is now. */
export function keepSection(r: Removed, build: Build, section: string): void {
  const history = build.history?.[section];
  r.kept.section = { id: section, ...(history ? { history: copy(history) } : {}) };
}

/** Claude rewrote block `old` as `ids`: a removal that came after it now comes after the last of them. */
export function followRewrite(build: Build, old: string, ids: string[]): void {
  const r = build.removed;
  if (r?.after === old) r.after = ids.at(-1)!;
  if (r?.before === old) r.before = ids[0]!;
}

/** Where Undo puts the blocks back: after the block before them, else before the block after them. */
function spot(build: Build, r: Removed): number {
  const at = (id: string | null) => (id === null ? -1 : build.blocks.findIndex((b) => b.id === id));
  if (r.after === null) return 0;
  const after = at(r.after);
  if (after >= 0) return after + 1;
  const before = r.before === null ? build.blocks.length : at(r.before);
  if (before >= 0) return before;
  throw new HoopError("the blocks around it are gone, so it can't go back where it was");
}

/** `kept` added to `now`, leaving out those `same` finds there already. */
function added<T>(now: T[] | undefined, kept: T[] | undefined, same: (a: T, b: T) => boolean): T[] | undefined {
  if (!kept?.length) return now;
  return [...(now ?? []), ...kept.filter((k) => !(now ?? []).some((n) => same(n, k)))];
}

/** The section the removal changed has its history back as it was, without the version the removal gave it. */
function restoreSection(build: Build, s: Kept["section"]): void {
  if (s?.history) build.history = { ...build.history, [s.id]: s.history };
  else if (s && build.history) delete build.history[s.id];
}

/** Each request the removal closed is open again; one Claude had taken waits to be taken again. */
function reopenRequests(build: Build, requests: Kept["requests"]): void {
  for (const q of requests ?? []) {
    const i = (build.requests ?? []).findIndex((x) => x.id === q.id);
    const now = build.requests?.[i];
    if (now?.status === "written" && now.overtaken) build.requests![i] = { ...q, status: q.status === "taken" ? "queued" : q.status };
  }
}

/** Puts the removed blocks back, and with them what went with them; each only where nothing has taken its place. */
export function restoreRemoval(build: Build, r: Removed): void {
  if (r.blocks.some((b) => build.blocks.some((x) => x.id === b.id))) throw new HoopError("it is already back");
  build.blocks.splice(spot(build, r), 0, ...copy(r.blocks));
  const { changes, drafts, notes, requests, undo, history, section } = r.kept;
  const byId = (a: { id: string }, b: { id: string }) => a.id === b.id;
  build.changes = added(build.changes, changes, byId);
  build.notes = added(build.notes, notes, byId);
  build.drafts = added(build.drafts, drafts, (a, b) => a.section === b.section);
  if (undo) build.undo = { ...undo, ...build.undo };
  if (history) build.history = { ...history, ...build.history };
  restoreSection(build, section);
  reopenRequests(build, requests);
}
