import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withLock } from "./lock.js";
import { claudeDir, sessionName, validSession } from "./owner.js";
import { writeAtomic } from "./util.js";

/** A todo as the Work page shows it. `active` is the text Claude Code shows while it runs. */
export type WorkTodo = { id: string; text: string; active?: string; status: "queued" | "running" | "done"; order: number; updated: string };

/** A subagent a session started. `last` is its last step as hoop last saw it. */
export type WorkAgent = {
  id: string;
  description?: string;
  type?: string;
  status: "running" | "done" | "stopped";
  started: string;
  ended?: string;
  transcript?: string;
  last?: string;
  /** The Agent tool call that started it, when known. */
  call?: string;
};

/** An Agent tool call seen before its subagent started, waiting to be paired with it. */
type PendingCall = { call: string; description?: string; type: string; at: string };

/** One session's work, as `<hoop home>/work/<session>.json` keeps it. */
export type WorkRecord = {
  session: string;
  cwd?: string;
  transcript?: string;
  updated: string;
  todos: WorkTodo[];
  agents: WorkAgent[];
  pending: PendingCall[];
  /** Tasks deleted, so a late hook doesn't bring one back. */
  deleted?: string[];
};

/** What one hook call changes in a session's work. */
export type WorkEvent =
  | { kind: "todos"; todos: { id?: string; text: string; active?: string; status: string }[] }
  | { kind: "todo"; id: string; text?: string; active?: string; status?: string; created?: true }
  | { kind: "call"; call: string; description?: string; type: string }
  | { kind: "agent-start"; id: string; type?: string; transcript?: string }
  | {
      kind: "agent-end";
      id?: string;
      call?: string;
      description?: string;
      type?: string;
      status: "running" | "done" | "stopped";
      transcript?: string;
      last?: string;
    };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : undefined);
/** A tool's response as an object: Claude Code passes some as JSON text. */
const response = (v: unknown): Obj | undefined => {
  if (typeof v !== "string") return obj(v);
  try {
    return obj(JSON.parse(v));
  } catch {
    return undefined;
  }
};

/** The subagent type Claude Code uses when the Agent tool names none. */
const DEFAULT_TYPE = "general-purpose";

/** One line of text, at most `max` characters. */
const oneLine = (text: string, max = 200) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * The work events in one Claude Code hook input: PreToolUse and PostToolUse on the task tools
 * (TaskCreate, TaskUpdate, TaskList, legacy TodoWrite) and the Agent tool (once Task), TaskStop,
 * and SubagentStart and SubagentStop. Anything else gives none.
 */
