import { appendFileSync, closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { HoopError, writeAtomic } from "./util.js";

/**
 * The agent session that submitted a review, and the session's title when it had one. `claude` is
 * false for a session outside Claude Code, which has no transcript; absent, it is a Claude Code session.
 */
export type Owner = { session: string; name?: string; claude?: false };

/**
 * The agent session a process acts for. A Claude Code session (`claude`) is named by its transcript's
 * title; any other carries the name it has, if any.
 */
export type Agent = { session: string; claude: boolean; name?: string };

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** How much of a transcript's end is read for its title. */
const TAIL_BYTES = 1024 * 1024;

/** The Claude Code session this process runs in, from `CLAUDE_CODE_SESSION_ID`, or undefined. */
export function sessionFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return validSession(env.CLAUDE_CODE_SESSION_ID);
}

/**
 * The session this process acts for: `CLAUDE_CODE_SESSION_ID` (a Claude Code session), else
 * `HOOP_SESSION` (any agent may set it), else undefined (a person's terminal).
 */
export function agentFromEnv(env: NodeJS.ProcessEnv = process.env): Agent | undefined {
  const claude = validSession(env.CLAUDE_CODE_SESSION_ID);
  if (claude) return { session: claude, claude: true };
  const own = validSession(env.HOOP_SESSION);
  return own ? { session: own, claude: false } : undefined;
}

/**
 * A session for one MCP server process whose environment names none, after the client that
 * connected (its `clientInfo.name`, such as `codex-mcp-client`): `<8 hex>-<client>`, so its label reads
 * `<client> (<8 hex>)`.
 */
export function generatedAgent(client: string | undefined): Agent {
  const name =
    (client ?? "")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "mcp-client";
  return { session: `${randomBytes(4).toString("hex")}-${name}`, claude: false, name };
}

/** A session ID hoop can use in paths and records, or undefined. */
export const validSession = (id: unknown): string | undefined => (typeof id === "string" && SESSION_ID.test(id) ? id : undefined);

/** Claude Code's folder: `HOOP_CLAUDE_DIR`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const claudeDir = () => process.env.HOOP_CLAUDE_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Each session's folder as last found, checked again on every use. */
const folders = new Map<string, string>();

/** The project folder under `<claude dir>/projects/` that holds a session's transcript, or undefined. */
export function sessionFolder(session: string): string | undefined {
  if (!validSession(session)) return undefined;
  const projects = join(claudeDir(), "projects");
  const known = folders.get(session);
  if (known?.startsWith(projects) && isFile(join(known, `${session}.jsonl`))) return known;
  let names: string[];
  try {
    names = readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const dir = join(projects, name);
    if (isFile(join(dir, `${session}.jsonl`))) {
      folders.set(session, dir);
      return dir;
    }
  }
  return undefined;
}

/** The transcript of a session, or undefined when it can't be found. */
export const transcriptOf = (session: string): string | undefined => {
  const dir = sessionFolder(session);
  return dir ? join(dir, `${session}.jsonl`) : undefined;
};

/**
 * The `.hoop` folder that keeps a session's reviews, beside its transcript in Claude Code's folder:
 * `<claude dir>/projects/<folder slug>/<session>/.hoop`. Undefined when the session's transcript
 * can't be found; its reviews then stay in the hoop home folder.
 */
