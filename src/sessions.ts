import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
  /** When the machine booted, used in place of `started` where `ps` is missing. */
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

export const bootTime = () => Date.now() - uptime() * 1000;

const dir = (home: string) => join(home, "sessions");

/** The arguments that start this install's CLI: Node, its loader arguments (such as tsx), and the CLI module. */
export function startCommand(): string[] {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return [process.execPath, ...process.execArgv, fileURLToPath(new URL(`./cli${ext}`, import.meta.url))];
}

/** A key for a store's home folder, like a repository's key: the same folder always gives the same key. */
export function storeKey(home: string): string {
  let real = resolve(home);
  try { real = realpathSync.native(home); } catch { /* not created yet */ }
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

/** When a process started, from `ps`, or undefined when `ps` can't say. */
export function processStart(pid: number): number | undefined {
  let out: string;
  try {
    out = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
  } catch {
    return undefined;
  }
  // [[days-]hours:]minutes:seconds
  const m = out.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return undefined;
  const [, d = "0", h = "0", min, sec] = m;
  return Date.now() - (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec)) * 1000;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Records this process as a live session for `repo`, and removes the record at exit. Returns the remover. */
export function registerSession(home: string, repo: string): () => void {
  const install = ownInstall();
  const entry: Session = {
    format: SESSION_FORMAT, pid: process.pid, started: Date.now() - process.uptime() * 1000, boot: bootTime(), repo: resolve(repo), install,
    release: release(install) ?? "0", start: startCommand(),
  };
  mkdirSync(dir(home), { recursive: true });
  const file = join(dir(home), `${process.pid}.json`);
  writeAtomic(file, JSON.stringify(entry));
  const remove = () => rmSync(file, { force: true });
  process.once("exit", remove);
  return remove;
}

const isSession = (v: any): v is Session =>
  v && typeof v === "object" && Number.isInteger(v.pid) && typeof v.started === "number" && typeof v.boot === "number" && typeof v.repo === "string"
  && typeof v.install === "string" && typeof v.release === "string"
  && Array.isArray(v.start) && v.start.length > 0 && v.start.every((a: unknown) => typeof a === "string");

/** The live sessions in a store's home folder. Entries that don't parse, have a newer format, or whose process ended are skipped. */
export function liveSessions(home: string): Session[] {
  let names: string[];
  try { names = readdirSync(dir(home)).filter((n) => n.endsWith(".json")); } catch { return []; }
  const boot = bootTime();
  const out: Session[] = [];
  for (const name of names) {
    let v: unknown;
    try { v = JSON.parse(readFileSync(join(dir(home), name), "utf8")); } catch { continue; }
    if (!isSession(v) || typeof v.format !== "number" || v.format > SESSION_FORMAT) continue;
    if (!alive(v.pid)) continue;
    const started = processStart(v.pid);
    if (started === undefined ? Math.abs(v.boot - boot) > BOOT_MARGIN_MS : Math.abs(started - v.started) > START_MARGIN_MS) continue;
    out.push(v);
  }
  return out;
}
