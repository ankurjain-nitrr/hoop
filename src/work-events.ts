// The work events in one Claude Code hook input: what a hook call on the todo tools, the Agent tool
// or a subagent changes in a session's work. src/work.ts applies them to the session's record.
import { hookFields, type HookFields } from "./hook-input.js";
import { obj, oneLine, opt, sha256 } from "./util.js";

/** A tool's input as a digest of each field, so a prompt is matched to its call without keeping what it writes. */
export const inputDigest = (input: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(input).map(([k, v]) => [k, sha256(JSON.stringify(v) ?? "").slice(0, 16)]));

/** What one hook call changes in a session's work. */
export type WorkEvent =
  | { kind: "todos"; todos: { id?: string; text: string; active?: string; status: string; blocked_by?: string[] }[] }
  | {
      kind: "todo";
      id: string;
      text?: string;
      active?: string;
      description?: string;
      status?: string;
      created?: true;
      blocked_by?: string[];
      /** Todos this one blocks, from TaskUpdate's `addBlocks`. */
      blocks?: string[];
    }
  | { kind: "call"; call: string; description?: string; type: string }
  | { kind: "turn-end" | "session-end" }
  | { kind: "prompt"; tool: string; input: Record<string, string>; agent?: string }
  | { kind: "prompt-shown"; tool?: string }
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
export const str = (v: unknown): string | undefined => {
  if (typeof v === "number") return String(v);
  return typeof v === "string" && v.trim() ? v : undefined;
};
/** A tool's response as an object: Claude Code passes some as JSON text. */
const response = (v: unknown): Obj | undefined => {
  if (typeof v !== "string") return obj(v);
  try {
    return obj(JSON.parse(v));
  } catch {
    return undefined;
  }
};

/** A list of task IDs, as `blockedBy` and `addBlockedBy` give them. */
const ids = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.flatMap((x) => str(x) ?? []) : undefined);

/** The subagent type Claude Code uses when the Agent tool names none. */
const DEFAULT_TYPE = "general-purpose";
/** The longest an agent's last words or a step are, on one line. */
export const LINE_MAX = 200;

/**
 * The work events in one Claude Code hook input: PreToolUse and PostToolUse on the task tools
 * (TaskCreate, TaskUpdate, TaskList, legacy TodoWrite) and the Agent tool (once Task), TaskStop,
 * and SubagentStart and SubagentStop. Anything else gives none.
 */
export function workEvents(input: unknown): WorkEvent[] {
  const i = obj(input);
  if (!i) return [];
  const f = hookFields(i);
  const event = f.event;
  if (event === "Stop") return [{ kind: "turn-end" }];
  if (event === "SessionEnd") return [{ kind: "session-end" }];
  if (event === "PermissionRequest") return promptEvents(f);
  if (event === "Notification" && i.notification_type === "permission_prompt") {
    // "Claude needs your permission to use Bash" names the tool.
    const tool = str(i.message)?.match(/permission to use (\S+)\s*$/)?.[1];
    return [{ kind: "prompt-shown", ...opt("tool", tool) }];
  }
  if (event === "SubagentStart" || event === "SubagentStop") return subagentEvents(i, f, event);
  const { tool, toolInput: input_, toolUseId: call } = f;
  if (event === "PreToolUse") return callEvents(tool, input_, call);
  if (event !== "PostToolUse" || !tool || !Object.hasOwn(TOOL_EVENTS, tool)) return [];
  return TOOL_EVENTS[tool]?.(input_, response(i.tool_response), call) ?? [];
}

/** A PreToolUse's call event: an Agent call, before its subagent starts. */
function callEvents(tool: unknown, input: Obj, call: string | undefined): WorkEvent[] {
  if ((tool === "Agent" || tool === "Task") && call && !input.taskId)
    return [{ kind: "call", call, type: str(input.subagent_type) ?? DEFAULT_TYPE, ...opt("description", str(input.description)) }];
  return [];
}

/** A PermissionRequest's prompt event. */
function promptEvents(f: HookFields): WorkEvent[] {
  return f.tool ? [{ kind: "prompt", tool: f.tool, input: inputDigest(f.toolInput), ...opt("agent", f.agent) }] : [];
}

