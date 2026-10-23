import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The Claude Code session that submitted a review, and the session's title when it had one. */
export type Owner = { session: string; name?: string };

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** How much of a transcript's end is read for its title. */
const TAIL_BYTES = 1024 * 1024;

/** The Claude Code session this process runs in, from `CLAUDE_CODE_SESSION_ID`, or undefined (a person's terminal). */
export function sessionFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return validSession(env.CLAUDE_CODE_SESSION_ID);
}

/** A session ID hoop can use in paths and records, or undefined. */
export const validSession = (id: unknown): string | undefined => (typeof id === "string" && SESSION_ID.test(id) ? id : undefined);

/** Claude Code's folder: `HOOP_CLAUDE_DIR`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const claudeDir = () => process.env.HOOP_CLAUDE_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

/** The project folder under `<claude dir>/projects/` that holds a session's transcript, or undefined. */
export function sessionFolder(session: string): string | undefined {
  if (!validSession(session)) return undefined;
  const projects = join(claudeDir(), "projects");
  let names: string[];
  try {
    names = readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const dir = join(projects, name);
    try {
      if (statSync(join(dir, `${session}.jsonl`)).isFile()) return dir;
    } catch {
      /* not this project */
    }
  }
  return undefined;
}

/** The last `bytes` of a file as text, without its first (possibly partial) line when it was cut. */
function tail(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (!n) break;
      read += n;
    }
    const text = buf.subarray(0, read).toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/**
 * A session's title from the end of its transcript: the last title the person set (`custom-title`),
 * else the last one Claude Code generated (`ai-title`), else undefined.
 */
export function sessionName(session: string): string | undefined {
  const dir = sessionFolder(session);
  if (!dir) return undefined;
  let text: string;
  try {
    text = tail(join(dir, `${session}.jsonl`), TAIL_BYTES);
  } catch {
    return undefined;
  }
  let custom: string | undefined, ai: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
    try {
      const v = JSON.parse(line);
      if (v?.type === "custom-title" && typeof v.customTitle === "string" && v.customTitle.trim()) custom = v.customTitle.trim();
      if (v?.type === "ai-title" && typeof v.aiTitle === "string" && v.aiTitle.trim()) ai = v.aiTitle.trim();
    } catch {
      /* a line cut short or not JSON */
    }
  }
  return custom ?? ai;
}

/** A session as people read it: `<name> (<first 8 characters of its ID>)`, or `session <id8>` without a name. */
export const sessionLabel = (o: Owner) => (o.name ? `${o.name} (${o.session.slice(0, 8)})` : `session ${o.session.slice(0, 8)}`);

/** The owner record for a session, with its current title. */
export const ownerOf = (session: string): Owner => {
  const name = sessionName(session);
  return { session, ...(name ? { name } : {}) };
};
