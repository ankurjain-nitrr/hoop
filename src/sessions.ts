import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, uptime } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ownInstall, release } from "./version.js";
import { isList, isRecord, readJson, writeJson, sha256 } from "./util.js";
import { claudeDir, type OwnerProcess, sessionFromEnv, sessionHoop } from "./owner.js";

/** The entry format this release writes; readers skip newer ones. */
export const SESSION_FORMAT = 1;

/** A live `hoop mcp` session, as the pages process sees it. Folders never leave hoop's processes. */
export type Session = {
  format: number;
  pid: number;
  /** When the process started, in milliseconds, so a reused process ID isn't live. */
  started: number;
  /** When the machine booted, measured when the entry was written. */
  boot: number;
  /** The system's identifier for this boot, where it gives one. */
  bootId?: string;
  repo: string;
  /** The Claude Code session this `hoop mcp` serves, when it runs in one. */
  claude?: string;
  /** The Claude Code process that session ran in when the entry was written, so `/clear` doesn't lose it. */
  process?: OwnerProcess;
  install: string;
  release: string;
  /** The arguments that start this install's CLI, run without a shell. */
  start: string[];
};

/** Start and boot times measured by two processes match within these margins. */
export const START_MARGIN_MS = 5_000;
const BOOT_MARGIN_MS = 120_000;
/** An entry is a few hundred bytes; anything larger isn't one. */
const MAX_ENTRY_BYTES = 64 * 1024;

export const bootTime = () => Date.now() - uptime() * 1000;

let cachedBootId: string | null | undefined;
/** The system's identifier for the current boot (Linux and macOS), or undefined. */
export function bootId(): string | undefined {
  if (cachedBootId === undefined) {
    cachedBootId = null;
    try {
      cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      /* not Linux */
    }
    if (!cachedBootId)
      try {
        cachedBootId =
          execFileSync("sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim() || null;
      } catch {
        /* not macOS */
      }
  }
  return cachedBootId ?? undefined;
}

const dir = (home: string) => join(home, "sessions");

/** Node's loader arguments, such as tsx's `--require` and `--import`, without debugger or profiler flags. */
export function loaderArgs(execArgv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const a = execArgv[i]!;
    if (/^--(require|import|loader|experimental-loader)=/.test(a)) out.push(a);
    else if (/^(--require|-r|--import|--loader|--experimental-loader)$/.test(a) && i + 1 < execArgv.length) out.push(a, execArgv[++i]!);
  }
  return out;
}

/** The arguments that start this install's CLI: Node, its loader arguments, and the CLI module. */
export function startCommand(): string[] {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return [process.execPath, ...loaderArgs(process.execArgv), fileURLToPath(new URL(`./cli${ext}`, import.meta.url))];
}

/** A key for a store's home folder, like a repository's key: the same folder always gives the same key. */
export function storeKey(home: string): string {
  return sha256(realFolder(home)).slice(0, 16);
}

function realFolder(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Seconds from a `ps` elapsed time, `[[days-]hours:]minutes:seconds`, or undefined. */
export function parseElapsed(text: string): number | undefined {
  const m = text.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return undefined;
  const [, d = "0", h = "0", min, sec] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec);
}

/**
 * When each process started, from one `ps` call. `ran` is false when `ps` is missing, fails another
 * way, or prints lines it can't parse; then the start times are unknown, not absent.
 */
