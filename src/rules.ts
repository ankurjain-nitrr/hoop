import { anchorText, DOC, type Comment, type Feedback, type Item, type ReviewDoc } from "./contract.js";
import { receiptKey, type ReviewMeta, type Store } from "./store.js";
import { sessionLabel } from "./owner.js";
import { HoopError } from "./util.js";
import { actsAs } from "./work.js";

/** A review's metadata, or a refusal naming the missing review. */
export function existing(store: Store, id: string): ReviewMeta {
  try {
    return store.meta(id);
  } catch {
    throw new HoopError(`no review ${id}`);
  }
}

/**
 * A review whose text may change (a reviewer's Apply, Claude's proposed edits, a reviewer's decision
 * on one), or the refusal for why not: an approved review's text is frozen until a person's comment
 * reopens it (`reviewable`).
 */
export function editable(store: Store, id: string): ReviewMeta {
  const meta = existing(store, id);
  if (meta.status === "approved") throw new HoopError(`review ${meta.id} is approved and frozen`);
  notBuilding(meta);
  return meta;
}

/**
 * A review a person or a session may send a review on, or the refusal. An approved review stays open
 * to comments: a person's request for changes reopens it (`afterApproval`). A review that another
 * replaced takes none.
 */
export function reviewable(store: Store, id: string): ReviewMeta {
  const meta = existing(store, id);
  notBuilding(meta);
  if (meta.superseded_by) throw new HoopError(`review ${meta.id} was replaced by ${meta.superseded_by}; comment there`);
  return meta;
}

/**
 * Refuses what can't follow an approval: only a person reopens an approved review, by requesting
 * changes on the review page, and it can't be approved again until then.
 */
export function afterApproval(meta: ReviewMeta, fb: Feedback, person: boolean): void {
  if (meta.status !== "approved") return;
  if (fb.verdict === "approved") throw new HoopError(`review ${meta.id} is already approved`);
  if (!person || fb.verdict !== "changes_requested")
    throw new HoopError(
      `review ${meta.id} is approved; only a person reopens it, by requesting changes on its page. Reply in its threads with hoop_reply, or ask the person in chat.`,
    );
}

/**
 * Refuses an approval of a text the reviewer's own decisions still change (#165): while a comment
 * thread from any revision isn't resolved, or while questions remain (`approvalHolds`).
 */
export function approvable(store: Store, id: string, fb: Feedback): void {
  if (fb.verdict !== "approved") return;
  const why = approvalBlocks(store, id, fb.resolved_threads);
  if (why.length) throw new HoopError(`hoop didn't approve ${id}: ${why.join("; ")}`, [{ path: "verdict", message: why.join("; ") }]);
}

/**
 * What holds up an approval now: every comment thread, from any revision, until the reviewer
 * resolves it (`threads`), and every question still in the revision (`questions_in_text`), answered
 * or not, in any kind of document. The reviewer answers questions with a request for changes, and
 * Claude revises the review into a text without them, so an approved text has no open questions.
 * The review page gets these too.
 */
export function approvalHolds(store: Store, id: string): { threads: string[]; questions_in_text: string[] } {
  const threads = threadViews(store, id)
    .filter((t) => t.status !== "resolved")
    .map((t) => t.thread);
  const questions_in_text = store
    .revision(id)
    .items.filter((q) => q.choices?.length)
    .map((q) => q.id);
  return { threads, questions_in_text };
}

/** Why an approval would be refused now: open threads, then questions. `resolving` are threads the approval resolves. */
export function approvalBlocks(store: Store, id: string, resolving: string[] = []): string[] {
  const holds = approvalHolds(store, id);
  const open = holds.threads.filter((t) => !resolving.includes(t));
  const why: string[] = [];
  if (open.length)
    why.push(
      `${open.length} ${open.length === 1 ? "thread is" : "threads are"} still open (${open.join(", ")}): the reviewer resolves them, or requests changes`,
    );
  const n = holds.questions_in_text.length;
  if (n)
    why.push(
      `${n} ${n === 1 ? "question is" : "questions are"} still in the text: answer ${n === 1 ? "it" : "them"} and request changes so Claude writes the ${n === 1 ? "decision" : "decisions"} in`,
    );
  return why;
}

