// The Claude Code sessions running on this machine, from `<claude dir>/sessions/<pid>.json`, and
// which of them acts as a review's or a todo's owner, under a new session ID after `/clear` too.
import { join } from "node:path";
import { type Owner, type OwnerProcess, validSession } from "./owner.js";
import { alive, lstartTimes, processStarts, START_MARGIN_MS } from "./proc.js";
import { claudeDir, opt, readJsonDir } from "./util.js";
import type { ReviewMeta } from "./store.js";

/** A Claude Code session as `<claude dir>/sessions/<pid>.json` describes it. */
export type ClaudeSession = {
  session: string;
  pid: number;
  status?: string;
  name?: string;
  cwd?: string;
  updatedAt?: number;
  /** What its open dialog waits for (`waitingFor`, such as "input needed"), while `status` is "waiting". */
  waitingFor?: string;
  /** The Unix socket the session takes messages on (`messagingSocketPath`), when it has one. */
  socket?: string;
  /** When its process started (`procStart`), which stays the same while the session ID changes. */
  start?: string;
  /** When the session started, in milliseconds (`startedAt`). */
  startedAt?: number;
};
/** Reads the Claude Code sessions running now. Injectable, so tests need no real Claude Code. */
export type SessionReader = () => ClaudeSession[];

/** How long a process's start, checked against its `procStart`, is trusted before `ps` is asked again. */
const START_CHECK_MS = 30_000;
const startChecks = new Map<string, { at: number; ok: boolean }>();

/**
 * The sessions whose process started when their file says (`procStart`), so a file left by a killed
 * process doesn't count once its process ID is reused. A session without a readable `procStart`, or
 * when `ps` can't say, is kept as it was.
 */
function startedWhenRecorded(sessions: ClaudeSession[], now = Date.now()): ClaudeSession[] {
  const key = (s: ClaudeSession) => `${s.pid}:${s.start}`;
  const unchecked = sessions.filter((s) => {
    if (!s.start || !lstartTimes(s.start).length) return false;
    const c = startChecks.get(key(s));
    return !c || now - c.at > START_CHECK_MS;
  });
  if (unchecked.length) {
    const { ran, starts } = processStarts(unchecked.map((s) => s.pid));
    if (ran)
      for (const s of unchecked) {
        const started = starts.get(s.pid);
        const ok = started !== undefined && lstartTimes(s.start!).some((t) => Math.abs(t - started) <= START_MARGIN_MS);
        startChecks.set(key(s), { at: now, ok });
      }
  }
  return sessions.filter((s) => startChecks.get(key(s))?.ok !== false);
}

/**
 * The running Claude Code sessions, from `<claude dir>/sessions/<pid>.json`, skipping files whose
 * process is gone or started at another time than the file says.
 */
export const claudeSessions: SessionReader = () => startedWhenRecorded(readSessionFiles(join(claudeDir(), "sessions")));

function readSessionFiles(folder: string): ClaudeSession[] {
  return readJsonDir<Record<string, unknown> | null>(folder, (n) => /^\d+\.json$/.test(n)).flatMap(([, v]) => {
    try {
      const session = v && typeof v === "object" ? sessionFile(v) : undefined;
      return session ? [session] : [];
    } catch {
      return [];
    }
  });
}

/** A session file's running session, or undefined when it names none or its process is gone. */
function sessionFile(v: Record<string, unknown>): ClaudeSession | undefined {
  const session = validSession(v.sessionId);
  const pid = Number(v.pid);
  if (!session || !Number.isInteger(pid) || pid <= 0 || !alive(pid)) return undefined;
  const text = (x: unknown) => (typeof x === "string" ? x : undefined);
  return {
    session,
    pid,
    ...(typeof v.status === "string" ? { status: v.status } : {}),
    ...opt("name", text(v.name)?.trim()),
    ...(typeof v.cwd === "string" ? { cwd: v.cwd } : {}),
    ...(typeof v.updatedAt === "number" ? { updatedAt: v.updatedAt } : {}),
    ...opt("waitingFor", text(v.waitingFor)),
    ...opt("socket", text(v.messagingSocketPath)),
    ...opt("start", text(v.procStart)),
    ...(Number.isFinite(v.startedAt) ? { startedAt: Number(v.startedAt) } : {}),
  };
}

/** The Claude Code process a running session runs in, for its owner record, or undefined. */
export function processOf(session: string, sessions: SessionReader = claudeSessions): OwnerProcess | undefined {
  try {
    const s = sessions().find((x) => x.session === session);
    return s?.start ? { pid: s.pid, start: s.start } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The running Claude Code session of an owner: the one with its session ID, else the one now running
 * in the process it ran in. `/clear` gives a running process a new session ID; the process ID and its
 * start time stay, and a reused process ID starts at another time.
 */
export function ownerSession(owner: Pick<Owner, "session" | "process">, sessions: ClaudeSession[]): ClaudeSession | undefined {
  const p = owner.process;
  return sessions.find((s) => s.session === owner.session) ?? (p ? sessions.find((s) => s.pid === p.pid && s.start === p.start) : undefined);
}

/**
 * Whether `session` acts as `owner`: it is the owner's session, or the Claude Code session running
 * now in the process the owner record names, as after `/clear`. The caller's process is looked up in
 * Claude Code's session files, never taken from the caller.
 */
export function actsAs(owner: Owner | undefined, session: string | null | undefined, sessions: SessionReader = claudeSessions): boolean {
  if (!owner || !session) return false;
  if (owner.session === session) return true;
  const p = owner.claude === false ? undefined : owner.process;
  if (!p) return false;
  const now = processOf(session, sessions);
  return Boolean(now && now.pid === p.pid && now.start === p.start);
}

/** Whether a session is the review's owner: its session, an earlier one before `/clear`, or the one in its process since. */
export const ownedBy = (meta: ReviewMeta, session: string) => Boolean(meta.owner && (meta.owners?.includes(session) || actsAs(meta.owner, session)));