export function processStarts(pids: number[]): { ran: boolean; starts: Map<number, number> } {
  const starts = new Map<number, number>();
  if (!pids.length) return { ran: true, starts };
  let out: string;
  try {
    out = execFileSync("ps", ["-o", "pid=,etime=", "-p", pids.join(",")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
  } catch (err) {
    // ps exits 1 when a listed process is gone, and still prints the others.
    if (!isRecord(err) || err.status !== 1) return { ran: false, starts };
    out = String(err.stdout ?? "");
  }
  const now = Date.now();
  for (const line of out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const [pid, etime] = line.split(/\s+/);
    const seconds = parseElapsed(etime ?? "");
    if (seconds === undefined || !Number.isInteger(Number(pid))) return { ran: false, starts: new Map() };
    starts.set(Number(pid), now - seconds * 1000);
  }
  return { ran: true, starts };
}

/** When one process started, from `ps`, or undefined when `ps` can't say. */
export const processStart = (pid: number) => processStarts([pid]).starts.get(pid);

type Times = { started: number; boot: number; bootId?: string };

/**
 * True when a start time read now matches the one an entry recorded. `ps` counts from the wall clock
 * on some systems and from boot on others, so a wall clock step since then is allowed for in both.
 * The match from boot counts only within the same boot, so a process ID reused after a reboot fails.
 */
export function sameStart(entry: Times, now: Times): boolean {
  if (Math.abs(now.started - entry.started) <= START_MARGIN_MS) return true;
  const sameBoot = entry.bootId && now.bootId ? entry.bootId === now.bootId : Math.abs(now.boot - entry.boot) <= BOOT_MARGIN_MS;
  return sameBoot && Math.abs(now.started - now.boot - (entry.started - entry.boot)) <= START_MARGIN_MS;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isRecord(err) && err.code === "EPERM";
  }
}

/**
 * Records this process as a live session for `repo`, with the Claude Code process it serves when
 * known (`claudeProcess`), and removes the record at exit. Returns the remover, which the caller also
 * runs on a signal.
 */
export function registerSession(home: string, repo: string, claudeProcess?: OwnerProcess): () => void {
  const install = ownInstall();
  const entry: Session = {
    format: SESSION_FORMAT,
    pid: process.pid,
    started: Date.now() - process.uptime() * 1000,
    boot: bootTime(),
    ...(bootId() ? { bootId: bootId() } : {}),
    repo: realFolder(repo),
    ...(sessionFromEnv() ? { claude: sessionFromEnv() } : {}),
    ...(sessionFromEnv() && claudeProcess ? { process: claudeProcess } : {}),
    install,
    release: release(install) ?? "0",
    start: startCommand(),
  };
  mkdirSync(dir(home), { recursive: true });
  const file = join(dir(home), `${process.pid}.json`);
  writeJson(file, entry, { compact: true });
  const remove = () => {
    process.off("exit", remove);
    rmSync(file, { force: true });
  };
  process.once("exit", remove);
  return remove;
}

const isSession = (v: unknown, name: string): v is Session =>
  isRecord(v) &&
  typeof v.pid === "number" &&
  Number.isInteger(v.pid) &&
  v.pid > 0 &&
  name === `${v.pid}.json` &&
  typeof v.started === "number" &&
  typeof v.boot === "number" &&
  typeof v.repo === "string" &&
  (v.claude === undefined || typeof v.claude === "string") &&
  (v.process === undefined || (isRecord(v.process) && typeof v.process.pid === "number" && typeof v.process.start === "string")) &&
  typeof v.install === "string" &&
  typeof v.release === "string" &&
  isList(v.start) &&
  v.start.length > 0 &&
  v.start.every((a) => typeof a === "string");

/**
 * The live sessions in a store's home folder. An entry is skipped when it isn't a small regular
 * file, doesn't parse, has a newer format, or its process ended or started at another time.
 */
export function liveSessions(home: string): Session[] {
  let names: string[];
  try {
    names = readdirSync(dir(home)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const candidates: Session[] = [];
  for (const name of names) {
    const path = join(dir(home), name);
    try {
      const st = lstatSync(path);
      // An entry names a command the pages process may run, so only the user's own entries count.
      if (!st.isFile() || st.size > MAX_ENTRY_BYTES || (process.getuid && st.uid !== process.getuid())) continue;
      const v = readJson<unknown>(path);
      if (isSession(v, name) && typeof v.format === "number" && v.format <= SESSION_FORMAT && alive(v.pid)) candidates.push(v);
    } catch {
      /* gone or unreadable */
    }
  }
  const { ran, starts } = processStarts(candidates.map((s) => s.pid));
  const boot = bootTime(),
    id = bootId();
  return candidates.filter((s) => {
    if (!ran) return s.bootId && id ? s.bootId === id : Math.abs(s.boot - boot) <= BOOT_MARGIN_MS;
    const started = starts.get(s.pid);
    return started !== undefined && sameStart(s, { started, boot, bootId: id });
  });
}

/** hoop's default home folder, `~/.hoop`, whatever HOOP_HOME says. */
const defaultHomeDir = () => join(homedir(), ".hoop");

/**
 * Whether the Claude Code session `session` (whose Claude Code process `procOf` reads) uses the hoop
 * home folder `home`, so hoop keeps this home's reviews for it in the session's folder and messages
 * the session about them. A session uses `home` unless hoop finds that it uses another one: a live
 * `hoop mcp` serving it (by session ID, or by its Claude Code process after `/clear`) registered in
 * the default home and no live one in `home`. That is the session a throwaway hoop on a home of its
 * own was started from: such a hoop keeps its reviews and sends that session nothing. Without that
 * evidence, as before a session's MCP server registers or for hooks and commands alone, the session
 * uses `home`. HOOP_CLAUDE_DIR pairs this process's home with a Claude Code folder of its own, as
 * tests and hoop's throwaway recipes do, so it never looks elsewhere.
 */
export function usesHome(home: string, session: string, procOf: () => OwnerProcess | undefined = () => undefined): boolean {
  const other = defaultHomeDir();
  if (process.env.HOOP_CLAUDE_DIR || realFolder(home) === realFolder(other)) return true;
  let proc: { of?: OwnerProcess } | undefined;
  const serves = (e: Session, parents: () => Map<number, number>) => {
    if (e.claude === session) return true;
    proc ??= { of: procOf() };
    const p = proc.of;
    if (!p) return false;
    // The process recorded at the MCP server's start, else the Claude Code process it runs under now.
    if (e.process) return e.process.pid === p.pid && e.process.start === p.start;
    return descends(e.pid, p.pid, parents());
  };
  const own = homeEvidence(home);
  if (own.entries.some((e) => serves(e, own.parents))) return true;
  const elsewhere = homeEvidence(other);
  return !elsewhere.entries.some((e) => serves(e, elsewhere.parents));
}

/** How long a home's live entries and the process tree stay trusted while its `sessions` folder is unchanged. */
const EVIDENCE_MS = 5_000;
type Evidence = { key: string; at: number; entries: Session[]; parents: () => Map<number, number> };
const evidence = new Map<string, Evidence>();

/**
 * A home's live `hoop mcp` entries, and the process tree to find the Claude Code process each runs
 * under, read again only when its `sessions` folder changed or a few seconds passed, so a review
 * page's polling doesn't run `ps` each time.
 */
function homeEvidence(home: string, now = Date.now()): Evidence {
  let key = "none";
  try {
    key = String(statSync(dir(home)).mtimeMs);
  } catch {
    /* no sessions folder */
  }
  const known = evidence.get(home);
  if (known?.key === key && now - known.at < EVIDENCE_MS) return known;
  let tree: Map<number, number> | undefined;
  const fresh: Evidence = { key, at: now, entries: key === "none" ? [] : liveSessions(home), parents: () => (tree ??= processParents()) };
  evidence.set(home, fresh);
  return fresh;
}

/** Each running process's parent, from one `ps` call; empty when `ps` can't say. */
function processParents(): Map<number, number> {
  const parents = new Map<number, number>();
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    for (const line of out.split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid!, ppid!);
    }
  } catch {
    /* no ps */
  }
  return parents;
}

/**
 * Whether the Claude Code process `pid` runs under is `ancestor`: the nearest process above it, within
 * a few levels (an MCP server may run through `sh` and `npx`), that has a Claude Code session file. A
 * Claude Code process nested in another one stops the walk, so the outer one never matches. Both run
 * now, so a matching process ID is that process, not an earlier one.
 */
function descends(pid: number, ancestor: number, parents: Map<number, number>): boolean {
  let p = parents.get(pid);
  for (let depth = 0; p !== undefined && p > 1 && depth < 5; depth++, p = parents.get(p)) {
    if (p === ancestor) return true;
    if (existsSync(join(claudeDir(), "sessions", `${p}.json`))) return false;
  }
  return false;
}

/** The `.hoop` folder that keeps a session's reviews made in `home` (`sessionHoop`), or undefined when they stay in `home` (`usesHome`). */
export function sessionHoopIn(home: string, session: string | null | undefined, procOf?: () => OwnerProcess | undefined): string | undefined {
  return session && usesHome(home, session, procOf) ? sessionHoop(session) : undefined;
}
