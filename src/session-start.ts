import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { validSession } from "./owner.js";
import { askState, ownedBy, reviewStatus, type StatusKey, threadViews } from "./rules.js";
import { receiptKey, receivedBy, type ReviewMeta, type Store } from "./store.js";
import { clip, isList, isRecord, tryReadJson, writeJson } from "./util.js";
import { workQueue } from "./work.js";

// What a session starting (new, resumed, cleared or compacted) is told about its work in hoop:
// Claude Code's SessionStart hook adds it to Claude's context. Only specifics: the queued todos in
// the person's order, unread feedback, and the reviews that wait on Claude's answer; after a
// compaction also what was open before it, from the snapshot the PreCompact hook took. It reads
// hoop's files and never writes; the snapshot is written by the pages process.

/** The most the note may hold, in characters. */
export const NOTE_MAX = 1500;
const TITLE_MAX = 70;
const TODO_MAX = 80;

/** A queued todo, as the note lists it. */
type QueuedTodo = { id: string; text: string; blocked_by?: string[] };

/** What was open for a session before a compaction: its open reviews and quick questions by ID, and its queue. */
export type Snapshot = { session: string; at: string; reviews: string[]; todos: QueuedTodo[] };

const snapshotPath = (home: string, session: string) => join(home, "compact", `${session}.json`);

/** The session's reviews and quick questions it can still act on: not closed, withdrawn or superseded. */
function ownReviews(store: Store, session: string): ReviewMeta[] {
  return store.list().filter((m) => !m.closed && !m.ask?.withdrawn && !m.superseded_by && ownedBy(m, session));
}

/** Whether a review is still open: not approved, and for a quick question, not every answer read. */
const isOpen = (store: Store, m: ReviewMeta) => m.status !== "approved" && (!m.ask || askState(store, m) !== "closed");

/** The session's queued todos, in the person's order when they set one. */
function queued(home: string, session: string): { todos: QueuedTodo[]; person: boolean } {
  const q = workQueue(home, session);
  return { todos: q.todos.map(({ id, text, blocked_by }) => ({ id, text, ...(blocked_by ? { blocked_by } : {}) })), person: q.person_order };
}

/**
 * Records what is open for a session before Claude Code compacts its conversation, from a PreCompact
 * hook input; undefined for any other input. The pages process runs this.
 */
export function saveSnapshot(store: Store, input: unknown, now = new Date().toISOString()): Snapshot | undefined {
  const i = isRecord(input) ? input : {};
  const session = validSession(i.session_id);
  if (!session || i.hook_event_name !== "PreCompact") return undefined;
  const snapshot: Snapshot = {
    session,
    at: now,
    reviews: ownReviews(store, session)
      .filter((m) => isOpen(store, m))
      .map((m) => m.id),
    todos: queued(store.home, session).todos,
  };
  mkdirSync(join(store.home, "compact"), { recursive: true });
  writeJson(snapshotPath(store.home, session), snapshot, { compact: true });
  return snapshot;
}

/** A session's snapshot from before its latest compaction, or undefined when it has none or it can't be read. */
export function readSnapshot(home: string, session: string): Snapshot | undefined {
  const v = tryReadJson(snapshotPath(home, session));
  if (!isRecord(v) || v.session !== session || typeof v.at !== "string" || !isList(v.reviews) || !isList(v.todos)) return undefined;
  return { session, at: v.at, reviews: v.reviews.filter((id): id is string => typeof id === "string"), todos: v.todos.filter(isTodo) };
}

const isTodo = (t: unknown): t is QueuedTodo => isRecord(t) && typeof t.id === "string" && typeof t.text === "string";

const name = (m: ReviewMeta) => `"${clip(m.title.replace(/\s+/g, " ").trim(), TITLE_MAX)}" (${m.id})`;

/** A verdict, as the note says it; any other feedback is a comment. */
const VERDICT_WORDS: Record<string, string> = { approved: "approved", changes_requested: "changes requested" };

/** The statuses that ask the session for a revision, as the note says them. */
const REVISE_WORDS: Partial<Record<StatusKey, string>> = { reopened: "reopened", changes_requested: "changes requested" };

/** What the session hasn't read on a review: the latest unread feedback's verdict and reviewer, or an answer to a quick question. */
function unreadOf(store: Store, m: ReviewMeta): string | undefined {
  const receipts = store.receipts(m.id);
  let latest: { verdict?: string; reviewer: string } | undefined;
  for (let n = 1; n <= m.revisions; n++)
    store.feedback(m.id, n).forEach((fb, i) => {
      if (!receivedBy(receipts[receiptKey(n, i)], m.owner?.session)) latest = fb;
    });
  if (!latest) return undefined;
  if (m.ask) return "answered";
  return `${VERDICT_WORDS[latest.verdict ?? ""] ?? "commented"} by ${latest.reviewer}`;
}

