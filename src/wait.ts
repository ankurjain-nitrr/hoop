import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AskResult, Hoop, FeedbackResult } from "./hoop.js";
import { askState, mustAsk } from "./rules.js";
import { readJsonDir, writeJson } from "./util.js";
import { alive } from "./work.js";
import { isReviewId } from "./ids.js";

export type WaitOptions = { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; after?: string; partial?: boolean };

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
 * How long after a wait ran out of time the agent still counts as waiting: long enough for it to
 * call hoop_wait again. A wait that returned a review, or was cancelled, counts no longer.
 */
export const WAIT_GRACE_MS = 30_000;

/** A running wait, as `<home>/waits/<review>.<pid>.json`: its process, and once it ends, until when it still counts. */
export type WaitMark = { pid: number; started: string; until?: string };

const waitsDir = (home: string) => join(home, "waits");

/** The marks of a review's waits, by file name. */
function marks(home: string, reviewId: string): [string, WaitMark][] {
  return readJsonDir<WaitMark>(waitsDir(home), (n) => n.startsWith(`${reviewId}.`));
}

const counts = (m: WaitMark, now: number) => (m.until ? Date.parse(m.until) > now : alive(m.pid));

/** Whether an agent waits for a review now (hoop_wait, `hoop wait` or the plan hook), in any process on this hoop folder. */
export function isWaiting(home: string, reviewId: string, now = Date.now()): boolean {
  return marks(home, reviewId).some(([, m]) => counts(m, now));
}

/**
 * Writes a wait's mark (the pages process does this for every process that waits). A new wait also
 * drops the review's marks that count no longer.
 */
export function saveWaitMark(home: string, reviewId: string, mark: WaitMark): void {
  if (!isReviewId(reviewId) || !Number.isInteger(mark.pid) || mark.pid <= 0) throw new Error("invalid wait mark");
  mkdirSync(waitsDir(home), { recursive: true });
  if (!mark.until) for (const [n, m] of marks(home, reviewId)) if (!counts(m, Date.now())) rmSync(join(waitsDir(home), n), { force: true });
  writeJson(join(waitsDir(home), `${reviewId}.${mark.pid}.json`), mark, { compact: true });
}

/**
 * Marks a wait on a review as running, and returns how to end it. In a session or a command the
 * pages process writes the mark: a mark it can't take fails the wait, since the wait's review needs
 * it too; the end is best effort, so it never hides the review the wait got.
 */
async function markWait(hoop: Hoop, reviewId: string): Promise<(got: boolean) => Promise<void>> {
  const started = new Date().toISOString();
  const save = async (mark: WaitMark) => {
    if (hoop.remote) await hoop.remote.post("wait", { review_id: reviewId, ...mark });
    else saveWaitMark(hoop.store.home, reviewId, mark);
  };
  try {
    await save({ pid: process.pid, started });
  } catch (err) {
    if (hoop.remote) throw err;
    /* the pages only show less */
  }
  return async (got) => {
    try {
      await save({ pid: process.pid, started, until: new Date(Date.now() + (got ? 0 : WAIT_GRACE_MS)).toISOString() });
    } catch {
      /* as above */
    }
  };
}

/** Feedback as the agent receives it (`Hoop.receive`), recorded by the pages process. */
export function receive(hoop: Hoop, reviewId: string): Promise<FeedbackResult> {
  if (!hoop.remote) return Promise.resolve(hoop.receive(reviewId));
  return hoop.remote.post<FeedbackResult>("receive", { review_id: reviewId, agent: hoop.actor });
}

/** A quick question's answers as the asking session receives them (`Hoop.receiveAsk`), recorded by the pages process. */
export function receiveAsk(hoop: Hoop, id: string): Promise<AskResult> {
  if (!hoop.remote) return Promise.resolve(hoop.receiveAsk(id));
  return hoop.remote.post<AskResult>("receive", { review_id: id, agent: hoop.actor });
}

/**
 * Resolves with the feedback once a reviewer submits a review on the latest revision after the
 * wait starts, or right away if the review is approved or a person closed it, and records that the agent received it
 * (`Hoop.receive`). Resolves `undefined` on timeout.
 * With `after`, a cursor, it counts from there instead, so a review that came in since returns at once.
 * While it runs, the pages see that the agent waits (`isWaiting`).
 */
export async function waitForReview(hoop: Hoop, reviewId: string, opts: WaitOptions = {}): Promise<FeedbackResult | undefined> {
  const { intervalMs = 2000, timeoutMs = 0, signal } = opts;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  const from = parseCursor(opts.after);
  // Reading the review first refuses an ID that names no review before anything is written.
  let revision = from?.revision ?? hoop.store.meta(reviewId).revisions;
  if (from) hoop.store.meta(reviewId);
  let seen = from?.seen ?? hoop.store.feedback(reviewId, revision).length;
  const end = await markWait(hoop, reviewId);
  let got = true;
  try {
    for (;;) {
      const meta = hoop.store.meta(reviewId);
      if (meta.status !== "open" || meta.closed) return await receive(hoop, reviewId);
      if (meta.revisions !== revision) [revision, seen] = [meta.revisions, 0];
      if (hoop.store.feedback(reviewId, revision).length > seen) return await receive(hoop, reviewId);
      if (Date.now() >= deadline) {
        got = false;
        return undefined;
      }
      await sleep(intervalMs, undefined, { signal });
    }
  } finally {
    await end(got);
  }
}

/**
 * Resolves with a quick question's answers once every question has an answer that came in after
 * `after` (a cursor; without one, any answer counts), or, with `partial`, on each new answer; and at
 * once when Claude withdrew it or a person closed it. Records that the asking session received them (`Hoop.receiveAsk`).
 * Resolves `undefined` on timeout. No timeout ever answers a question.
 */
export async function waitForAsk(hoop: Hoop, id: string, opts: WaitOptions = {}): Promise<AskResult | undefined> {
  const { intervalMs = 2000, timeoutMs = 0, signal } = opts;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  // Refuses another session's ask before anything is written.
  mustAsk(hoop.store, id, hoop.session ?? undefined);
  const seen = parseCursor(opts.after)?.seen ?? 0;
  const end = await markWait(hoop, id);
  let got = true;
  try {
    for (;;) {
      const meta = hoop.store.meta(id);
      const state = askState(hoop.store, meta);
      const fresh = hoop.store.feedback(id, 1).length > seen;
      if (state === "withdrawn" || meta.closed || (fresh && (opts.partial || state !== "open"))) return await receiveAsk(hoop, id);
      if (Date.now() >= deadline) {
        got = false;
        return undefined;
      }
      await sleep(intervalMs, undefined, { signal });
    }
  } finally {
    await end(got);
  }
}
