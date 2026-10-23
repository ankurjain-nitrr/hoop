import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";

/** A lock older than this is from a process that hung or died mid-write, and is broken. */
export const LOCK_STALE_MS = 5000;
/** Backoff between attempts, in milliseconds: it grows from the first to the last. */
const BACKOFF = [2, 5, 10, 20, 40];

const held = new Map<string, number>();
const pause = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number) => Atomics.wait(pause, 0, 0, ms);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a lock's recorded holder is gone or the lock is too old to trust. */
function stale(text: string, path: string): boolean {
  let at: number | undefined, pid: number | undefined;
  try {
    ({ pid, at } = JSON.parse(text) as { pid?: number; at?: number });
  } catch {
    /* half written: judged by its age */
  }
  const age = Date.now() - (typeof at === "number" ? at : statSync(path).mtimeMs);
  return age > LOCK_STALE_MS || (Number.isInteger(pid) && pid !== process.pid && !alive(pid!));
}

/**
 * Takes the lock file `path` (created with O_EXCL, holding this process's ID and the time), or
 * breaks it when its holder is dead or it is older than LOCK_STALE_MS. Returns undefined while another
 * live holder has it. Returns the lock's contents when taken.
 */
function tryTake(path: string): string | undefined {
  const token = JSON.stringify({ pid: process.pid, at: Date.now(), n: Math.random() });
  try {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, token);
    } finally {
      closeSync(fd);
    }
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
    if (!stale(text, path)) return undefined;
  } catch {
    return undefined; // released meanwhile: try again
  }
  // Move the stale lock aside under a name of our own. Another process may have broken it first and
  // taken a fresh one; then the moved file isn't the one judged stale, and it goes back.
  const aside = `${path}.${process.pid}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return undefined;
  }
  let moved = "";
  try {
    moved = readFileSync(aside, "utf8");
  } catch {
    /* gone */
  }
  if (moved !== text) {
    try {
      linkSync(aside, path);
    } catch {
      /* the path is taken again; the holder that moved it keeps going */
    }
  }
  rmSync(aside, { force: true });
  return undefined;
}

/**
 * Runs `fn` while holding the lock file `path`, so read-modify-writes from several processes don't
 * lose each other's writes. The lock is re-entrant inside one process, and `fn` must be synchronous.
 */
export function withLock<T>(path: string, fn: () => T): T {
  const depth = held.get(path) ?? 0;
  if (depth) {
    held.set(path, depth + 1);
    try {
      return fn();
    } finally {
      held.set(path, depth);
    }
  }
  let token: string | undefined;
  for (let attempt = 0; !(token = tryTake(path)); attempt++) sleep(BACKOFF[Math.min(attempt, BACKOFF.length - 1)]! + Math.random() * 3);
  held.set(path, 1);
  try {
    return fn();
  } finally {
    held.delete(path);
    // A lock held past LOCK_STALE_MS may have been broken and taken by another process; leave that one.
    try {
      if (readFileSync(path, "utf8") === token) rmSync(path, { force: true });
    } catch {
      /* already gone */
    }
  }
}