export function workEvents(input: unknown): WorkEvent[] {
  const i = obj(input);
  if (!i) return [];
  const event = i.hook_event_name;
  if (event === "SubagentStart" || event === "SubagentStop") {
    const id = str(i.agent_id);
    if (!id) return [];
    const type = str(i.agent_type);
    const transcript = str(i.agent_transcript_path);
    if (event === "SubagentStart") return [{ kind: "agent-start", id, ...(type ? { type } : {}), ...(transcript ? { transcript } : {}) }];
    const last = str(i.last_assistant_message);
    return [
      { kind: "agent-end", id, status: "done", ...(type ? { type } : {}), ...(transcript ? { transcript } : {}), ...(last ? { last: oneLine(last) } : {}) },
    ];
  }
  const tool = i.tool_name,
    input_ = obj(i.tool_input) ?? {},
    out = response(i.tool_response),
    call = str(i.tool_use_id);
  if (event === "PreToolUse") {
    if ((tool === "Agent" || tool === "Task") && call && !input_.taskId)
      return [
        { kind: "call", call, type: str(input_.subagent_type) ?? DEFAULT_TYPE, ...(str(input_.description) ? { description: str(input_.description) } : {}) },
      ];
    return [];
  }
  if (event !== "PostToolUse") return [];
  switch (tool) {
    case "TodoWrite": {
      const todos = Array.isArray(input_.todos) ? input_.todos : [];
      return [
        {
          kind: "todos",
          todos: todos.flatMap((t) => {
            const o = obj(t);
            const text = str(o?.content) ?? str(o?.subject);
            return o && text ? [{ ...(str(o.id) ? { id: str(o.id) } : {}), text, active: str(o.activeForm), status: str(o.status) ?? "pending" }] : [];
          }),
        },
      ];
    }
    case "TaskCreate": {
      const task = obj(out?.task) ?? out;
      const id = str(task?.id) ?? str(task?.taskId) ?? str(task?.task_id);
      const text = str(input_.subject) ?? str(task?.subject);
      return id && text
        ? [{ kind: "todo", id, text, status: "pending", created: true, ...(str(input_.activeForm) ? { active: str(input_.activeForm) } : {}) }]
        : [];
    }
    case "TaskUpdate": {
      const id = str(input_.taskId) ?? str(input_.task_id) ?? str(input_.id) ?? str(out?.taskId);
      if (!id || out?.success === false) return [];
      const e: WorkEvent = { kind: "todo", id };
      if (str(input_.subject)) e.text = str(input_.subject);
      if (str(input_.activeForm)) e.active = str(input_.activeForm);
      if (str(input_.status)) e.status = str(input_.status);
      return [e];
    }
    case "TaskList": {
      const tasks = Array.isArray(out?.tasks) ? out.tasks : undefined;
      if (!tasks) return [];
      return [
        {
          kind: "todos",
          todos: tasks.flatMap((t) => {
            const o = obj(t);
            const id = str(o?.id),
              text = str(o?.subject);
            return o && id && text ? [{ id, text, status: str(o.status) ?? "pending" }] : [];
          }),
        },
      ];
    }
    case "TaskGet": {
      const task = obj(out?.task);
      const id = str(task?.id);
      return task && id
        ? [{ kind: "todo", id, ...(str(task.subject) ? { text: str(task.subject) } : {}), ...(str(task.status) ? { status: str(task.status) } : {}) }]
        : [];
    }
    case "TaskStop": {
      const id = str(input_.task_id) ?? str(input_.shell_id) ?? str(out?.task_id);
      return id ? [{ kind: "agent-end", id, status: "stopped" }] : [];
    }
    case "Agent":
    case "Task": {
      // Before the task tools, "Task" was the subagent tool; a "Task" call with a taskId is neither.
      if (input_.taskId) return [];
      const id = str(out?.agentId) ?? str(out?.agent_id);
      const launched = out?.status === "async_launched";
      const text = Array.isArray(out?.content) ? out.content.map((c) => str(obj(c)?.text) ?? "").join(" ") : str(out?.content);
      return [
        {
          kind: "agent-end",
          ...(id ? { id } : {}),
          ...(call ? { call } : {}),
          ...(str(input_.description) ? { description: str(input_.description) } : {}),
          type: str(input_.subagent_type) ?? DEFAULT_TYPE,
          status: launched ? "running" : out?.status === "completed" || !out?.status ? "done" : "stopped",
          ...(str(out?.outputFile) ? { transcript: str(out?.outputFile) } : {}),
          ...(!launched && text?.trim() ? { last: oneLine(text) } : {}),
        },
      ];
    }
    default:
      return [];
  }
}

const STATUS: Record<string, WorkTodo["status"]> = { pending: "queued", in_progress: "running", completed: "done" };

const dir = (home: string) => join(home, "work");
const file = (home: string, session: string) => join(dir(home), `${session}.json`);

/** A session's work record, or undefined when there is none or it can't be read. */
export function readWork(home: string, session: string): WorkRecord | undefined {
  if (!validSession(session)) return undefined;
  try {
    const v = JSON.parse(readFileSync(file(home, session), "utf8")) as WorkRecord;
    if (v?.session !== session || !Array.isArray(v.todos) || !Array.isArray(v.agents)) return undefined;
    return { ...v, pending: Array.isArray(v.pending) ? v.pending : [] };
  } catch {
    return undefined;
  }
}

