// What changed between two revisions of a review, as hoop computes it rather than as the agent
// tells it. Sections are compared by ID, which a document keeps across revisions by heading (see
// `matchSections`), and lines as `itemLines` gives them, so the counts match the lines reviewers
// comment on.
import { type Item, itemLines, type ReviewDoc } from "./contract.js";

/** One section that changed, with how many of its lines are new and how many are gone. */
export type SectionChange = { section: string; title: string; lines_added: number; lines_removed: number; renamed_from?: string };

/**
 * What changed from revision `since_revision` to this one. `moved` names the sections whose order
 * changed, and `document` the title, TL;DR or subtitle when they changed.
 */
export type RevisionChanges = {
  since_revision: number;
  added: SectionChange[];
  removed: SectionChange[];
  modified: SectionChange[];
  moved?: { section: string; title: string }[];
  unchanged: number;
  document?: ("title" | "tldr" | "subtitle")[];
  summary: string;
};

/** The lines of `a` that `b` doesn't have, counting a repeated line once per copy. */
function missing(a: string[], b: string[]): number {
  const left = new Map<string, number>();
  for (const l of b) left.set(l, (left.get(l) ?? 0) + 1);
  let n = 0;
  for (const l of a) {
    const k = left.get(l) ?? 0;
    if (k) left.set(l, k - 1);
    else n++;
  }
  return n;
}

/** A section's lines under its heading; a heading with nothing under it has none (`itemLines` repeats its title). */
const bodyLines = (item: Item) => (!item.body?.trim() && item.type !== "question" && !item.check ? [] : itemLines(item));

/** A section removed, with its lines. */
const gone = (i: Item): SectionChange => ({ section: i.id, title: i.title, lines_added: 0, lines_removed: bodyLines(i).length });

type Tally = { added: SectionChange[]; removed: SectionChange[]; modified: SectionChange[]; unchanged: number };

/** Counts one section of the new revision against the one with its ID in the old (`prior`), if any. */
function tally(t: Tally, item: Item, prior: Item | undefined) {
  const lines = bodyLines(item);
  const fresh = { section: item.id, title: item.title, lines_added: lines.length, lines_removed: 0 };
  if (!prior) {
    t.added.push(fresh);
    return;
  }
  const was = bodyLines(prior);
  const change = { section: item.id, title: item.title, lines_added: missing(lines, was), lines_removed: missing(was, lines) };
  if (prior.title !== item.title && was.length && change.lines_removed === was.length) {
    t.removed.push(gone(prior));
    t.added.push(fresh);
  } else if (prior.title !== item.title) t.modified.push({ ...change, renamed_from: prior.title });
  else if (change.lines_added || change.lines_removed) t.modified.push(change);
  else t.unchanged++;
}

/**
 * What changed from `before` (revision `since`) to `after`, section by section, or undefined when
 * the document changed kind (a decision document revised into markdown), whose sections don't
 * compare. A section renamed in place that kept none of its lines was replaced, so it counts as
 * removed and added.
 */
export function revisionChanges(before: ReviewDoc, after: ReviewDoc, since: number): RevisionChanges | undefined {
  if ((before.kind ?? "") !== (after.kind ?? "")) return undefined;
  const old = new Map(before.items.map((i) => [i.id, i]));
  const t: Tally = { added: [], removed: [], modified: [], unchanged: 0 };
  for (const item of after.items) tally(t, item, old.get(item.id));
  const { added, removed, modified, unchanged } = t;
  const kept = new Set(after.items.map((i) => i.id));
  removed.push(...before.items.filter((i) => !kept.has(i.id)).map(gone));
  // A section moved when its place among the sections both revisions have changed.
  const shared = (items: Item[]) => items.filter((i) => old.has(i.id) && kept.has(i.id)).map((i) => i.id);
  const order = shared(before.items);
  const moved = shared(after.items)
    .filter((id, k) => order[k] !== id)
    .map((id) => ({ section: id, title: after.items.find((i) => i.id === id)!.title }));
  const document = (["title", "tldr", "subtitle"] as const).filter((k) => before[k] !== after[k] && !(k === "tldr" && after.tldr_auto));
  return {
    since_revision: since,
    added,
    removed,
    modified,
    ...(moved.length ? { moved } : {}),
    unchanged,
    ...(document.length ? { document } : {}),
    summary: summarize({ added, removed, modified, moved, document, since }),
  };
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
const named = (c: SectionChange) =>
  `${c.section} "${c.title}" (${c.renamed_from !== undefined ? `renamed from "${c.renamed_from}", ` : ""}+${c.lines_added} −${c.lines_removed})`;

/** One line on what changed, naming each section. */
function summarize(c: {
  added: SectionChange[];
  removed: SectionChange[];
  modified: SectionChange[];
  moved: { section: string; title: string }[];
  document: string[];
  since: number;
}): string {
  const list = (what: string, all: SectionChange[]) => (all.length ? [`${count(all.length, "section")} ${what}: ${all.map(named).join(", ")}`] : []);
  const parts = [
    ...list("modified", c.modified),
    ...list("added", c.added),
    ...list("removed", c.removed),
    ...(c.document.length ? [`the document's ${c.document.join(" and ").replace("tldr", "TL;DR")} changed`] : []),
  ];
  const moved = c.moved.length ? `sections reordered: ${c.moved.map((m) => `${m.section} "${m.title}"`).join(", ")}` : "";
  if (parts.length) return `Since revision ${c.since}: ${[...parts, ...(moved ? [moved] : [])].join("; ")}.`;
  return moved ? `No text changed since revision ${c.since}; ${moved}.` : `Nothing changed since revision ${c.since}.`;
}