/** A SubagentStart's or SubagentStop's event. */
function subagentEvents(i: Obj, f: HookFields, event: "SubagentStart" | "SubagentStop"): WorkEvent[] {
  const id = f.agent;
  if (!id) return [];
  const type = opt("type", f.agentType);
  const transcript = opt("transcript", str(i.agent_transcript_path));
  if (event === "SubagentStart") return [{ kind: "agent-start", id, ...type, ...transcript }];
  const last = str(i.last_assistant_message);
  return [{ kind: "agent-end", id, status: "done", ...type, ...transcript, ...opt("last", last && oneLine(last, LINE_MAX)) }];
}

/** An Agent call's status from its result: running when launched in the background. */
function agentStatus(out: Obj | undefined): "running" | "done" | "stopped" {
  if (out?.status === "async_launched") return "running";
  return out?.status === "completed" || !out?.status ? "done" : "stopped";
}

/** An Agent call's result as an agent-end event. Before the task tools, "Task" was the subagent tool; a "Task" call with a taskId is neither. */
function agentEvents(input: Obj, out: Obj | undefined, call: string | undefined): WorkEvent[] {
  if (input.taskId) return [];
  const status = agentStatus(out);
  const text = Array.isArray(out?.content) ? out.content.map((c) => str(obj(c)?.text) ?? "").join(" ") : str(out?.content);
  return [
    {
      kind: "agent-end",
      ...opt("id", str(out?.agentId) ?? str(out?.agent_id)),
      ...opt("call", call),
      ...opt("description", str(input.description)),
      type: str(input.subagent_type) ?? DEFAULT_TYPE,
      status,
      ...opt("transcript", str(out?.outputFile)),
      ...opt("last", status !== "running" && text?.trim() ? oneLine(text, LINE_MAX) : undefined),
    },
  ];
}

/** The work events of a PostToolUse, by tool, from the tool's input, its response and its call ID. */
const TOOL_EVENTS: Record<string, (input: Obj, out: Obj | undefined, call: string | undefined) => WorkEvent[]> = {
  TodoWrite: (input) => {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    return [
      {
        kind: "todos",
        todos: todos.flatMap((t) => {
          const o = obj(t);
          const text = str(o?.content) ?? str(o?.subject);
          return o && text ? [{ ...opt("id", str(o.id)), text, active: str(o.activeForm), status: str(o.status) ?? "pending" }] : [];
        }),
      },
    ];
  },
  TaskCreate: (input, out) => {
    const task = obj(out?.task) ?? out;
    const id = str(task?.id) ?? str(task?.taskId) ?? str(task?.task_id);
    const text = str(input.subject) ?? str(task?.subject);
    const description = str(input.description) ?? str(task?.description);
    if (!id || !text) return [];
    return [{ kind: "todo", id, text, status: "pending", created: true, ...opt("active", str(input.activeForm)), ...opt("description", description) }];
  },
  TaskUpdate: (input, out) => {
    const id = str(input.taskId) ?? str(input.task_id) ?? str(input.id) ?? str(out?.taskId);
    if (!id || out?.success === false) return [];
    const e: WorkEvent = { kind: "todo", id };
    if (str(input.subject)) e.text = str(input.subject);
    if (str(input.activeForm)) e.active = str(input.activeForm);
    if (typeof input.description === "string") e.description = input.description;
    if (str(input.status)) e.status = str(input.status);
    if (ids(input.addBlockedBy)?.length) e.blocked_by = ids(input.addBlockedBy);
    if (ids(input.addBlocks)?.length) e.blocks = ids(input.addBlocks);
    return [e];
  },
  TaskList: (_input, out) => {
    const tasks = Array.isArray(out?.tasks) ? out.tasks : undefined;
    if (!tasks) return [];
    return [
      {
        kind: "todos",
        todos: tasks.flatMap((t) => {
          const o = obj(t);
          const id = str(o?.id),
            text = str(o?.subject);
          return o && id && text ? [{ id, text, status: str(o.status) ?? "pending", ...opt("blocked_by", ids(o?.blockedBy)) }] : [];
        }),
      },
    ];
  },
  TaskGet: (_input, out) => {
    const task = obj(out?.task);
    const id = str(task?.id);
    if (!task || !id) return [];
    const description = typeof task.description === "string" ? { description: task.description } : {};
    return [{ kind: "todo", id, ...opt("text", str(task.subject)), ...description, ...opt("status", str(task.status)) }];
  },
  TaskStop: (input, out) => {
    const id = str(input.task_id) ?? str(input.shell_id) ?? str(out?.task_id);
    return id ? [{ kind: "agent-end", id, status: "stopped" }] : [];
  },
  Agent: agentEvents,
  Task: agentEvents,
};