/** How many Agent calls a session keeps waiting for their subagents, and for how long. */
const PENDING_MAX = 20,
  DELETED_MAX = 200,
  PENDING_MS = 10 * 60_000;

/** Applies one event to a record, in place. */
export function applyEvent(r: WorkRecord, e: WorkEvent, now: string, sessionTranscript?: string) {
  // A subagent's transcript sits beside its session's: `<folder>/<session>/subagents/agent-<id>.jsonl`.
  const agentTranscript = (id: string) => (sessionTranscript ? join(dirname(sessionTranscript), r.session, "subagents", `agent-${id}.jsonl`) : undefined);
  switch (e.kind) {
    case "todos": {
      const known = new Map(r.todos.map((t) => [t.id, t]));
      r.deleted = [];
      r.todos = e.todos.flatMap((t, n) => {
        if (t.status === "deleted") return [];
        const id = t.id ?? String(n + 1);
        const was = known.get(id);
        const status = STATUS[t.status] ?? "queued";
        const same = was && was.text === t.text && was.status === status;
        return [
          {
            id,
            text: t.text,
            ...(t.active ? { active: t.active } : {}),
            status,
            order: /^\d{1,9}$/.test(id) ? Number(id) : n + 1,
            updated: same ? was.updated : now,
          },
        ];
      });
      r.todos.sort((a, b) => a.order - b.order);
      return;
    }
    case "todo": {
      // Async hooks may arrive out of order: a deleted task stays deleted, a creation never undoes a
      // later update, and an update before its creation shows the task by number until its text comes.
      const at = r.todos.findIndex((t) => t.id === e.id);
      if (e.status === "deleted") {
        if (at >= 0) r.todos.splice(at, 1);
        r.deleted = [...(r.deleted ?? []).filter((d) => d !== e.id), e.id].slice(-DELETED_MAX);
        return;
      }
      if (r.deleted?.includes(e.id)) return;
      const was = r.todos[at];
      const status = e.status && !(was && e.created) ? (STATUS[e.status] ?? was?.status ?? "queued") : (was?.status ?? "queued");
      const active = e.active ?? was?.active;
      const todo: WorkTodo = {
        id: e.id,
        text: e.text ?? was?.text ?? `Task #${e.id}`,
        ...(active ? { active } : {}),
        status,
        order: was?.order ?? (/^\d{1,9}$/.test(e.id) ? Number(e.id) : Math.max(0, ...r.todos.map((t) => t.order)) + 1),
        updated: now,
      };
      if (was) r.todos[at] = todo;
      else r.todos.push(todo);
      r.todos.sort((a, b) => a.order - b.order);
      return;
    }
    case "call": {
      // Async hooks may run out of order: a subagent that started first takes its call now.
      const early = r.agents.find((a) => !a.call && !a.description && a.type === e.type && Date.parse(now) - Date.parse(a.started) < PENDING_MS);
      if (early) {
        early.call = e.call;
        if (e.description) early.description = e.description;
        return;
      }
      r.pending = [
        ...r.pending.filter((p) => p.call !== e.call && Date.parse(now) - Date.parse(p.at) < PENDING_MS),
        { call: e.call, type: e.type, at: now, ...(e.description ? { description: e.description } : {}) },
      ].slice(-PENDING_MAX);
      return;
    }
    case "agent-start": {
      // A subagent's start names no description, so it takes the oldest Agent call of its type that has none yet.
      const p = r.pending.findIndex((c) => !e.type || c.type === e.type);
      const pending = p >= 0 ? r.pending.splice(p, 1)[0] : undefined;
      const was = r.agents.find((a) => a.id === e.id);
      const agent: WorkAgent = {
        ...was,
        id: e.id,
        status: was?.status ?? "running",
        started: was?.started ?? now,
        ...((e.type ?? pending?.type) ? { type: e.type ?? pending?.type } : {}),
        ...((was?.description ?? pending?.description) ? { description: was?.description ?? pending?.description } : {}),
        ...(pending ? { call: pending.call } : {}),
      };
      const transcript = e.transcript ?? was?.transcript ?? agentTranscript(e.id);
      if (transcript) agent.transcript = transcript;
      if (was) Object.assign(was, agent);
      else r.agents.push(agent);
      return;
    }
    case "agent-end": {
      let a = r.agents.find((x) => (e.id && x.id === e.id) || (e.call && x.call === e.call));
      if (!a && !e.id) return;
      if (!a) {
        // An agent hoop didn't see start (its hook was off, or an Agent result came first).
        const p = e.call ? r.pending.findIndex((c) => c.call === e.call) : -1;
        const pending = p >= 0 ? r.pending.splice(p, 1)[0] : undefined;
        a = { id: e.id!, status: "running", started: pending?.at ?? now };
        r.agents.push(a);
      }
      if (e.call) a.call = e.call;
      if (e.description) a.description = e.description;
      if (e.type && !a.type) a.type = e.type;
      if (e.last) a.last = e.last;
      const transcript = e.transcript && !e.transcript.endsWith(".output") ? e.transcript : undefined;
      if (transcript) a.transcript = transcript;
      else if (!a.transcript && e.id) a.transcript = agentTranscript(e.id);
      // A finished or stopped agent stays so: a background agent's launch result can arrive after its end.
      if (a.status === "running" && e.status !== "running") {
        a.status = e.status;
        a.ended = now;
      }
      return;
    }
  }
}

