// Processes and the machine they run on: whether a process runs, when it started, and when the
// machine booted, so a record left by a process whose ID was reused doesn't count as live.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import { isRecord } from "./util.js";

/** Start and boot times measured by two processes match within these margins. */
export const START_MARGIN_MS = 5_000;
const BOOT_MARGIN_MS = 120_000;

/** Whether a process runs (one owned by another user counts). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isRecord(err) && err.code === "EPERM";
  }
}

/** When the machine booted, in milliseconds. */
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

/**
 * When a `ps -o lstart` start time says a process started, in milliseconds: Claude Code writes it
 * in UTC ("Fri Oct 23 17:11:53 2026"), and local time is allowed for too. Empty when it can't be read.
 */
export function lstartTimes(text: string): number[] {
  return [Date.parse(`${text} UTC`), Date.parse(text)].filter((t) => Number.isFinite(t));
}

type Times = { started: number; boot: number; bootId?: string };

/** True when two boot measurements are the same boot: by boot ID where both have one, else by boot time. */
export function sameBoot(entry: Omit<Times, "started">, now: Omit<Times, "started">): boolean {
  return entry.bootId && now.bootId ? entry.bootId === now.bootId : Math.abs(now.boot - entry.boot) <= BOOT_MARGIN_MS;
}

/**
 * True when a start time read now matches the one an entry recorded. `ps` counts from the wall clock
 * on some systems and from boot on others, so a wall clock step since then is allowed for in both.
 * The match from boot counts only within the same boot, so a process ID reused after a reboot fails.
 */
export function sameStart(entry: Times, now: Times): boolean {
  if (Math.abs(now.started - entry.started) <= START_MARGIN_MS) return true;
  return sameBoot(entry, now) && Math.abs(now.started - now.boot - (entry.started - entry.boot)) <= START_MARGIN_MS;
}
