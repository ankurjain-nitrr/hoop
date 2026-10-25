import type { Comment, Feedback, Item } from "./contract.js";
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
 * A review that may be changed, or the refusal for why not: an approved review is frozen.
 */
export function editable(store: Store, id: string): ReviewMeta {
  const meta = existing(store, id);
  if (meta.status === "approved") throw new HoopError(`review ${meta.id} is approved and frozen`);
  notBuilding(meta);
  return meta;
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

export type StatusKey = "building" | "awaiting_review" | "commented" | "changes_requested" | "approved" | "question" | "answered" | "withdrawn";

/** A review's status for the pages: approved, or otherwise the latest verdict on its latest revision. */
export function reviewStatus(store: Store, meta: ReviewMeta): { status_key: StatusKey } {
  if (meta.status === "approved") return { status_key: "approved" };
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