export function sessionHoop(session: string | null | undefined): string | undefined {
  const id = validSession(session);
  const folder = id ? sessionFolder(id) : undefined;
  return folder && id ? join(folder, id, ".hoop") : undefined;
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

type Titles = { custom?: string; ai?: string };
/** Each transcript's titles, kept while the file's size and time stay the same. */
const titles = new Map<string, { key: string; titles: Titles }>();

/**
 * A session's titles from the end of its transcript: the last one the person set (`custom-title`,
 * which `/rename` and hoop's rename write), and the last one Claude Code generated (`ai-title`).
 */
export function sessionTitles(session: string): Titles {
  const path = transcriptOf(session);
  if (!path) return {};
  let key: string;
  try {
    const st = statSync(path);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return {};
  }
  const cached = titles.get(path);
  if (cached?.key === key) return cached.titles;
  let text: string;
  try {
    text = tail(path, TAIL_BYTES);
  } catch {
    return {};
  }
  const found: Titles = {};
  for (const line of text.split("\n")) {
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
    try {
      const v = JSON.parse(line);
      if (v?.type === "custom-title" && typeof v.customTitle === "string" && v.customTitle.trim()) found.custom = v.customTitle.trim();
      if (v?.type === "ai-title" && typeof v.aiTitle === "string" && v.aiTitle.trim()) found.ai = v.aiTitle.trim();
    } catch {
      /* a line cut short or not JSON */
    }
  }
  titles.set(path, { key, titles: found });
  return found;
}

/** The names people gave sessions on hoop's Home, by session ID, from the hoop folder's `names.json`. */
export function savedNames(home: string): Record<string, string> {
  try {
    const v = JSON.parse(readFileSync(join(home, "names.json"), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * A session's name: the last title the person set in its transcript, else the name given on hoop's
 * Home (with `home`), else the title Claude Code generated, else undefined.
 */
export function sessionName(session: string, home?: string): string | undefined {
  const t = sessionTitles(session);
  const saved = home ? savedNames(home)[session] : undefined;
  return t.custom ?? (typeof saved === "string" && saved ? saved : undefined) ?? t.ai;
}

/** The longest session name hoop accepts. */
export const NAME_MAX = 100;

/** A session name as people typed it, trimmed, or a refusal: it must be one line of 1 to 100 characters. */
export function validName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new HoopError("a session name needs text", [{ path: "name", message: "required" }]);
  if (/[\r\n\u2028\u2029]/.test(name)) throw new HoopError("a session name is one line", [{ path: "name", message: "no line breaks" }]);
  if ([...name].length > NAME_MAX) throw new HoopError(`a session name has at most ${NAME_MAX} characters`, [{ path: "name", message: "too long" }]);
  return name;
}

/**
 * Renames a session: keeps the name in the hoop folder's `names.json`, and appends to the session's
 * transcript the one line Claude Code's `/rename` writes, so Claude Code shows it too. The transcript
 * is only ever appended to. `claude` is false for a session outside Claude Code, whose name is only
 * kept. `transcript` is false when hoop doesn't append to one.
 */
export function renameSession(home: string, session: string, raw: unknown, claude = true): { name: string; transcript: boolean } {
  if (!validSession(session)) throw new HoopError(`invalid session ID ${session}`);
  const name = validName(raw);
  writeAtomic(join(home, "names.json"), `${JSON.stringify({ ...savedNames(home), [session]: name }, null, 2)}\n`);
  // Only a Claude Code session has a transcript; another session's ID never names one.
  const path = claude ? transcriptOf(session) : undefined;
  if (!path) return { name, transcript: false };
  // A transcript whose last line is cut short gets a line break first, so the title stays a line of its own.
  const size = statSync(path).size;
  let lead = "";
  if (size) {
    const fd = openSync(path, "r");
    try {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = "\n";
    } finally {
      closeSync(fd);
    }
  }
  appendFileSync(path, `${lead}${JSON.stringify({ type: "custom-title", customTitle: name, sessionId: session })}\n`);
  return { name, transcript: true };
}

/** A session as people read it: `<name> (<first 8 characters of its ID>)`, or `session <id8>` without a name. */
export const sessionLabel = (o: Owner) => (o.name ? `${o.name} (${o.session.slice(0, 8)})` : `session ${o.session.slice(0, 8)}`);

/** A name given on hoop's Home (with `home`), or undefined. */
const savedName = (session: string, home?: string): string | undefined => {
  const saved = home ? savedNames(home)[session] : undefined;
  return typeof saved === "string" && saved ? saved : undefined;
};

/**
 * The owner record for a session with its current name: a Claude Code session's from `sessionName`;
 * any other's from hoop's Home, else its own (such as its MCP client's).
 */
export const ownerOf = (agent: Agent, home?: string): Owner => {
  if (!agent.claude) {
    const name = savedName(agent.session, home) ?? agent.name;
    return { session: agent.session, ...(name ? { name } : {}), claude: false };
  }
  const name = sessionName(agent.session, home);
  return { session: agent.session, ...(name ? { name } : {}) };
};

/** A review's owner with the session's name as it is now, or as recorded when it can't be read. */
export const ownerNow = (owner: Owner, home?: string): Owner => {
  const claude = owner.claude !== false;
  const name = (claude ? sessionName(owner.session, home) : savedName(owner.session, home)) ?? owner.name;
  return { session: owner.session, ...(name ? { name } : {}), ...(claude ? {} : { claude: false as const }) };
};
