import { setTimeout as sleep } from "node:timers/promises";
import { Hoop, type FeedbackResult } from "./hoop.js";

export type WaitOptions = { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal };

/**
 * Resolves with the feedback once a reviewer submits a review on the latest revision after the
 * wait starts, or right away if the review is already approved. Resolves `undefined` on timeout.
 */
export async function waitForReview(hoop: Hoop, reviewId: string, opts: WaitOptions = {}): Promise<FeedbackResult | undefined> {
  const { intervalMs = 2000, timeoutMs = 0, signal } = opts;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  let revision = hoop.store.meta(reviewId).revisions;
  let seen = hoop.store.feedback(reviewId, revision).length;
  for (;;) {
    const meta = hoop.store.meta(reviewId);
    if (meta.status === "approved") return hoop.feedback(reviewId);
    if (meta.revisions !== revision) [revision, seen] = [meta.revisions, 0];
    if (hoop.store.feedback(reviewId, revision).length > seen) return hoop.feedback(reviewId);
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs, undefined, { signal });
  }
}
