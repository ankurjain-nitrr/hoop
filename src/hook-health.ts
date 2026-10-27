import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { transcriptActivity } from "./activity.js";
import { sessionName, validSession } from "./owner.js";
import { writeAtomic } from "./util.js";
import { type ClaudeSession, readWork, sessionTranscript } from "./work.js";

// Whether a session's hooks run. Each hook input that reaches the pages process (work-hook,
// work-gate, pr-hook) leaves a stamp, `hooks/<session>.json`: the last time each event fired, and the
// plugin version that sent the latest. The Work page warns about a running session whose transcript
// shows work its hooks never reported.

/** A session's stamps: the last time each hook event fired, and `PostToolUse:todo` for the todo tools. */
export type HookStamps = Record<string, string>;
/** A session's stamp file: its stamps, and the plugin version (`HOOP_PLUGIN_VERSION`) of the latest, when the plugin named one. */
export type StampFile = { events: HookStamps; plugin?: string };

/** The todo tools whose PostToolUse hook records todos. */
const TODO_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop", "TodoWrite"]);
export const TODO_STAMP = "PostToolUse:todo";

/** How long a hook gets to report a finished turn or todo call before the page says hooks don't run. */
export const HOOK_GRACE_MS = 60_000;

const stampFile = (home: string, session: string) => join(home, "hooks", `${session}.json`);

/** A session's stamp file; empty stamps when it has none or they can't be read. */
export function readStampFile(home: string, session: string): StampFile {
  if (!validSession(session)) return { events: {} };
  try {
    const v = JSON.parse(readFileSync(stampFile(home, session), "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v) || !v.events || typeof v.events !== "object") return { events: {} };
    return { events: v.events as HookStamps, ...(typeof v.plugin === "string" ? { plugin: v.plugin } : {}) };
  } catch {
    return { events: {} };
  }
}

/** Deletes a session's stamps, with its removed work record; the next hook stamps afresh. */
export const dropStamps = (home: string, session: string) => {
  if (validSession(session)) rmSync(stampFile(home, session), { force: true });
};

/** When any of a session's hooks last reached hoop, in milliseconds; 0 for none. */
export const lastStamp = (home: string, session: string) => Math.max(0, ...Object.values(readStamps(home, session)).map((t) => Date.parse(t) || 0));

/** A session's stamps; empty when it has none or they can't be read. */
export const readStamps = (home: string, session: string): HookStamps => readStampFile(home, session).events;

/** A plugin version as hoop.sh reads it from the plugin's plugin.json, or undefined. */
export const pluginVersion = (v: unknown) => (typeof v === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(v) ? v : undefined);

/**
 * Records that a hook ran, from its input, and the plugin version that ran it (none from a plugin
 * older than the stamps). Run only in the pages process, the one writer; never throws.
 */
export function stampHook(home: string, input: unknown, now = new Date().toISOString(), plugin?: unknown): void {
  try {
    const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const session = validSession(i.session_id);
    const event = typeof i.hook_event_name === "string" && /^[A-Za-z]{1,40}$/.test(i.hook_event_name) ? i.hook_event_name : undefined;
    if (!session || !event) return;
    const events = { ...readStamps(home, session), [event]: now };
    if (event === "PostToolUse" && TODO_TOOLS.has(String(i.tool_name))) events[TODO_STAMP] = now;
    const version = pluginVersion(plugin);
    mkdirSync(dirname(stampFile(home, session)), { recursive: true });
    writeAtomic(stampFile(home, session), `${JSON.stringify({ session, events, ...(version ? { plugin: version } : {}) }, null, 2)}\n`);
  } catch {
    /* a stamp is a nicety: the hook's own write goes on */
  }
}

/**
 * A running session whose hooks don't reach hoop: none ran at all (`all`), some ran but from a plugin
 * too old to stamp its turn ends (`outdated`), or none for its todo calls (`todos`).
 */
export type HookWarning = { session: string; name?: string; folder?: string; missing: "all" | "outdated" | "todos" };

/**
 * The running sessions whose hooks don't fire, since `since` (when the pages process started, since
 * hooks drop their input while none runs) or the session's start (`startedAt`), whichever is later.
 * For a session idle after a turn that ended more than HOOK_GRACE_MS ago (not interrupted, and not
 * an API error, which runs StopFailure instead of Stop): `all` with no stamp since then; `outdated`
 * with stamps but no Stop among them, or none from a plugin that names its version. Else `todos` for
 * a todo call that succeeded that long ago (PostToolUse runs only on success, and the gate refuses
 * some by design) with no todo stamp. A session with no turn since it started is only idle.
 */
export function hookWarnings(home: string, sessions: ClaudeSession[], since: number, now = Date.now()): HookWarning[] {
  return sessions.flatMap((s) => {
    const from = Math.max(since, s.startedAt !== undefined && s.startedAt <= now ? s.startedAt : since);
    const after = (at: string | undefined) => at !== undefined && Date.parse(at) >= from;
    const settled = (at: string) => after(at) && now - Date.parse(at) >= HOOK_GRACE_MS;
    const path = sessionTranscript({ session: s.session, transcript: readWork(home, s.session)?.transcript });
    const activity = path ? transcriptActivity(path, s.cwd) : undefined;
    if (!activity) return [];
    const { events, plugin } = readStampFile(home, s.session);
    const idle = s.status !== "busy" && s.status !== "waiting";
    const finished = activity.said && !(activity.interrupted && activity.interrupted >= activity.said) ? activity.said : undefined;
    let missing: HookWarning["missing"] | undefined;
    if (idle && finished && settled(finished)) missing = !Object.values(events).some(after) ? "all" : !after(events.Stop) || !plugin ? "outdated" : undefined;
    const failed = new Set(activity.failed ?? []);
    if (
      !missing &&
      !after(events[TODO_STAMP]) &&
      activity.steps.some(
        (st, n) => TODO_TOOLS.has(st.tool) && !failed.has(n) && settled(st.at) && !(activity.open?.at === st.at && activity.open.tool === st.tool),
      )
    )
      missing = "todos";
    if (!missing) return [];
    const name = sessionName(s.session, home) ?? s.name;
    return [{ session: s.session, ...(name ? { name } : {}), ...(s.cwd ? { folder: basename(s.cwd) } : {}), missing }];
  });
}