/**
 * Runs the work hook on one Claude Code hook input: updates the session's work record. Never throws,
 * and writes nothing for an input that holds no work.
 */
export function workHook(home: string, input: unknown, now = new Date().toISOString()): WorkRecord | undefined {
  try {
    const events = workEvents(input);
    const i = obj(input);
    const session = validSession(i?.session_id);
    if (!events.length || !session) return undefined;
    mkdirSync(dir(home), { recursive: true });
    return withLock(`${file(home, session)}.lock`, () => {
      const r: WorkRecord = readWork(home, session) ?? { session, updated: now, todos: [], agents: [], pending: [] };
      const transcript = str(i?.transcript_path);
      if (str(i?.cwd)) r.cwd = str(i?.cwd);
      if (transcript) r.transcript = transcript;
      for (const e of events) applyEvent(r, e, now, r.transcript);
      r.updated = now;
      writeAtomic(file(home, session), `${JSON.stringify(r, null, 2)}\n`);
      return r;
    });
  } catch {
    return undefined;
  }
}

/** A Claude Code session as `<claude dir>/sessions/<pid>.json` describes it. */
export type ClaudeSession = { session: string; pid: number; status?: string; name?: string; cwd?: string; updatedAt?: number };
/** Reads the Claude Code sessions running now. Injectable, so tests need no real Claude Code. */
export type SessionReader = () => ClaudeSession[];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The running Claude Code sessions, from `<claude dir>/sessions/<pid>.json`, skipping files whose process is gone. */
export const claudeSessions: SessionReader = () => {
  const folder = join(claudeDir(), "sessions");
  let names: string[];
  try {
    names = readdirSync(folder).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    try {
      const v = JSON.parse(readFileSync(join(folder, n), "utf8"));
      const session = validSession(v?.sessionId);
      const pid = Number(v?.pid);
      if (!session || !Number.isInteger(pid) || pid <= 0 || !alive(pid)) return [];
      return [
        {
          session,
          pid,
          ...(typeof v.status === "string" ? { status: v.status } : {}),
          ...(typeof v.name === "string" && v.name.trim() ? { name: v.name.trim() } : {}),
          ...(typeof v.cwd === "string" ? { cwd: v.cwd } : {}),
          ...(typeof v.updatedAt === "number" ? { updatedAt: v.updatedAt } : {}),
        },
      ];
    } catch {
      return [];
    }
  });
};

