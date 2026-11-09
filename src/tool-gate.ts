// The PreToolUse gate on the todo tools and subagents: it refuses, once, a call that goes against
// what the person asked on the Work page. It sits beside the Stop gate (src/stop.ts); the Work
// page's changes it reads are src/steer.ts's.
import { isList, obj, quote } from "./util.js";
import { editWork, readWork, type WorkChange, type WorkRecord, type WorkTodo } from "./work.js";
import { editTaken, moveOrder, settle } from "./work-settle.js";
import { blockersOf, firstQueued, isOpen, parkedTodo } from "./work-queue.js";
import { hookFields } from "./hook-input.js";
import { tell, toldIn } from "./told.js";
import { addWords, answerAdd, answerIt, changeLine, editTask, quoteBlock, withdrawWords } from "./steer.js";

/** The gate's answer to one PreToolUse input: a refusal with its reason, or nothing to say. */
export type GateDecision = { deny: string } | undefined;

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);

/** Whether a todo tool call starts the todo or marks it done. */
const starts = (status?: string) => status === "in_progress" || status === "completed";

/** Marks the change the gate told about, and gives the reason it refuses the call. */
function told(c: WorkChange, now: string, reason: string): string {
  c.gated_at ??= now;
  return reason;
}

/** The gate on one todo: what it refuses when the agent starts it or marks it done, marking the change it told about. */
function gateTodo(
  r: WorkRecord,
  id: string,
  status: string | undefined,
  subject: string | undefined,
  now: string,
  description?: string,
  main = true,
): string | undefined {
  if (!starts(status)) return undefined;
  const open = (r.changes ?? []).filter((c) => isOpen(c));
  const removed = open.find((c) => c.kind === "remove" && c.todo === id);
  if (removed)
    return told(
      removed,
      now,
      `${removed.by} removed todo #${id} ${quote(removed.subject)} in hoop's Work view. Don't start it or mark it done: delete it with TaskUpdate (status "deleted") and go on with the rest.`,
    );
  // The one-time tells below are for the session's own agent: a subagent's call never uses them up.
  if (!main) return undefined;
  const parked = parkedTodo(r, id);
  const park = parked ? open.find((c) => c.kind === "park" && c.todo === id && !c.gated_at) : undefined;
  if (park)
    return told(
      park,
      now,
      `${park.by} parked todo #${id} ${quote(park.subject)} in hoop's Work view: keep it, but don't start it until they unpark it. Go on with another todo, or ask them.`,
    );
  const why = gateEdit(r, open, { id, status, subject, description }, now) ?? gateUntold(r, open, id, now);
  if (why) return why;
  // A parked todo the gate already told about goes on: the person's order says nothing of it.
  if (status !== "in_progress" || parked) return undefined;
  const todo = r.todos.find((t) => t.id === id);
  const blocked = todo?.status === "queued" ? blockersOf(r, todo) : [];
  // A blocked todo is told once; starting it again goes on, and the person's order, which skips it, says nothing.
  return blocked.length ? gateBlocked(r, todo!, blocked, now) : gateOrder(r, id);
}

/** A person's edit of the todo the call is about, until the call takes it: what the call sets. */
function gateEdit(
  r: WorkRecord,
  open: WorkChange[],
  call: { id: string; status: string | undefined; subject: string | undefined; description: string | undefined },
  now: string,
): string | undefined {
  const { id, status, subject, description } = call;
  // A running todo's edit stops only marking it done: setting it in progress again goes on.
  const edit = open.find((c) => c.kind === "edit" && c.todo === id && !c.gated_at && (c.was !== "running" || status === "completed"));
  if (!edit) return undefined;
  const was = r.todos.find((t) => t.id === id);
  // The call takes the edit when it sets what the edit changed, or the todo already reads so.
  const takes = editTaken(
    {
      text: edit.text === edit.subject ? edit.text! : (subject ?? ""),
      description: description ?? was?.description,
    },
    edit,
  );
  if (takes) return undefined;
  const why =
    edit.text !== edit.subject
      ? `${edit.by} edited todo #${id} in hoop's Work view to ${quote(edit.text!)}. Do that instead of ${quote(edit.subject)}`
      : `${edit.by} edited todo #${id} ${quote(edit.subject)} in hoop's Work view`;
  const then = edit.was === "running" ? "then mark it done once the edited version is done" : "then start it";
  const where = edit.was === "running" ? " (in progress)" : "";
  return told(
    edit,
    now,
    `${why.replace(`#${id}`, `#${id}${where}`)}${newDescriptionWords(edit.description)}: ${editTask(edit).replace(/^set its/, "set the todo's")} with TaskUpdate, ${then}.`,
  );
}

