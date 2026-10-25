// What changed between two revisions of a review, as hoop computes it rather than as the agent
// tells it. Sections are compared by ID, which a document keeps across revisions by heading (see
// `matchSections`), and lines as `itemLines` gives them, so the counts match the lines reviewers
// comment on.
import { itemLines, type ReviewDoc } from "./contract.js";

/** One section that changed, with how many of its lines are new and how many are gone. */
export type SectionChange = { section: string; title: string; lines_added: number; lines_removed: number; renamed_from?: string };

/** What changed from revision `since_revision` to this one; `document` names the title, TL;DR or subtitle when they changed. */
export type RevisionChanges = {
  since_revision: number;
  added: SectionChange[];
  removed: SectionChange[];
  modified: SectionChange[];
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

/** What changed from `before` (revision `since`) to `after`, section by section. */
export function revisionChanges(before: ReviewDoc, after: ReviewDoc, since: number): RevisionChanges {
  const old = new Map(before.items.map((i) => [i.id, i]));
  const kept = new Set(after.items.map((i) => i.id));
  const added: SectionChange[] = [];
  const modified: SectionChange[] = [];
  let unchanged = 0;
  for (const item of after.items) {
    const lines = itemLines(item);
    const prior = old.get(item.id);
    if (!prior) {
      added.push({ section: item.id, title: item.title, lines_added: lines.length, lines_removed: 0 });
      continue;
    }
    const was = itemLines(prior);
    const change = { section: item.id, title: item.title, lines_added: missing(lines, was), lines_removed: missing(was, lines) };
    if (prior.title !== item.title) modified.push({ ...change, renamed_from: prior.title });
    else if (change.lines_added || change.lines_removed) modified.push(change);
    else unchanged++;
  }
  const removed = before.items
    .filter((i) => !kept.has(i.id))
    .map((i) => ({ section: i.id, title: i.title, lines_added: 0, lines_removed: itemLines(i).length }));
  const document = (["title", "tldr", "subtitle"] as const).filter((k) => before[k] !== after[k] && !(k === "tldr" && after.tldr_auto));
  return {
    since_revision: since,
    added,
    removed,
    modified,
    unchanged,
    ...(document.length ? { document } : {}),
    summary: summarize(added, removed, modified, document, since),
  };
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
const named = (c: SectionChange) => `${c.section} "${c.title}" (+${c.lines_added} −${c.lines_removed})`;

/** One line on what changed, naming each section. */
function summarize(added: SectionChange[], removed: SectionChange[], modified: SectionChange[], document: string[], since: number): string {
  const parts = [
    ...(modified.length ? [`${count(modified.length, "section")} modified: ${modified.map(named).join(", ")}`] : []),
    ...(added.length ? [`${count(added.length, "section")} added: ${added.map(named).join(", ")}`] : []),
    ...(removed.length ? [`${count(removed.length, "section")} removed: ${removed.map(named).join(", ")}`] : []),
    ...(document.length ? [`the document's ${document.join(" and ").replace("tldr", "TL;DR")} changed`] : []),
  ];
  return parts.length ? `Since revision ${since}: ${parts.join("; ")}.` : `Nothing changed since revision ${since}.`;
}
