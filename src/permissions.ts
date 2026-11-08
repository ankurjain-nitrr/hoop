import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { hookFields } from "./hook-input.js";
import { newId } from "./ids.js";
import { HoopError, isList, isRecord, tryReadJson, writeJson } from "./util.js";

// Claude Code's permission prompts, answered from hoop's pages too (decided in rv_mw7wkyez20853f).
// While the person has turned it on (`permission_prompts` in hoop's on list), the plugin's
// PermissionRequest hook (`hoop permission-hook`) records each prompt here through the pages process
// and waits: the person answers Allow once or Deny on a page, or in the terminal, which still asks,
// and the first answer wins. hoop never answers by itself, and never answers for a later call.
// A waiting prompt keeps the tool's input in full, so the page can show exactly what it will run or
// change; the input goes once the prompt is answered or handed to the terminal.

/** The name in hoop's on list that turns answering permission prompts from hoop on. */
export const PERMISSION_PROMPTS = "permission_prompts";

/**
 * Whether hoop's on list (the file `on` in hoop's home, which the person writes, one name per line,
 * read as hoop's off list is) names `name`. Parts on it are off until named.
 */
export function isOn(home: string, name: string): boolean {
  let text: string;
  try {
    text = readFileSync(join(home, "on"), "utf8");
  } catch {
    return false;
  }
  return text.split("\n").some((line) => line.trim() === name);
}

/**
 * How a prompt stands: `waiting` for an answer, `allowed` or `denied` in hoop, answered in the
 * `terminal`, or `handed` to the terminal when hoop stopped waiting before anyone answered.
 */
type PermissionState = "waiting" | "allowed" | "denied" | "terminal" | "handed";

export type Permission = {
  id: string;
  session: string;
  agent?: string;
  tool: string;
  /** The tool's input in full, while the prompt waits. */
  input?: Record<string, unknown>;
  at: string;
  state: PermissionState;
  /** When it was answered or handed to the terminal, and by whom in hoop, with Deny's reason for Claude. */
  settled_at?: string;
  by?: string;
  reason?: string;
};

const dir = (home: string) => join(home, "permissions");
const file = (home: string, id: string) => join(dir(home), `${id}.json`);
const isId = (id: unknown): id is string => typeof id === "string" && /^pm_[a-z0-9]{6,40}$/.test(id);
/** How long an answered prompt's record is kept, for the pages to say how it was answered. */
const KEPT_MS = 24 * 60 * 60 * 1000;

/** A prompt's record, or undefined. */
export function readPermission(home: string, id: string): Permission | undefined {
  if (!isId(id)) return undefined;
  const p = tryReadJson<Permission | null>(file(home, id));
  return p && typeof p === "object" && p.id === id ? p : undefined;
}

/** Every prompt's record, newest first. */
export function listPermissions(home: string): Permission[] {
  if (!existsSync(dir(home))) return [];
  return readdirSync(dir(home))
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => readPermission(home, f.slice(0, -5)) ?? [])
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Removes the records of prompts settled more than a day ago. */
function prune(home: string, now: number) {
  for (const p of listPermissions(home))
    if (p.state !== "waiting" && Date.parse(p.settled_at ?? p.at) < now - KEPT_MS) rmSync(file(home, p.id), { force: true });
}

/**
 * Records a prompt from the hook's input, for the pages process; refuses one while permission
 * prompts aren't on in hoop's on list.
 */
export function askPermission(home: string, input: unknown, now = new Date()): { id: string } {
  if (!isOn(home, PERMISSION_PROMPTS)) throw new HoopError(`permission prompts aren't on: add a line ${PERMISSION_PROMPTS} to ${join(home, "on")}`);
  const f = hookFields(input);
  if (f.event !== "PermissionRequest" || !f.session || !f.tool) throw new HoopError("expected a PermissionRequest hook input");
  mkdirSync(dir(home), { recursive: true });
  prune(home, now.getTime());
  const p: Permission = {
    id: newId("pm"),
    session: f.session,
    ...(f.agent ? { agent: f.agent } : {}),
    tool: f.tool,
    input: f.toolInput,
    at: now.toISOString(),
    state: "waiting",
  };
  writeJson(file(home, p.id), p);
  return { id: p.id };
}

/** Words for how a settled prompt was answered, for a refusal. */
const HOW: Record<Exclude<PermissionState, "waiting">, string> = {
  allowed: "it was allowed in hoop",
  denied: "it was denied in hoop",
  terminal: "it was answered in the terminal",
  handed: "hoop stopped waiting, so it is answered in the terminal",
};