/** What an edit did to the todo's description, after its new subject. */
function newDescriptionWords(description: string | undefined): string {
  if (description === undefined) return "";
  return description ? `, with the new description ${quoteBlock(description)}` : ", with its description cleared";
}

/** A move, comment, add or withdraw the session never got a message about: the gate tells the agent once, here. */
function gateUntold(r: WorkRecord, open: WorkChange[], id: string, now: string): string | undefined {
  const status_ = (tid?: string) => r.todos.find((t) => t.id === tid)?.status;
  const move = open.find(
    (c) =>
      c.kind === "move" &&
      c.delivery === "waiting" &&
      !c.gated_at &&
      moveOrder(c).second === id &&
      status_(moveOrder(c).first) === "queued" &&
      !parkedTodo(r, moveOrder(c).first),
  );
  if (move) {
    const { first } = moveOrder(move);
    // The person's order would say the same: it counts as told.
    if (firstQueued(r)?.id === first) tell(r, "queue_told", [`${id}>${first}`]);
    return told(move, now, `${move.by} asked in hoop's Work view for todo #${first} to come before #${id}. Start #${first} first.`);
  }
  const waiting = (c: WorkChange) => c.delivery === "waiting" && !c.gated_at;
  const note = open.find((c) => c.kind === "comment" && c.todo === id && waiting(c));
  if (note)
    return told(
      note,
      now,
      `${note.by} commented on todo #${id} in hoop's Work view (${note.id}): ${quote(note.text!)}. Take it into account, then start it again. ${answerIt(note)}`,
    );
  const add = open.find((c) => c.kind === "add" && !c.todo && waiting(c));
  if (add)
    return told(
      add,
      now,
      `${add.by} in hoop's Work view: ${addWords(add)} Create it with TaskCreate after the todos already queued, then go on. ${answerAdd(add)}`,
    );
  const ask = open.find((c) => c.kind === "comment" && c.request && waiting(c));
  if (ask) return told(ask, now, `${ask.by} in hoop's Work view: ${changeLine(ask)} Then go on.`);
  const back = open.find((c) => c.kind === "withdraw" && waiting(c));
  if (back) return told(back, now, `${back.by} in hoop's Work view: ${withdrawWords(back)} Then go on.`);
  return undefined;
}

/**
 * A todo that starts after another not done yet: starting it is refused once, naming its blockers,
 * so the agent starts them first or asks; starting it again goes on. The person's open depends on
 * it count as told.
 */
function gateBlocked(r: WorkRecord, t: WorkTodo, blocked: WorkTodo[], now: string): string | undefined {
  const told = toldIn(r, "blocked_told");
  const keys = blocked.map((b) => `${t.id}<${b.id}`);
  if (keys.every((k) => told.includes(k))) return undefined;
  tell(r, "blocked_told", keys, true);
  for (const c of r.changes ?? []) if (c.kind === "depend" && c.todo === t.id && isOpen(c)) c.gated_at ??= now;
  const names = blocked.map((b) => `#${b.id} ${quote(b.text)}`).join(", ");
  // A running blocker is to finish, a queued one to start.
  const first = blocked.map((b) => (b.status === "running" ? `finish #${b.id} (in progress)` : `start #${b.id}`)).join(", ");
  return `Todo #${t.id} ${quote(t.text)} starts after ${names}, not done yet (hoop's Work view). First ${first}, or ask the person; starting #${t.id} again goes on.`;
}

