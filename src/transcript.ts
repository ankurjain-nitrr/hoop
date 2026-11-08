import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { obj } from "./util.js";

// The only reader of Claude Code transcripts: `follow` reads forward, keeping its place in the pages
// process, so each reader of a file (read receipts, requests, the todo tools) reads each byte once,
// in 1 MB chunks; `tailLines` reads a file's end; `parseEntry` reads one line.

/** A transcript entry. */
export type Entry = Record<string, unknown>;

/** A transcript line's entry, or undefined for a blank line, one that isn't JSON, or JSON that isn't an object. */
export function parseEntry(line: string): Entry | undefined {
  if (!line.trim()) return undefined;
  try {
    return obj(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** How far back a read goes to find one whole line, when the end of a file is a single long line. */
const TAIL_MAX = 8 * 1024 * 1024;

/**
 * The complete lines at the end of a file: its last `bytes`, or further back, up to `max`, until
 * the read holds at least one whole line. A read that starts mid-file drops its first line.
 */
export function tailLines(path: string, bytes: number, max = TAIL_MAX): string[] {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    for (let want = bytes; ; want *= 2) {
      const start = Math.max(0, size - Math.min(want, max));
      const buf = Buffer.alloc(size - start);
      const n = readSync(fd, buf, 0, buf.length, start);
      const lines = buf.subarray(0, n).toString("utf8").split("\n");
      // A read that starts mid-file starts mid-line.
      const whole = start > 0 ? lines.slice(1) : lines;
      if (start === 0 || whole.some((l) => l.trim()) || want >= max) return whole;
    }
  } finally {
    closeSync(fd);
  }
}

/** How much one read takes at a time, and how many bytes before its place a reader keeps. */
const CHUNK = 1024 * 1024,
  MARK = 64;

type Follow<S> = { from: number; pos: number; partial: string; skip: boolean; text: StringDecoder; mark: Buffer; state: S };
const follows = new Map<string, Follow<unknown>>();

/** Whether the bytes before a reader's place are still the ones it read: a file rewritten starts again. */
function same(fd: number, f: Follow<unknown>): boolean {
  if (!f.mark.length) return true;
  const now = Buffer.alloc(f.mark.length);
  readSync(fd, now, 0, now.length, f.pos - f.mark.length);
  return now.equals(f.mark);
}

/** Feeds `line` each whole line from a reader's place to byte `size`, and moves its place there. */
function readOn<S>(fd: number, f: Follow<S>, size: number, line: (state: S, text: string) => void) {
  // A character cut between chunks waits in the decoder for the rest of its bytes.
  const buf = Buffer.alloc(Math.min(CHUNK, Math.max(0, size - f.pos)));
  while (f.pos < size) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, size - f.pos), f.pos);
    if (n <= 0) break;
    f.pos += n;
    const lines = (f.partial + f.text.write(buf.subarray(0, n))).split("\n");
    f.partial = lines.pop() ?? "";
    for (const text of lines) {
      if (f.skip) f.skip = false;
      else if (text.trim()) line(f.state, text);
    }
  }
}

/**
 * Feeds each whole line of `path` after byte `from` to `line`, once, and returns the state it
 * builds. `kind` names the reader, so readers of one file keep their own place. A call with an
 * earlier `from` than the kept one, or after the file shrank or was rewritten, starts again. A
 * `from` inside a line (`midLine`) skips that line's rest. Undefined when the file can't be read, or
 * when more than `max` bytes wait to be read, so a missing line can't be told from one not read.
 */
export function follow<S>(
  path: string,
  kind: string,
  from: number,
  init: () => S,
  line: (state: S, text: string) => void,
  opts: { max?: number; midLine?: boolean } = {},
): S | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const key = `${kind}\u0000${path}`;
    let f = follows.get(key) as Follow<S> | undefined;
    if (!f || f.from > from || f.pos > size || !same(fd, f as Follow<unknown>))
      f = { from, pos: from, partial: "", skip: Boolean(opts.midLine && from > 0), text: new StringDecoder("utf8"), mark: Buffer.alloc(0), state: init() };
    if (opts.max !== undefined && size - f.pos > opts.max) return undefined;
    readOn(fd, f, size, line);
    const keep = Math.min(MARK, f.pos - f.from);
    if (keep > 0) {
      f.mark = Buffer.alloc(keep);
      readSync(fd, f.mark, 0, keep, f.pos - keep);
    }
    if (follows.size > 400) follows.clear();
    follows.set(key, f as Follow<unknown>);
    return f.state;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