/** Settles a waiting prompt, dropping its input; gives the record. */
function settle(home: string, p: Permission, next: Partial<Permission> & { state: PermissionState }, now: Date): Permission {
  const { input: _input, ...rest } = p;
  const done: Permission = { ...rest, ...next, settled_at: now.toISOString() };
  writeJson(file(home, p.id), done);
  return done;
}

/**
 * The person's answer from a page: `allow` once, or `deny` with an optional reason Claude reads.
 * The first answer wins: one for a prompt already answered, here or in the terminal, is refused.
 */
export function answerPermission(home: string, id: string, body: unknown, by: string, now = new Date()): Permission {
  const p = readPermission(home, id);
  if (!p) throw new HoopError(`no permission prompt ${id}`);
  if (p.state !== "waiting") throw new HoopError(`this prompt is already answered: ${HOW[p.state]}`, [], { state: p.state });
  const b = isRecord(body) ? body : {};
  if (b.decision !== "allow" && b.decision !== "deny") throw new HoopError('expected { decision: "allow" } or { decision: "deny", reason? }');
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
  return settle(home, p, b.decision === "allow" ? { state: "allowed", by } : { state: "denied", by, ...(reason ? { reason } : {}) }, now);
}

/** The hook's word that the prompt was answered in the terminal, or that it stopped waiting; a prompt already answered keeps its answer. */
export function settlePermission(home: string, id: string, how: unknown, now = new Date()): Permission | undefined {
  const p = readPermission(home, id);
  if (p?.state !== "waiting") return p;
  if (how !== "terminal" && how !== "handed") throw new HoopError('expected { how: "terminal" } or { how: "handed" }');
  return settle(home, p, { state: how }, now);
}

/** What the hook prints for an answer from hoop, or undefined while there is none. */
export function decisionOutput(p: Permission | undefined): Record<string, unknown> | undefined {
  if (p?.state === "allowed") return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
  if (p?.state !== "denied") return undefined;
  const message = p.reason ? `The person denied this in hoop: ${p.reason}` : "The person denied this in hoop.";
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } } };
}

/** The last part of a transcript a check reads: enough for the turn that asked. */
const TAIL_BYTES = 512 * 1024;

/** The transcript's last lines, parsed; a line cut at the start of the tail, or one that isn't JSON, is skipped. */
function tailEntries(transcript: string): Record<string, unknown>[] {
  let text: string;
  try {
    const size = statSync(transcript).size;
    const buf = readFileSync(transcript);
    text = buf.subarray(Math.max(0, size - TAIL_BYTES)).toString("utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      const v: unknown = JSON.parse(line);
      return isRecord(v) ? [v] : [];
    } catch {
      return [];
    }
  });
}

/** The content blocks of a transcript entry's message. */
const blocks = (e: Record<string, unknown>): Record<string, unknown>[] => {
  const m = e.message;
  const c = isRecord(m) ? m.content : undefined;
  return isList(c) ? c.filter(isRecord) : [];
};

/** Whether a call's input is the prompt's: every field both have agrees, and they share one. */
function sameInput(call: unknown, prompt: Record<string, unknown>): boolean {
  if (!isRecord(call)) return false;
  const shared = Object.keys(prompt).filter((k) => k in call);
  return shared.length > 0 && shared.every((k) => JSON.stringify(call[k]) === JSON.stringify(prompt[k]));
}

/** The IDs of the calls in a transcript's tail that have their result. */
const results = (entries: Record<string, unknown>[]) =>
  new Set(entries.flatMap((e) => blocks(e).flatMap((b) => (b.type === "tool_result" && typeof b.tool_use_id === "string" ? [b.tool_use_id] : []))));

/**
 * The call a prompt is for, in the session's transcript: the latest call of its tool and input that
 * has no result yet. An earlier call of the same command, which has its result, is never it.
 */
export function openCall(transcript: string, tool: string, input: Record<string, unknown>): string | undefined {
  const entries = tailEntries(transcript);
  const done = results(entries);
  let id: string | undefined;
  for (const e of entries)
    for (const b of blocks(e))
      if (b.type === "tool_use" && b.name === tool && typeof b.id === "string" && !done.has(b.id) && sameInput(b.input, input)) id = b.id;
  return id;
}

/** Whether the call `id` has its result in the transcript: the person answered in the terminal (it ran, or was denied). */
export const hasResult = (transcript: string, id: string) => results(tailEntries(transcript)).has(id);
