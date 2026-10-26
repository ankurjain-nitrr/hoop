import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { transcriptActivity } from "./activity.js";
import { sessionName, validSession } from "./owner.js";
import { writeAtomic } from "./util.js";
import { type ClaudeSession, procStartTimes, readWork, sessionTranscript } from "./work.js";

// Whether a session's hooks run. Each hook input that reaches the pages process (work-hook,
// work-gate, pr-hook) leaves a stamp, `hooks/<session>.json`: the last time each event fired. The
// Work page warns about a running session whose transcript shows work its hooks never reported.

/** A session's stamps: the last time each hook event fired, and `PostToolUse:todo` for the todo tools. */
export type HookStamps = Record<string, string>;

/** The todo tools whose PostToolUse hook records todos. */
const TODO_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop", "TodoWrite"]);
export const TODO_STAMP = "PostToolUse:todo";

/** How long a hook gets to report a finished turn or todo call before the page says hooks don't run. */
export const HOOK_GRACE_MS = 60_000;

const stampFile = (home: string, session: string) => join(home, "hooks", `${session}.json`);

/** A session's stamps; empty when it has none or they can't be read. */
export function readStamps(home: string, session: string): HookStamps {
  if (!validSession(session)) return {};
  try {
    const v = JSON.parse(readFileSync(stampFile(home, session), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) && v.events && typeof v.events === "object" ? (v.events as HookStamps) : {};
  } catch {
    return {};
  }
}

/** Records that a hook ran, from its input. Run only in the pages process, the one writer; never throws. */
export function stampHook(home: string, input: unknown, now = new Date().toISOString()): void {
  try {
    const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const session = validSession(i.session_id);
    const event = typeof i.hook_event_name === "string" && /^[A-Za-z]{1,40}$/.test(i.hook_event_name) ? i.hook_event_name : undefined;
    if (!session || !event) return;
    const events = { ...readStamps(home, session), [event]: now };
    if (event === "PostToolUse" && TODO_TOOLS.has(String(i.tool_name))) events[TODO_STAMP] = now;
    mkdirSync(dirname(stampFile(home, session)), { recursive: true });
    writeAtomic(stampFile(home, session), `${JSON.stringify({ session, events }, null, 2)}\n`);
  } catch {
    /* a stamp is a nicety: the hook's own write goes on */
  }
}

/** A running session whose hooks don't reach hoop: none ran at all, or none for its todo calls. */
export type HookWarning = { session: string; name?: string; folder?: string; missing: "all" | "todos" };

/** When a session's process started, by its `procStart`, if that can be read and isn't in the future. */
function startedAt(s: ClaudeSession, now: number): number | undefined {
  const times = s.start ? procStartTimes(s.start).filter((t) => t <= now) : [];
  return times.length ? Math.max(...times) : undefined;
}

/**
 * The running sessions whose hooks don't fire, since `since` (when the pages process started, since
 * hooks drop their input while none runs) or the session's start, whichever is later. A session that
 * is idle after a turn its transcript shows ended (not interrupted) more than HOOK_GRACE_MS ago, with no stamp: no hook ran
 * (its Stop hook should have). Else one with a finished todo call that long ago and no todo stamp:
 * its PostToolUse hooks don't run. A session with no turn since it started is only idle.
 */
export function hookWarnings(home: string, sessions: ClaudeSession[], since: number, now = Date.now()): HookWarning[] {
  return sessions.flatMap((s) => {
    const from = Math.max(since, startedAt(s, now) ?? since);
    const after = (at: string | undefined) => at !== undefined && Date.parse(at) >= from;
    const settled = (at: string) => after(at) && now - Date.parse(at) >= HOOK_GRACE_MS;
    const path = sessionTranscript({ session: s.session, transcript: readWork(home, s.session)?.transcript });
    const activity = path ? transcriptActivity(path, s.cwd) : undefined;
    if (!activity) return [];
    const stamps = readStamps(home, s.session);
    const idle = s.status !== "busy" && s.status !== "waiting";
    let missing: HookWarning["missing"] | undefined;
    // A turn the person interrupted ends with no Stop hook.
    const finished = activity.said && !(activity.interrupted && activity.interrupted >= activity.said) ? activity.said : undefined;
    if (idle && finished && settled(finished) && !Object.values(stamps).some(after)) missing = "all";
    else if (
      !after(stamps[TODO_STAMP]) &&
      activity.steps.some((st) => TODO_TOOLS.has(st.tool) && settled(st.at) && !(activity.open?.at === st.at && activity.open.tool === st.tool))
    )
      missing = "todos";
    if (!missing) return [];
    const name = sessionName(s.session, home) ?? s.name;
    return [{ session: s.session, ...(name ? { name } : {}), ...(s.cwd ? { folder: basename(s.cwd) } : {}), missing }];
  });
}
