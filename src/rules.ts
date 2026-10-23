import type { Comment, Feedback, Item } from "./contract.js";
import type { ReviewMeta, Store } from "./store.js";
import { sessionLabel } from "./owner.js";
import { HoopError } from "./util.js";

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
  return meta;
}

/** The refusal for a process outside any agent session, such as a person's terminal. */
export const NO_SESSION =
  "This process isn't in a Claude Code session (CLAUDE_CODE_SESSION_ID is not set) or another agent's session (HOOP_SESSION is not set), so it can only read reviews; people review on the page";

const DOING = { revise: "revise it", reply: "reply in its threads", propose: "propose edits to it" } as const;

/**
 * Refuses an owner's action (a revision, a reply, a proposed edit) from any session but the one that
 * submitted the review. A review from before owners has none, and any session may act on it.
 */
export function mustOwn(meta: ReviewMeta, session: string | undefined, action: keyof typeof DOING): void {
  if (!session) throw new HoopError(NO_SESSION);
  if (meta.owner && meta.owner.session !== session)
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

export type StatusKey = "awaiting_review" | "commented" | "changes_requested" | "approved";

/** A review's status for the pages: approved, or otherwise the latest verdict on its latest revision. */
export function reviewStatus(store: Store, meta: ReviewMeta): { status_key: StatusKey } {
  if (meta.status === "approved") return { status_key: "approved" };
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
