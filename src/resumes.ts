// Which Claude Code session a resumed conversation continues. `claude --resume` usually keeps the
// session ID, but resuming a conversation whose session still runs, or forking one, goes on under a
// new ID in a new process, so neither links it to its earlier work, as they do after `/clear`. The
// SessionStart hook with source "resume" names the transcript it goes on from, and the pages process
// records the link in `<hoop home>/resumes.json` (new session → earlier) once the earlier session no
// longer runs, so a fork running beside its original never acts as it.
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { validSession } from "./owner.js";
import { claudeDir, hoopHome, isRecord, readJson, writeAtomic } from "./util.js";

/** How much of the end of a resumed transcript is read to find the session it continues. */
const TAIL_BYTES = 256 * 1024;
/** How many links a chain of resumes follows back. */
const CHAIN_MAX = 50;

const file = (home: string) => join(home, "resumes.json");

/** The last `TAIL_BYTES` of a file, or "" when it can't be read. */
function tail(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    return buf.subarray(0, readSync(fd, buf, 0, len, size - len)).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A hook's transcript path, when it is a `.jsonl` file under Claude Code's projects folder. */
function transcriptOf(path: unknown): string | undefined {
  if (typeof path !== "string" || !path.endsWith(".jsonl")) return undefined;
  try {
    const real = realpathSync(path);
    return real.startsWith(realpathSync(join(claudeDir(), "projects")) + sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session a resumed conversation continues, from its SessionStart hook's input: the last other
 * session whose entries its transcript holds (the latest in a chain of resumes, since each one's
 * entries follow the one before), or else the session the transcript is named after. Undefined for
 * any other start, or when the transcript names no other session.
 */
export function resumedFrom(input: unknown): string | undefined {
  if (!isRecord(input) || input.hook_event_name !== "SessionStart" || input.source !== "resume") return undefined;
  const session = validSession(input.session_id);
  const transcript = transcriptOf(input.transcript_path);
  if (!session || !transcript) return undefined;
  const others = [...tail(transcript).matchAll(/"sessionId"\s*:\s*"([^"]{1,128})"/g)].flatMap((m) => {
    const s = validSession(m[1]);
    return s && s !== session ? [s] : [];
  });
  const named = validSession(basename(transcript, ".jsonl"));
  return others.at(-1) ?? (named && named !== session ? named : undefined);
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
