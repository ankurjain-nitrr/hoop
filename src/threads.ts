// A review's comment threads: the thread a comment starts or answers, every thread with its status
// (unanswered, answered, applied or resolved) and where its line stands now, as the page and Claude
// read them.
import { anchorText, DOC, type Comment, type Feedback, type ReviewDoc } from "./contract.js";
import type { Applied, Proposal, ReviewMeta, Store } from "./store.js";
import { ownedBy } from "./claude-sessions.js";

export type ThreadEntry = { comment: Comment; revision: number };

/** A comment thread: its first comment, the revision that comment was made on, and every entry in order. */
export function thread(store: Store, id: string, threadId: string): { root: Comment; revision: number; entries: ThreadEntry[] } | undefined {
  const entries = threadEntries(store, id).filter((e) => e.comment.thread === threadId);
  return entries.length ? { root: entries[0]!.comment, revision: entries[0]!.revision, entries } : undefined;
}

/** The thread ids a review has so far. */
export function threadIds(store: Store, id: string): Set<string | undefined> {
  return new Set(threadEntries(store, id).map((e) => e.comment.thread));
}

function threadEntries(store: Store, id: string): ThreadEntry[] {
  return store.allFeedback(id).flatMap((f) => f.comments.map((comment) => ({ comment, revision: f.revision })));
}

/**
 * A thread's status: `unanswered` until the owner replies or proposes an edit after the thread's
 * latest entry from anyone else (a reviewer's comment, another session's comment, or a rejection of
 * a proposed edit); `answered` once it has; `applied` when a reviewer's Apply of its suggestion, or
 * their accepting Claude's edit for it, came after both, so nothing waits on Claude; `resolved` once
 * a reviewer resolved it and nothing was added since. Neither "answered" nor "applied" settles the
 * thread for approval: only a reviewer resolves.
 */
type ThreadStatus = "unanswered" | "answered" | "applied" | "resolved";

/** One entry in a thread as Claude reads it: who wrote it, as what, and when. */
type ThreadEntryView = {
  by: string;
  /** `reviewer` for a person, `session` for another Claude Code session's hoop_comment, `owner` for the review's own session. */
  role: "reviewer" | "session" | "owner";
  at: string;
  /** The revision a comment was left on; a reply has none. */
  revision?: number;
  body?: string;
  suggestion?: string;
  /** A suggestion to remove the section this heading starts, with its subsections. */
  remove?: true;
  /** The words the comment is about. */
  quote?: string;
};

/** A comment thread as Claude reads it, from whichever revision it was left on. */
export type ThreadView = {
  thread: string;
  status: ThreadStatus;
  /** The revision the thread's first comment was left on. */
  revision: number;
  item: string;
  line: number;
  /** The section's heading in the latest revision, or in the thread's revision if the section is gone; "the document" for the title and TL;DR. */
  section: string;
  /** The line's text in the revision the thread was left on. */
  original_text: string | null;
  /** The line's text in the latest revision, or null when the line is gone. */
  current_text: string | null;
  /** True when the line changed or went away after the thread's revision. */
  outdated: boolean;
  /** The revision a reviewer's Apply of the thread's suggestion, or their accepting Claude's edit for it, produced. */
  applied_revision?: number;
  entries: ThreadEntryView[];
};

/**
 * Every comment thread on a review, from every revision, oldest first, with its status and where
 * its line stands now. The review page shows the same threads: it takes which are resolved from the
 * review's view (`threads_resolved`), and keeps the same outdated rule (web/place.js `isOutdated`).
 */
export function threadViews(store: Store, id: string): ThreadView[] {
  const meta = store.meta(id);
  const docs = new Map<number, ReviewDoc>();
  const docOf = (n: number) => docs.get(n) ?? docs.set(n, store.revision(id, n)).get(n)!;
  const latest = docOf(meta.revisions);
  const by = gatherThreads(store, id, meta);
  const proposals = store.proposals(id);
  const applied = store.applied(id);
  return [...by.entries()].map(([thread, t]) => {
    t.entries.sort((a, b) => a.at.localeCompare(b.at));
    const applies = applied.filter((a) => a.thread === thread);
    const status = threadStatus(
      t,
      proposals.filter((p) => p.thread === thread),
      applies,
    );
    const { item, line } = t.root;
    const then = anchorText(docOf(t.revision), item, line);
    const now = anchorText(latest, item, line);
    const heading = (d: ReviewDoc) => d.items.find((i) => i.id === item)?.title;
    const done = applies.at(-1);
    return {
      thread,
      status,
      revision: t.revision,
      item,
      line,
      section: item === DOC ? "the document" : (heading(latest) ?? heading(docOf(t.revision)) ?? item),
      original_text: then ?? null,
      current_text: now ?? null,
      outdated: t.revision !== meta.revisions && (then === undefined || then !== now),
      ...(done ? { applied_revision: done.revision } : {}),
      entries: t.entries,
    };
  });
}

/**
 * Where an entry or a resolution stands in the order hoop recorded them: the index of its feedback
 * among the review's feedback (`feedback`), or, for a reply, how many feedback entries the review
 * had when it was recorded (`after`); and its time, for a reply stored before hoop kept `after`.
 */
