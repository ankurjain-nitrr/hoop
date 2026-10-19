import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { uptime } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ownInstall, release } from "./version.js";
import { writeAtomic } from "./util.js";

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
  repo: string;
  install: string;
  release: string;
  /** The arguments that start this install's CLI, run without a shell. */
  start: string[];
};

/** Start and boot times measured by two processes match within these margins. */
const START_MARGIN_MS = 5_000;
const BOOT_MARGIN_MS = 120_000;
/** An entry is a few hundred bytes; anything larger isn't one. */
const MAX_ENTRY_BYTES = 64 * 1024;

export const bootTime = () => Date.now() - uptime() * 1000;

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
  return createHash("sha256").update(realFolder(home)).digest("hex").slice(0, 16);
}

function realFolder(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

/** Seconds from a `ps` elapsed time, `[[days-]hours:]minutes:seconds`, or undefined. */
export function parseElapsed(text: string): number | undefined {
  const m = text.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return undefined;
  const [, d = "0", h = "0", min, sec] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec);
}

/** When each process started, from one `ps` call; a process `ps` can't report is missing. */
function processStarts(pids: number[]): Map<number, number> {
  const starts = new Map<number, number>();
  if (!pids.length) return starts;
  let out: string;
  try {
    out = execFileSync("ps", ["-o", "pid=,etime=", "-p", pids.join(",")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
  } catch (err) {
    // ps exits 1 when some process is gone, and still prints the others.
    out = String((err as { stdout?: unknown }).stdout ?? "");
  }
  const now = Date.now();
  for (const line of out.split("\n")) {
    const [pid, etime] = line.trim().split(/\s+/);
    const seconds = parseElapsed(etime ?? "");
    if (seconds !== undefined && pids.includes(Number(pid))) starts.set(Number(pid), now - seconds * 1000);
  }
  return starts;
}

/** When one process started, from `ps`, or undefined when `ps` can't say. */
export const processStart = (pid: number) => processStarts([pid]).get(pid);

/**
 * True when a start time read now matches the one an entry recorded. `ps` counts from the wall clock
 * on some systems and from boot on others, so a wall clock step since then is allowed for in both.
 */
export function sameStart(entry: { started: number; boot: number }, now: { started: number; boot: number }): boolean {
  return Math.abs(now.started - entry.started) <= START_MARGIN_MS
    || Math.abs((now.started - now.boot) - (entry.started - entry.boot)) <= START_MARGIN_MS;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Records this process as a live session for `repo`, and removes the record at exit or on a signal. Returns the remover. */
export function registerSession(home: string, repo: string): () => void {
  const install = ownInstall();
  const entry: Session = {
    format: SESSION_FORMAT, pid: process.pid, started: Date.now() - process.uptime() * 1000, boot: bootTime(),
    repo: realFolder(repo), install, release: release(install) ?? "0", start: startCommand(),
  };
  mkdirSync(dir(home), { recursive: true });
  const file = join(dir(home), `${process.pid}.json`);
  writeAtomic(file, JSON.stringify(entry));
  const signals = [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]] as const;
  const onSignal = signals.map(([sig, n]) => [sig, () => { remove(); process.exit(128 + n); }] as const);
  const remove = () => {
    process.off("exit", remove);
    for (const [sig, fn] of onSignal) process.off(sig, fn);
    rmSync(file, { force: true });
  };
  process.once("exit", remove);
  // A signal ends the process without "exit", so remove the entry first and then exit as the signal would.
  for (const [sig, fn] of onSignal) process.once(sig, fn);
  return remove;
}

const isSession = (v: any, name: string): v is Session =>
  v && typeof v === "object" && Number.isInteger(v.pid) && v.pid > 0 && name === `${v.pid}.json`
  && typeof v.started === "number" && typeof v.boot === "number" && typeof v.repo === "string"
  && typeof v.install === "string" && typeof v.release === "string"
  && Array.isArray(v.start) && v.start.length > 0 && v.start.every((a: unknown) => typeof a === "string");

/**
 * The live sessions in a store's home folder. An entry is skipped when it isn't a small regular
 * file, doesn't parse, has a newer format, or its process ended or started at another time.
 */
export function liveSessions(home: string): Session[] {
  let names: string[];
  try { names = readdirSync(dir(home)).filter((n) => n.endsWith(".json")); } catch { return []; }
  const candidates: Session[] = [];
  for (const name of names) {
    const path = join(dir(home), name);
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size > MAX_ENTRY_BYTES) continue;
      const v = JSON.parse(readFileSync(path, "utf8"));
      if (isSession(v, name) && typeof v.format === "number" && v.format <= SESSION_FORMAT && alive(v.pid)) candidates.push(v);
    } catch { /* gone or unreadable */ }
  }
  const starts = processStarts(candidates.map((s) => s.pid)), boot = bootTime();
  return candidates.filter((s) => {
    const started = starts.get(s.pid);
    return started === undefined ? Math.abs(s.boot - boot) <= BOOT_MARGIN_MS : sameStart(s, { started, boot });
  });
}
