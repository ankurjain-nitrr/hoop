// Which Claude Code session a resumed conversation continues. `claude --resume` runs it under a new
// session ID in a new process, so neither the ID nor the process links it to its earlier work, as
// they do after `/clear`. The SessionStart hook with source "resume" names the transcript it goes on
// from, and the pages process records the link in `<hoop home>/resumes.json`: new session → earlier.
import { closeSync, openSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { validSession } from "./owner.js";
import { hoopHome, isRecord, readJson, writeAtomic } from "./util.js";

/** How much of a resumed transcript is read to find the session it continues. */
const HEAD_BYTES = 256 * 1024;
/** How many links a chain of resumes follows back. */
const CHAIN_MAX = 50;

const file = (home: string) => join(home, "resumes.json");

/** The first `HEAD_BYTES` of a file, or "" when it can't be read. */
function head(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The session a resumed conversation continues, from its SessionStart hook's input: the session its
 * transcript is named after, or else the first other session ID its transcript's entries carry.
 * Undefined for any other start, or when the transcript names no other session.
 */
export function resumedFrom(input: unknown): string | undefined {
  if (!isRecord(input) || input.hook_event_name !== "SessionStart" || input.source !== "resume") return undefined;
  const session = validSession(input.session_id);
  const transcript = typeof input.transcript_path === "string" && input.transcript_path.endsWith(".jsonl") ? input.transcript_path : undefined;
  if (!session || !transcript) return undefined;
  const named = validSession(basename(transcript, ".jsonl"));
  if (named && named !== session) return named;
  for (const m of head(transcript).matchAll(/"sessionId"\s*:\s*"([^"]{1,128})"/g)) {
    const earlier = validSession(m[1]);
    if (earlier && earlier !== session) return earlier;
  }
  return undefined;
}

/** Records that `session` continues `earlier`; only the pages process calls it. A link that would loop is ignored. */
export function recordResume(home: string, session: string, earlier: string): boolean {
  if (session === earlier || earlierSessions(earlier, home).includes(session)) return false;
  const links = readJson<Record<string, string>>(file(home), {});
  if (links[session] === earlier) return true;
  writeAtomic(file(home), `${JSON.stringify({ ...links, [session]: earlier }, null, 2)}\n`);
  return true;
}

/** The sessions `session` was resumed from, nearest first, through any chain of resumes. */
export function earlierSessions(session: string, home = hoopHome()): string[] {
  const links = readJson<Record<string, string>>(file(home), {});
  const out: string[] = [];
  for (let s = links[session]; s && !out.includes(s) && s !== session && out.length < CHAIN_MAX; s = links[s]) out.push(s);
  return out;
}