type Place = { at: string; feedback?: number; after?: number };

/**
 * A thread as `threadViews` gathers it: its first comment, its revision, its entries, where each
 * entry was recorded (`places`, in the order they were gathered; `threadViews` then sorts `entries`
 * by time, so only `some` and other order-free checks read `places`) and where it was last resolved.
 */
type Gathered = { root: Comment; revision: number; entries: ThreadEntryView[]; places: Place[]; resolved?: { feedback: number; at: string } };

/**
 * Whether an entry was recorded after the resolution: by the order of the review's feedback, so the
 * resolving review's own comments never count and a reply recorded after it does, in the same
 * millisecond or not. Only a reply stored before hoop kept that order falls back to its time.
 */
function after(p: Place, resolved: { feedback: number; at: string }): boolean {
  if (p.feedback !== undefined) return p.feedback > resolved.feedback;
  if (p.after !== undefined) return p.after > resolved.feedback;
  return p.at > resolved.at;
}

/** Who left a feedback entry: the review's own session, another session, or a person. */
function roleOf(meta: ReviewMeta, f: Feedback): ThreadEntryView["role"] {
  if (!f.session) return "reviewer";
  return ownedBy(meta, f.session.id) ? "owner" : "session";
}

/** A comment as an entry in its thread. */
const commentEntry = (meta: ReviewMeta, f: Feedback, c: Comment): ThreadEntryView => ({
  by: f.reviewer,
  role: roleOf(meta, f),
  at: f.at,
  revision: f.revision,
  ...(c.body ? { body: c.body } : {}),
  ...(c.suggestion !== undefined ? { suggestion: c.suggestion } : {}),
  ...(c.remove ? { remove: true as const } : {}),
  ...(c.range ? { quote: c.range.quote } : {}),
});

/** Every thread's comments, resolutions and replies, by thread ID, in the order the threads began. */
function gatherThreads(store: Store, id: string, meta: ReviewMeta): Map<string, Gathered> {
  const by = new Map<string, Gathered>();
  // Feedback comes in the order it was recorded, so the last resolution of a thread is its latest.
  store.allFeedback(id).forEach((f, i) => {
    for (const c of f.comments) {
      if (!c.thread) continue;
      const t = by.get(c.thread) ?? by.set(c.thread, { root: c, revision: f.revision, entries: [], places: [] }).get(c.thread)!;
      t.entries.push(commentEntry(meta, f, c));
      t.places.push({ at: f.at, feedback: i });
    }
    for (const r of f.resolved_threads) {
      const t = by.get(r);
      if (t) t.resolved = { feedback: i, at: f.at };
    }
  });
  for (const r of store.replies(id)) {
    const t = by.get(r.thread);
    t?.entries.push({ by: r.author, role: "owner", at: r.at, body: r.body });
    t?.places.push({ at: r.at, ...(r.after !== undefined ? { after: r.after } : {}) });
  }
  return by;
}

/** The latest of some timestamps, or "" for none. */
const latestOf = (xs: string[]) => xs.reduce((a, b) => (b > a ? b : a), "");

/** When what the latest Apply answers was asked: the edit it accepted, or the last suggestion it applied. */
function basisOf(latestApply: Applied | undefined, mine: Proposal[], entries: ThreadEntryView[]): string {
  if (!latestApply) return "";
  if (latestApply.kind === "edit") return mine.find((p) => p.id === latestApply.edit_id)?.at ?? "";
  return latestOf(entries.filter((e) => (e.suggestion !== undefined || e.remove) && e.at <= latestApply.at).map((e) => e.at));
}

/** A thread's status, from its entries, Claude's proposed edits on it (`mine`) and reviewers' Applies of it. */
function threadStatus(t: Gathered, mine: Proposal[], applies: Applied[]): ThreadStatus {
  // The owner answers by replying or proposing an edit; anyone else adding to the thread, or
  // rejecting an edit, asks again.
  const others = [
    ...t.entries.filter((e) => e.role !== "owner").map((e) => e.at),
    ...mine.flatMap((p) => (p.status === "rejected" && p.decided_at ? [p.decided_at] : [])),
  ];
  const answers = [...t.entries.filter((e) => e.role === "owner").map((e) => e.at), ...mine.map((p) => p.at)];
  // A reviewer's Apply, or their accepting Claude's edit, settles what they asked for, so Claude
  // owes no answer; their next comment asks again. It settles only what it answers: the suggestion
  // it applied, or the edit it accepted (its basis). Anything asked after that basis, such as a
  // follow-up question or a rejection of another edit, still waits on Claude.
  const latestApply = applies.at(-1);
  const basis = basisOf(latestApply, mine, t.entries);
  const asked = latestOf(others),
    answered = latestOf(answers),
    settled = latestApply?.at ?? "";
  const resolved = t.resolved;
  if (resolved && !t.places.some((p) => after(p, resolved))) return "resolved";
  if (settled > asked && settled >= answered && asked <= basis) return "applied";
  return answered > asked ? "answered" : "unanswered";
}
