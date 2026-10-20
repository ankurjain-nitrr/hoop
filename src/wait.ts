import { setTimeout as sleep } from "node:timers/promises";
import type { Hoop, FeedbackResult } from "./hoop.js";

export type WaitOptions = { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal };

/**
 * Resolves with the feedback once a reviewer submits a review on the latest revision after the
 * wait starts, or right away if the review is approved or (GitHub) closed. Resolves `undefined` on timeout.
 */
export async function waitForReview(hoop: Hoop, reviewId: string, opts: WaitOptions = {}): Promise<FeedbackResult | undefined> {
  const github = Boolean(hoop.store.meta(reviewId).github);
  const { intervalMs = github ? 15000 : 2000, timeoutMs = 0, signal } = opts;
  let failures = 0;
  // A gh or network error during a long wait is retried; five in a row end the wait with the error.
  const refresh = async () => {
    try {
      await hoop.refresh(reviewId);
      failures = 0;
    } catch (err) {
      if (++failures >= 5) throw err;
      process.stderr.write(`hoop: refresh failed (${failures}/5), retrying: ${(err as Error).message}\n`);
    }
  };
  await refresh();
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  let revision = hoop.store.meta(reviewId).revisions;
  let seen = hoop.store.feedback(reviewId, revision).length;
  for (;;) {
    const meta = hoop.store.meta(reviewId);
    if (meta.status !== "open") return hoop.feedbackAny(reviewId);
    if (meta.revisions !== revision) [revision, seen] = [meta.revisions, 0];
    if (hoop.store.feedback(reviewId, revision).length > seen) return hoop.feedbackAny(reviewId);
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs, undefined, { signal });
    await refresh();
  }
}
