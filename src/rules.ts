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
