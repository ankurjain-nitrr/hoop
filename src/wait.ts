import { type FSWatcher, mkdirSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import type { AskResult, Hoop, FeedbackResult } from "./hoop.js";
import { askState, mustAsk } from "./rules.js";
import { readJsonDir, writeJson } from "./util.js";
import { alive } from "./work.js";
import { isReviewId } from "./ids.js";

/** Watches a folder and calls `listener` on each change in it, as `fs.watch` does; tests pass one that fails. */
export type Watch = (dir: string, listener: () => void) => FSWatcher;
export type WaitOptions = { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; after?: string; partial?: boolean; watch?: Watch };

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
 * Whether a wait on a review runs now, not counting the grace after one ran out of time: a session in
 * its grace isn't waiting, so a message or the Stop gate still has to reach it.
 */
export function waitRuns(home: string, reviewId: string): boolean {
  return marks(home, reviewId).some(([, m]) => !m.until && alive(m.pid));
}

/** Whether a wait on a review started after `at`. */
export function waitedSince(home: string, reviewId: string, at: string): boolean {
  return marks(home, reviewId).some(([, m]) => m.started > at);
}

/** When an agent last waited for a review, from its waits' marks: the latest end, or start of one that ended without saying; undefined when none did. */
export function lastWaited(home: string, reviewId: string): string | undefined {
  const ends = marks(home, reviewId).map(([, m]) => m.until ?? m.started);
  return ends.sort().at(-1);
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
export async function markWait(hoop: Hoop, reviewId: string): Promise<(got: boolean) => Promise<void>> {
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

/**
 * Wakes a wait as soon as anything in a review's folder changes, so a verdict returns when the pages
 * process writes it rather than at the next poll. The watch is the kernel's (FSEvents, inotify), so it
 * costs nothing while idle, and it watches the files, not the pages process, so it keeps working when
 * that restarts. The poll stays as the fallback: a folder it can't watch, or a change it misses, still
 * returns within `intervalMs`.
 */
function wakeOnChange(dir: string, watchDir: Watch = watch) {
  let changed = false;
  let wake: (() => void) | undefined;
  let watcher: FSWatcher | undefined;
  try {
    watcher = watchDir(dir, () => {
      changed = true;
      wake?.();
    });
    watcher.on("error", () => watcher?.close());
  } catch {
    /* no watch: the poll alone */
  }
  return {
    /** Waits until the folder changes or `ms` passes; throws an AbortError when `signal` aborts. */
    async next(ms: number, signal?: AbortSignal) {
      if (!changed) {
        signal?.throwIfAborted();
        // The global timer, which tests can mock, rather than timers/promises, which they can't.
        await new Promise<void>((resolve, reject) => {
          const settle = (aborted: boolean) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            wake = undefined;
            if (!aborted) return resolve();
            // An abort only rejects, with the signal's reason as before the pause: the wait must not
            // check, and so take the review, once more.
            try {
              signal?.throwIfAborted();
            } catch (err) {
              reject(err);
            }
          };
          const onAbort = () => settle(true);
          const timer = setTimeout(() => settle(false), ms);
          wake = () => settle(false);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      changed = false;
    },
    close: () => watcher?.close(),
  };
}

/** Feedback as the agent receives it (`Hoop.receive`), recorded by the pages process. */
export function receive(hoop: Hoop, reviewId: string): Promise<FeedbackResult> {
  if (!hoop.remote) return Promise.resolve(hoop.receive(reviewId));
  return hoop.remote.post<FeedbackResult>("receive", { review_id: reviewId, agent: hoop.actor });
}

/** A quick question's answers as the asking session receives them (`Hoop.receiveAsk`), recorded by the pages process. */
function receiveAsk(hoop: Hoop, id: string): Promise<AskResult> {
  if (!hoop.remote) return Promise.resolve(hoop.receiveAsk(id));
  return hoop.remote.post<AskResult>("receive", { review_id: id, agent: hoop.actor });
}

/**
 * Checks `ready` until it gives a result, then resolves with it; resolves undefined at the deadline.
 * Between checks it waits until the review's folder changes, or `intervalMs` at most. While it runs,
 * the pages see that the agent waits (`isWaiting`).
 */
async function waitOn<T>(hoop: Hoop, id: string, opts: WaitOptions, ready: () => Promise<T> | undefined): Promise<T | undefined> {
  const { intervalMs = 2000, timeoutMs = 0, signal } = opts;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  const end = await markWait(hoop, id);
  // Watching before the first check, so a verdict written after it wakes the wait. On macOS the
  // watch goes live a few milliseconds after it starts; a write in that gap is caught by the next check.
  const changes = wakeOnChange(hoop.store.dirOf(id), opts.watch);
  let got = true;
  try {
    for (;;) {
      // An abort that came while the wait was marked, or while a change was pending, takes nothing.
      signal?.throwIfAborted();
      const result = ready();
      if (result) return await result;
      if (Date.now() >= deadline) {
        got = false;
        return undefined;
      }
      await changes.next(Math.min(intervalMs, deadline - Date.now()), signal);
    }
  } finally {
    changes.close();
    await end(got);
  }
}

/**
 * Resolves with the feedback once a reviewer submits a review on the latest revision after the
 * wait starts, or right away if the review is approved or a person closed it, and records that the agent received it
 * (`Hoop.receive`). Resolves `undefined` on timeout.
 * With `after`, a cursor, it counts from there instead, so a review that came in since returns at once.
 * While it runs, the pages see that the agent waits (`isWaiting`).
 */
export async function waitForReview(hoop: Hoop, reviewId: string, opts: WaitOptions = {}): Promise<FeedbackResult | undefined> {
  const from = parseCursor(opts.after);
  // Reading the review first refuses an ID that names no review before anything is written.
  let revision = from?.revision ?? hoop.store.meta(reviewId).revisions;
  if (from) hoop.store.meta(reviewId);
  let seen = from?.seen ?? hoop.store.feedback(reviewId, revision).length;
  return waitOn(hoop, reviewId, opts, () => {
    const meta = hoop.store.meta(reviewId);
    if (meta.status !== "open" || meta.closed) return receive(hoop, reviewId);
    if (meta.revisions !== revision) [revision, seen] = [meta.revisions, 0];
    return hoop.store.feedback(reviewId, revision).length > seen ? receive(hoop, reviewId) : undefined;
  });
}

/**
 * Resolves with a quick question's answers once every question has an answer that came in after
 * `after` (a cursor; without one, any answer counts), or, with `partial`, on each new answer; and at
 * once when Claude withdrew it or a person closed it. Records that the asking session received them (`Hoop.receiveAsk`).
 * Resolves `undefined` on timeout. No timeout ever answers a question.
 */
export async function waitForAsk(hoop: Hoop, id: string, opts: WaitOptions = {}): Promise<AskResult | undefined> {
  // Refuses another session's ask before anything is written.
  mustAsk(hoop.store, id, hoop.session ?? undefined);
  const seen = parseCursor(opts.after)?.seen ?? 0;
  return waitOn(hoop, id, opts, () => {
    const meta = hoop.store.meta(id);
    const state = askState(hoop.store, meta);
    const fresh = hoop.store.feedback(id, 1).length > seen;
    return state === "withdrawn" || meta.closed || (fresh && (opts.partial || state !== "open")) ? receiveAsk(hoop, id) : undefined;
  });
}