/** How much of a subagent's transcript is read for its last step. */
const STEP_BYTES = 64 * 1024;
const steps = new Map<string, { key: string; step?: string }>();

/** The last thing a subagent did, from the end of its transcript: its last tool call, else its last text. */
export function lastStep(path: string): string | undefined {
  let key: string;
  try {
    const st = statSync(path);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return undefined;
  }
  const cached = steps.get(path);
  if (cached?.key === key) return cached.step;
  let step: string | undefined;
  try {
    const fd = openSync(path, "r");
    let text: string;
    try {
      const size = statSync(path).size;
      const start = Math.max(0, size - STEP_BYTES);
      const buf = Buffer.alloc(size - start);
      const n = readSync(fd, buf, 0, buf.length, start);
      text = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
    for (const line of text.split("\n").reverse()) {
      if (!line.includes('"assistant"')) continue;
      let v: { type?: string; message?: { content?: unknown } };
      try {
        v = JSON.parse(line);
      } catch {
        continue;
      }
      if (v.type !== "assistant" || !Array.isArray(v.message?.content)) continue;
      const parts = v.message.content as { type?: string; name?: string; input?: Obj; text?: string }[];
      const use = [...parts].reverse().find((p) => p.type === "tool_use" && p.name);
      if (use) {
        const what = str(use.input?.description) ?? str(use.input?.command) ?? str(use.input?.file_path) ?? str(use.input?.pattern) ?? str(use.input?.url);
        step = oneLine(what ? `${use.name}: ${what}` : use.name!);
        break;
      }
      const said = [...parts].reverse().find((p) => p.type === "text" && str(p.text));
      if (said) {
        step = oneLine(said.text!);
        break;
      }
    }
  } catch {
    /* unreadable */
  }
  steps.set(path, { key, step });
  return step;
}

/** A session on the Work page. `state` is busy or idle while it runs, and ended once its process is gone. */
export type WorkSession = {
  id: string;
  name?: string;
  state: "busy" | "idle" | "ended";
  folder?: string;
  updated: string;
  todos: WorkTodo[];
  agents: Omit<WorkAgent, "call">[];
};

/** How many sessions the Work page shows, newest first. */
export const WORK_SESSIONS_MAX = 30;

/**
 * Every session with work, newest first: running ones by their Claude Code record (busy or idle,
 * name, folder), each subagent with its last step. A running subagent of a session that ended shows
 * as stopped.
 */
export function workView(home: string, readSessions: SessionReader = claudeSessions): WorkSession[] {
  let names: string[];
  try {
    names = readdirSync(dir(home)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const running = new Map(readSessions().map((s) => [s.session, s]));
  const records = names.flatMap((n) => readWork(home, n.slice(0, -5)) ?? []).filter((r) => r.todos.length || r.agents.length);
  return records
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, WORK_SESSIONS_MAX)
    .map((r) => {
      const live = running.get(r.session);
      const state: WorkSession["state"] = !live ? "ended" : live.status === "busy" ? "busy" : "idle";
      const name = sessionName(r.session, home) ?? live?.name;
      const cwd = live?.cwd ?? r.cwd;
      return {
        id: r.session,
        ...(name ? { name } : {}),
        state,
        ...(cwd ? { folder: basename(cwd) } : {}),
        updated: r.updated,
        todos: r.todos,
        agents: r.agents.map(({ call: _call, ...a }) => {
          const status = a.status === "running" && state === "ended" ? "stopped" : a.status;
          const last =
            (a.status === "running" && a.transcript ? lastStep(a.transcript) : undefined) ?? a.last ?? (a.transcript ? lastStep(a.transcript) : undefined);
          return { ...a, status, ...(last ? { last } : {}) };
        }),
      };
    });
}