/** What the session owes on a review it has read: a revision after a request for changes or a reopen, and replies to comments. */
function owedOf(store: Store, m: ReviewMeta): string | undefined {
  if (m.ask || m.build === "open") return undefined;
  const revise = REVISE_WORDS[reviewStatus(store, m).status_key];
  const unanswered = threadViews(store, m.id).filter((t) => t.status === "unanswered").length;
  const owed = [...(revise ? [revise] : []), ...(unanswered ? [`${unanswered} unanswered comment${unanswered > 1 ? "s" : ""}`] : [])];
  return owed.length ? owed.join(", ") : undefined;
}

/** An open review's status, as the note says it. */
const OPEN_WORDS: Partial<Record<StatusKey, string>> = {
  building: "building",
  awaiting_review: "awaiting review",
  commented: "commented",
  changes_requested: "changes requested",
  reopened: "reopened",
  question: "question open",
  answered: "answered",
};

/** One line of the note: its label, its entries, and how many entries didn't fit. */
type Group = { label: string; entries: string[]; more: number };

const render = (groups: Group[]) =>
  groups.filter((g) => g.entries.length || g.more).map((g) => `${g.label}: ${[...g.entries, ...(g.more ? [`${g.more} more`] : [])].join("; ")}.`);

/** The note's lines, each group cut from its end (the longest list first) until the note fits NOTE_MAX. */
function fit(groups: Group[]): string {
  const text = () => (render(groups).length ? ["hoop, for this session:", ...render(groups)].join("\n") : "");
  while (text().length > NOTE_MAX) {
    const longest = groups.reduce((a, b) => (b.entries.length >= a.entries.length ? b : a));
    longest.entries.pop();
    longest.more++;
  }
  return text();
}

const todoEntry = (t: QueuedTodo) =>
  `#${t.id} ${clip(t.text, TODO_MAX)}${t.blocked_by?.length ? ` (blocked by ${t.blocked_by.map((b) => `#${b}`).join(", ")})` : ""}`;

/** The reviews with feedback the session hasn't read, and those it owes an answer, each listed once. */
function reviewLines(store: Store, reviews: ReviewMeta[]): { unread: string[]; waiting: string[]; listed: Set<string> } {
  const unread: string[] = [];
  const waiting: string[] = [];
  const listed = new Set<string>();
  for (const m of reviews) {
    try {
      const fresh = unreadOf(store, m);
      const owed = fresh ? undefined : owedOf(store, m);
      if (fresh) unread.push(`${name(m)} ${fresh}`);
      else if (owed) waiting.push(`${name(m)} ${owed}`);
      if (fresh || owed) listed.add(m.id);
    } catch {
      /* a review removed meanwhile, or unreadable */
    }
  }
  return { unread, waiting, listed };
}

/**
 * The note for one SessionStart hook input, at most NOTE_MAX characters; empty when there is nothing
 * to say or the input isn't a session's start. After a compaction (`source` "compact") it also lists
 * what the snapshot held open, with anything opened since.
 */
export function sessionNote(store: Store, input: unknown): string {
  const i = isRecord(input) ? input : {};
  const session = validSession(i.session_id);
  if (!session || i.hook_event_name !== "SessionStart") return "";
  const reviews = ownReviews(store, session);
  const { unread, waiting, listed } = reviewLines(store, reviews);
  const compact = i.source === "compact" ? readSnapshot(store.home, session) : undefined;
  const queue = queued(store.home, session);
  const todos = queue.todos.length ? queue.todos : (compact?.todos ?? []);
  const groups: Group[] = [
    { label: queue.person && queue.todos.length ? "Queued todos, in the person's order" : "Queued todos", entries: todos.map(todoEntry), more: 0 },
    { label: "Unread feedback in hoop", entries: unread, more: 0 },
    { label: "Waiting on your answer", entries: waiting, more: 0 },
  ];
  if (i.source === "compact") groups.push({ label: "Open in hoop before the compaction", entries: openSince(store, reviews, compact, listed), more: 0 });
  return fit(groups);
}

/** The reviews the snapshot held open, and those open now, that the note doesn't list already, each with its status. */
function openSince(store: Store, reviews: ReviewMeta[], snapshot: Snapshot | undefined, listed: Set<string>): string[] {
  const ids = new Set([...(snapshot?.reviews ?? []), ...reviews.filter((m) => isOpen(store, m)).map((m) => m.id)]);
  return [...ids].flatMap((id) => {
    if (listed.has(id)) return [];
    try {
      const m = store.meta(id);
      if (m.closed || m.ask?.withdrawn || !isOpen(store, m)) return [];
      const words = OPEN_WORDS[reviewStatus(store, m).status_key];
      return words ? [`${name(m)} ${words}`] : [];
    } catch {
      return [];
    }
  });
}

/** The note as Claude Code's SessionStart hook output, or undefined to print nothing. */
export const sessionStartOutput = (note: string) => (note ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note } } : undefined);