/** Refuses a review's actions on a build, which has no review until the person finishes it. */
export function notBuilding(meta: ReviewMeta): void {
  if (meta.build === "open") throw new HoopError(`${meta.id} is a document being built on the page; it becomes a review when the person presses Finish`);
}

/** The refusal for a process outside any agent session, such as a person's terminal. */
export const NO_SESSION =
  "This process isn't in a Claude Code session (CLAUDE_CODE_SESSION_ID is not set) or another agent's session (HOOP_SESSION is not set), so it can only read reviews; people review on the page";

const DOING = { revise: "revise it", reply: "reply in its threads", propose: "propose edits to it" } as const;

/**
 * Refuses an owner's action (a revision, a reply, a proposed edit) from any session but the one that
 * submitted the review, or the one running in its process since `/clear` (`actsAs`). A review from
 * before owners has none, and any session may act on it. A review
 * a person opened from a file (`opened_by`) has no owner session: any session may reply in its
 * threads, and only the person revises it, by opening the file again.
 */
export function mustOwn(meta: ReviewMeta, session: string | undefined, action: keyof typeof DOING): void {
  if (!session) throw new HoopError(NO_SESSION);
  if (!meta.owner && meta.opened_by) {
    if (action === "reply") return;
    throw new HoopError(
      `${meta.opened_by} opened this review from a file with hoop open, so no session can ${DOING[action]}; they revise it by running hoop open on the file again. Reply in its threads with hoop_reply, or comment with hoop_comment.`,
    );
  }
  if (meta.owner && !actsAs(meta.owner, session))
    throw new HoopError(
      `Only the session that submitted this review can ${DOING[action]}: ${sessionLabel(meta.owner)}. Comment on it with hoop_comment instead.`,
    );
}

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
 * a proposed edit); `answered` once it has; `resolved` once a reviewer resolved it and nothing was
 * added since. "Answered" never means the answer is right: only a reviewer resolves.
 */
export type ThreadStatus = "unanswered" | "answered" | "resolved";

