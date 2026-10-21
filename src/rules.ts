import type { Comment } from "./contract.js";
import type { ReviewMeta, Store } from "./store.js";
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
 * A review that may be changed, or the refusal for why not. `open` refuses a review that is
 * approved or closed, `frozen` refuses only an approved one, and `github` is the refusal for a
 * review that is reviewed on GitHub (each caller words it for what it was about to do).
 */
export function editable(store: Store, id: string, opts: { open?: boolean; frozen?: boolean; github?: (meta: ReviewMeta) => string }): ReviewMeta {
  const meta = existing(store, id);
  if (opts.frozen && meta.status === "approved") throw new HoopError(`review ${meta.id} is approved and frozen`);
  if (opts.open && meta.status !== "open") throw new HoopError(`review ${meta.id} is ${meta.status}`);
  if (opts.github && meta.github) throw new HoopError(opts.github(meta));
  return meta;
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

export type StatusKey = "awaiting_review" | "commented" | "changes_requested" | "approved" | "closed";

/**
 * A review's status for the pages: its state when closed or approved, otherwise the latest verdict
 * on its latest revision. A GitHub review approved but not merged stays awaiting review, with a note.
 */
export function reviewStatus(store: Store, meta: ReviewMeta): { status_key: StatusKey; status_note?: string } {
  if (meta.status === "closed") return { status_key: "closed" };
  if (meta.status === "approved") return { status_key: "approved" };
  const all = store.feedback(meta.id, meta.revisions);
  const latest = all.at(-1);
  if (meta.github) {
    // GitHub counts each reviewer's latest approval or change request; a later reply doesn't undo it.
    const decided = new Map<string, string>();
    for (const f of all) if (f.verdict !== "comment") decided.set(f.reviewer ?? "", f.verdict);
    const verdicts = [...decided.values()];
    if (verdicts.includes("changes_requested")) return { status_key: "changes_requested" };
    if (verdicts.includes("approved")) return { status_key: "awaiting_review", status_note: "Approved on GitHub, waiting for merge" };
  }
  if (latest?.verdict === "changes_requested") return { status_key: "changes_requested" };
  return { status_key: latest ? "commented" : "awaiting_review" };
}

/** A verdict as hoop records it: the verdict that counts, and the marks it carries. */
export type CountedVerdict = {
  verdict: "comment" | "approved" | "changes_requested";
  marks: { signed_in?: { login: string }; unverified?: true; agent_approval?: true; changes_requested_by_agent?: true };
  note?: string;
};

/**
 * Whose verdict a review page's verdict is. With a GitHub sign-in, it is the person's. With the
 * sign-in turned off in the person's own settings, it counts but is marked unverified. Otherwise it
 * is an agent's: an approve becomes a comment with an agent approval mark, and a request for changes
 * a comment with its own mark, so neither freezes the review.
 */
export function verdictFor(verdict: CountedVerdict["verdict"], login: string | undefined, signin: { enabled: boolean }): CountedVerdict {
  if (verdict === "comment") return { verdict, marks: login ? { signed_in: { login } } : {} };
  if (login) return { verdict, marks: { signed_in: { login } } };
  if (!signin.enabled) return { verdict, marks: { unverified: true } };
  return verdict === "approved"
    ? {
        verdict: "comment",
        marks: { agent_approval: true },
        note: "This approval counts as an agent's, so the review stays open. To approve as yourself, sign in with GitHub on the review page.",
      }
    : {
        verdict: "comment",
        marks: { changes_requested_by_agent: true },
        note: "This request for changes counts as an agent's comment. To request changes as yourself, sign in with GitHub on the review page.",
      };
}
