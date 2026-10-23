import { setTimeout as sleep } from "node:timers/promises";
import type { Hoop, FeedbackResult } from "./hoop.js";

export type WaitOptions = { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; after?: string };

/**
 * What a caller has seen of a review: its latest revision and how many reviews that revision has,
 * as `"<revision>.<count>"`. Submit, feedback and wait results carry it.
 */
export const cursorOf = (hoop: Hoop, reviewId: string) => {
  const revision = hoop.store.meta(reviewId).revisions;
  return `${revision}.${hoop.store.feedback(reviewId, revision).length}`;
};

const parseCursor = (cursor: string | undefined) => {
  const m = cursor?.match(/^(\d+)\.(\d+)$/);
  return m ? { revision: Number(m[1]), seen: Number(m[2]) } : undefined;
};

/**
 * Resolves with the feedback once a reviewer submits a review on the latest revision after the
 * wait starts, or right away if the review is approved. Resolves `undefined` on timeout.
 * With `after`, a cursor, it counts from there instead, so a review that came in since returns at once.
 */
export async function waitForReview(hoop: Hoop, reviewId: string, opts: WaitOptions = {}): Promise<FeedbackResult | undefined> {
  const { intervalMs = 2000, timeoutMs = 0, signal } = opts;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  const from = parseCursor(opts.after);
  let revision = from?.revision ?? hoop.store.meta(reviewId).revisions;
  let seen = from?.seen ?? hoop.store.feedback(reviewId, revision).length;
  for (;;) {
    const meta = hoop.store.meta(reviewId);
    if (meta.status !== "open") return hoop.feedback(reviewId);
    if (meta.revisions !== revision) [revision, seen] = [meta.revisions, 0];
    if (hoop.store.feedback(reviewId, revision).length > seen) return hoop.feedback(reviewId);
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs, undefined, { signal });
  }
}