/** One entry in a thread as Claude reads it: who wrote it, as what, and when. */
export type ThreadEntryView = {
  by: string;
  /** `reviewer` for a person, `session` for another Claude Code session's hoop_comment, `owner` for the review's own session. */
  role: "reviewer" | "session" | "owner";
  at: string;
  /** The revision a comment was left on; a reply has none. */
  revision?: number;
  body?: string;
  suggestion?: string;
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

/** Whether a session is the review's owner: its session, an earlier one before `/clear`, or the one in its process since. */
const ownedBy = (meta: ReviewMeta, session: string) => Boolean(meta.owner && (meta.owners?.includes(session) || actsAs(meta.owner, session)));

/**
 * Every comment thread on a review, from every revision, oldest first, with its status and where
 * its line stands now. The review page shows the same threads, with the same resolved and outdated
 * rules (web/review.js `isResolved`, web/place.js `isOutdated`).
 */
export function threadViews(store: Store, id: string): ThreadView[] {
  const meta = store.meta(id);
  const docs = new Map<number, ReviewDoc>();
  const docOf = (n: number) => docs.get(n) ?? docs.set(n, store.revision(id, n)).get(n)!;
  const latest = docOf(meta.revisions);
  const by = new Map<
    string,
    {
      root: Comment;
      revision: number;
      entries: ThreadEntryView[];
      resolvedAt?: string;
      rejectedAt?: string;
    }
  >();
  for (const f of store.allFeedback(id)) {
    for (const c of f.comments) {
      if (!c.thread) continue;
      const t = by.get(c.thread) ?? by.set(c.thread, { root: c, revision: f.revision, entries: [] }).get(c.thread)!;
      t.entries.push({
        by: f.reviewer,
        role: f.session ? (ownedBy(meta, f.session.id) ? "owner" : "session") : "reviewer",
        at: f.at,
        revision: f.revision,
        ...(c.body ? { body: c.body } : {}),
        ...(c.suggestion !== undefined ? { suggestion: c.suggestion } : {}),
        ...(c.range ? { quote: c.range.quote } : {}),
      });
    }
    for (const r of f.resolved_threads) {
      const t = by.get(r);
      if (t && !(t.resolvedAt && t.resolvedAt > f.at)) t.resolvedAt = f.at;
    }
  }
  for (const r of store.replies(id))
    by.get(r.thread)?.entries.push({
      by: r.author,
      role: "owner",
      at: r.at,
      body: r.body,
    });
  const proposals = store.proposals(id);
  const applied = store.applied(id);
  return [...by.entries()].map(([thread, t]) => {
    t.entries.sort((a, b) => a.at.localeCompare(b.at));
    const mine = proposals.filter((p) => p.thread === thread);
    // The owner answers by replying or proposing an edit; anyone else adding to the thread, or
    // rejecting an edit, asks again.
    const others = [
      ...t.entries.filter((e) => e.role !== "owner").map((e) => e.at),
      ...mine.flatMap((p) => (p.status === "rejected" && p.decided_at ? [p.decided_at] : [])),
    ];
    const answers = [...t.entries.filter((e) => e.role === "owner").map((e) => e.at), ...mine.map((p) => p.at)];
    const last = (xs: string[]) => xs.reduce((a, b) => (b > a ? b : a), "");
    const resolved = t.resolvedAt !== undefined && !t.entries.some((e) => e.at > t.resolvedAt!);
    const status: ThreadStatus = resolved ? "resolved" : last(answers) > last(others) ? "answered" : "unanswered";
    const { item, line } = t.root;
    const then = anchorText(docOf(t.revision), item, line);
    const now = anchorText(latest, item, line);
    const heading = (d: ReviewDoc) => d.items.find((i) => i.id === item)?.title;
    const done = applied.filter((a) => a.thread === thread).at(-1);
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

export type StatusKey = "building" | "awaiting_review" | "commented" | "changes_requested" | "reopened" | "approved" | "question" | "answered" | "withdrawn";

/**
 * A review's status for the pages: approved; `reopened` while a person's comment after approval
 * waits for Claude's next revision; or otherwise the latest verdict on its latest revision.
 */
export function reviewStatus(store: Store, meta: ReviewMeta): { status_key: StatusKey } {
  if (meta.status === "approved") return { status_key: "approved" };
  if (meta.reopened) return { status_key: "reopened" };
  if (meta.build === "open") return { status_key: "building" };
  if (meta.ask) {
    const state = askState(store, meta);
    return { status_key: state === "open" ? "question" : state === "withdrawn" ? "withdrawn" : "answered" };
  }
  const latest = store.feedback(meta.id, meta.revisions).at(-1);
  if (latest?.verdict === "changes_requested") return { status_key: "changes_requested" };
  return { status_key: latest ? "commented" : "awaiting_review" };
}

export type Answer = Feedback["answers"][number];

/** A question's wording and options, to tell whether a later revision asks the same question under its ID. */
const asked = (i: Item | undefined) => (i?.choices?.length ? JSON.stringify([i.title, i.choices.map((c) => [c.id, c.label])]) : undefined);

/**
 * The answers the latest revision keeps from earlier ones: for each question that no feedback on the
 * latest revision answers, the reviewer's latest own pick on an earlier revision that asked the same
 * question (same title and options). Section IDs can pass to a different question, which keeps nothing.
 */
export function carriedAnswers(store: Store, id: string): Answer[] {
  const latest = store.meta(id).revisions;
  const items = store.revision(id, latest).items;
  const answeredNow = new Set(store.feedback(id, latest).flatMap((f) => f.answers.map((a) => a.item)));
  const docs = new Map<number, Item[]>();
  const itemsOf = (n: number) => docs.get(n) ?? docs.set(n, store.revision(id, n).items).get(n)!;
  const carried = new Map<string, Answer>();
  for (const f of store.allFeedback(id)) {
    if (f.revision >= latest) continue;
    for (const a of f.answers) {
      const now = items.find((i) => i.id === a.item);
      if (a.recommended || answeredNow.has(a.item) || !asked(now) || asked(now) !== asked(itemsOf(f.revision).find((i) => i.id === a.item))) continue;
      carried.set(a.item, { item: a.item, choice: a.choice, ...(a.text !== undefined ? { text: a.text } : {}) });
    }
  }
  return [...carried.values()];
}

/** Why the page refuses a request for changes with nothing in it; the API says the same. */
export const CHANGES_NEED = "Request changes needs a comment: comment on a line or section, write an overall comment, or answer a question";

/**
 * Refuses a review whose verdict doesn't fit what it carries. A person's review (`person`: sent from
 * the review page) is approved or has changes requested: the Comment verdict stays only for a
 * session's own comments and quick questions' answers, and for reviews stored before. An approval
 * carries no new comments, since they would ask for changes it doesn't make; its notes go in the
 * summary. A request for changes needs a comment, an overall comment or a new answer. A comment
 * needs any of those or a resolved thread. Answers carried from an earlier revision and sent again
 * are not new.
 */
export function checkVerdict(store: Store, id: string, fb: Feedback, person: boolean): void {
  if (person && fb.verdict === "comment")
    throw new HoopError('a review is approved or has changes requested: send verdict "approved" or "changes_requested"', [
      { path: "verdict", message: 'expected "approved" or "changes_requested"' },
    ]);
  if (fb.verdict === "approved") {
    if (fb.comments.length)
      throw new HoopError(`an approval can't carry new comments (${fb.comments.length} sent): request changes, or delete them to approve`, [
        { path: "comments", message: "must be empty for an approval" },
      ]);
    return;
  }
  const carried = carriedAnswers(store, id);
  const fresh = fb.answers.filter((a) => !carried.some((c) => c.item === a.item && c.choice === a.choice && c.text === a.text));
  const said = fb.comments.length || fresh.length || fb.summary?.trim();
  if (fb.verdict === "changes_requested") {
    if (said) return;
    throw new HoopError(CHANGES_NEED);
  }
  if (said || fb.resolved_threads.length) return;
  throw new HoopError("nothing to send: add a comment, answer a question, resolve a thread or write an overall comment");
}

/** A quick question's state: `open` until every question has an answer, `answered`, `closed` once Claude read every answer, or `withdrawn`. */
export type AskState = "open" | "answered" | "closed" | "withdrawn";

/** One answer to a quick question, with who gave it, when, and its feedback entry's `receiptKey`. */
export type AskAnswer = Answer & { by: string; at: string; key: string; note?: string };

/** Every answer to each of a quick question's questions, oldest first, by question ID. */
export function askAnswers(store: Store, id: string): Map<string, AskAnswer[]> {
  const out = new Map<string, AskAnswer[]>();
  store.feedback(id, 1).forEach((f, i) => {
    for (const a of f.answers)
      out.set(a.item, [
        ...(out.get(a.item) ?? []),
        { ...a, by: f.reviewer, at: f.at, key: receiptKey(1, i), ...(f.summary?.trim() ? { note: f.summary.trim() } : {}) },
      ]);
  });
  return out;
}

/** A quick question's state, from its answers, the receipts on them and whether Claude withdrew it. */
export function askState(store: Store, meta: ReviewMeta): AskState {
  if (meta.ask?.withdrawn) return "withdrawn";
  const answers = askAnswers(store, meta.id);
  const latest = store.revision(meta.id, 1).items.map((q) => answers.get(q.id)?.at(-1));
  if (latest.some((a) => !a)) return "open";
  const receipts = store.receipts(meta.id);
  return latest.every((a) => receipts[a!.key]) ? "closed" : "answered";
}

/**
 * Refuses a review's actions on a quick question: it takes only people's answers, on its page, so
 * it is never approved, never has changes requested, takes no comments and is never revised.
 */
export function notAsk(meta: ReviewMeta, action: "review" | "revise"): void {
  if (!meta.ask) return;
  throw new HoopError(
    action === "revise"
      ? `${meta.id} is a quick question, which can't be revised; withdraw it with hoop_withdraw and ask again`
      : `${meta.id} is a quick question: people answer it on its page, and it is never approved, never has changes requested and takes no comments`,
  );
}

/** A quick question that this session asked, or the refusal: only the asking session (or the one in its process since `/clear`) waits on, reads or withdraws it. */
export function mustAsk(store: Store, id: string, session: string | undefined): ReviewMeta {
  const meta = existing(store, id);
  if (!meta.ask) throw new HoopError(`${meta.id} is a review, not a quick question`);
  if (!session) throw new HoopError(NO_SESSION);
  if (!actsAs(meta.owner, session))
    throw new HoopError(`Only the session that asked this question can wait on, read or withdraw it${meta.owner ? `: ${sessionLabel(meta.owner)}` : ""}.`);
  return meta;
}