/**
 * The person's order: starting a queued todo while another comes first in it is refused once, so the
 * agent starts that one or asks; starting it again goes on. Nothing is refused until the person
 * moved a todo, and anything unreadable lets the call go on.
 */
function gateOrder(r: WorkRecord, id: string): string | undefined {
  try {
    if (r.todos.find((t) => t.id === id)?.status !== "queued") return undefined;
    const first = firstQueued(r);
    if (!first || first.id === id) return undefined;
    const key = `${id}>${first.id}`;
    if (toldIn(r, "queue_told").includes(key)) return undefined;
    tell(r, "queue_told", [key]);
    return `The person put #${first.id} first in hoop's Work view; start #${first.id}, or ask them.`;
  } catch {
    return undefined;
  }
}

/**
 * The gate: Claude Code's PreToolUse hook. It refuses every tool call of an agent a person stopped,
 * once tells a waiting comment to the agent it is about, and refuses a todo tool call that starts (or
 * marks done) a todo a person removed, or edited until the agent takes the new text; a move or comment
 * the session never got by message is told once the same way, and so is starting a todo blocked by
 * one not done, or one while the person's order puts another queued todo first. Anything else passes.
 */
export function workGate(home: string, input: unknown, now = new Date().toISOString()): GateDecision {
  const { session, event, agent, tool, toolInput: args } = hookFields(input);
  if (!session || event !== "PreToolUse" || !readWork(home, session)) return undefined;
  const reason = editWork(home, session, (r) => {
    const why = decide(r);
    settle(r, now);
    return why;
  });
  return reason ? { deny: reason } : undefined;

  function decide(r: WorkRecord): string | undefined {
    const why = agent ? gateAgent(r, agent, now) : undefined;
    if (why) return why;
    if (tool === "TaskUpdate") return gateTaskUpdate(r, args, now, !agent);
    if (tool === "TodoWrite" && isList(args.todos)) return gateTodoWrite(r, args.todos, now, !agent);
    return undefined;
  }
}

/** A subagent's call: refused for good once a person stopped the agent, and once to tell it a person's comment. */
function gateAgent(r: WorkRecord, agent: string, now: string): string | undefined {
  const stop = (r.changes ?? []).find((c) => c.kind === "stop" && c.agent === agent);
  if (stop) {
    stop.gated_at ??= now;
    return `Stopped by ${stop.by} in hoop's Work view. Don't call any more tools: end your turn now and say what you finished.`;
  }
  const note = (r.changes ?? []).find((c) => c.kind === "comment" && c.agent === agent && c.delivery === "waiting" && !c.gated_at);
  if (!note) return undefined;
  note.gated_at = now;
  return `${note.by} commented on your work in hoop's Work view (${note.id}): ${quote(note.text!)}. Take it into account, then go on. ${answerIt(note)}`;
}

/** The gate on a TaskUpdate call, by the todo its input names. */
function gateTaskUpdate(r: WorkRecord, args: Obj, now: string, main: boolean): string | undefined {
  const id = str(args.taskId) ?? str(args.task_id) ?? str(args.id);
  if (!id) return undefined;
  return gateTodo(r, id, str(args.status), str(args.subject), now, typeof args.description === "string" ? args.description : undefined, main);
}

/** The gate on a TodoWrite call: the first of its todos the gate refuses. The legacy list has no IDs: a todo is known by its text, or its place. */
function gateTodoWrite(r: WorkRecord, todos: unknown[], now: string, main: boolean): string | undefined {
  for (const [n, t] of todos.entries()) {
    const o = obj(t);
    const text = str(o?.content);
    const known = r.todos.find((x) => x.status === "queued" && x.text === text) ?? r.todos.find((x) => x.id === String(n + 1) && x.status === "queued");
    const why = known ? gateTodo(r, known.id, str(o?.status), text, now, undefined, main) : undefined;
    if (why) return why;
  }
  return undefined;
}

/** The gate's decision as Claude Code's PreToolUse hook output: a refusal, or `{}` to let the call go on. */
export const gateOutput = (d: GateDecision) =>
  d ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.deny } } : {};
