import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addChanges, workGate } from "../src/steer.js";
import { readWork, workHook } from "../src/work.js";
import { workQueue, workView } from "../src/work-view.js";
import type { ClaudeSession } from "../src/claude-sessions.js";
import { tempHome } from "./helpers.js";

// Each todo and subagent on the Work page keeps its own past: hooks that arrive out of order, or a
// list that drops a todo, never give one another's history, call or description (#365, #366).

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });
const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 10, 0, s)).toISOString();

const todoWrite = (todos: [string, string][]) =>
  hook("post-todowrite", { tool_input: { todos: todos.map(([content, status]) => ({ content, status, activeForm: content })) } });
const taskCreate = (id: string, subject: string) => hook("post-taskcreate", { tool_input: { subject }, tool_response: { task: { id, subject } } });
const taskUpdate = (input: Record<string, unknown>) => hook("post-taskupdate", { tool_input: input, tool_response: { success: true } });

test("regression: a todo whose neighbour left a TodoWrite list takes none of its past (#365)", () => {
  const home = tempHome();
  workHook(
    home,
    todoWrite([
      ["A", "pending"],
      ["B", "in_progress"],
      ["C", "pending"],
    ]),
    at(0),
  );
  workHook(
    home,
    todoWrite([
      ["A", "pending"],
      ["C", "pending"],
    ]),
    at(30),
  );
  const c = readWork(home, SESSION)!.todos.find((t) => t.text === "C")!;
  assert.equal(c.status, "queued");
  assert.equal(c.started, undefined, "C never ran");
  assert.deepEqual(c.history, [{ state: "queued", at: at(0) }], "its own history, not B's");
  assert.equal(c.created, at(0));

  // A todo renamed in its place keeps its past; a new one in a removed one's place starts afresh.
  workHook(
    home,
    todoWrite([
      ["A, renamed", "pending"],
      ["C", "pending"],
    ]),
    at(40),
  );
  assert.equal(readWork(home, SESSION)!.todos[0]!.created, at(0));
  workHook(
    home,
    todoWrite([
      ["A, renamed", "in_progress"],
      ["D", "pending"],
      ["C", "pending"],
    ]),
    at(50),
  );
  const [a, d] = readWork(home, SESSION)!.todos;
  assert.equal(a!.started, at(50));
  assert.equal(d!.created, at(50), "D is new, though its place held C");
});

test("regression: a deleted task stays deleted when a late update arrives after a list without it (#365)", () => {
  const home = tempHome();
  workHook(home, taskCreate("3", "Ship it"), at(0));
  workHook(home, taskUpdate({ taskId: "3", status: "deleted" }), at(1));
  workHook(home, hook("post-tasklist", { tool_response: { tasks: [] } }), at(2));
  workHook(home, taskUpdate({ taskId: "3", status: "in_progress" }), at(3));
  assert.deepEqual(readWork(home, SESSION)!.todos, []);
  // A whole list that names it again brings it back.
  workHook(home, hook("post-tasklist", { tool_response: { tasks: [{ id: "3", subject: "Ship it", status: "pending" }] } }), at(4));
  assert.deepEqual(
    readWork(home, SESSION)!.todos.map((t) => t.id),
    ["3"],
  );
  workHook(home, taskUpdate({ taskId: "3", status: "in_progress" }), at(5));
  assert.equal(readWork(home, SESSION)!.todos[0]!.status, "running");
});

test("regression: a block given before the blocked task exists applies when it comes (#365)", () => {
  const home = tempHome();
  workHook(home, taskCreate("1", "One"), at(0));
  workHook(home, taskUpdate({ taskId: "1", addBlocks: ["2"] }), at(1));
  workHook(home, taskCreate("2", "Two"), at(2));
  const r = readWork(home, SESSION)!;
  assert.deepEqual(r.todos.find((t) => t.id === "2")!.blocked_by, ["1"]);
  assert.equal(r.blocks, undefined, "the waiting block is used up");
});

const call = (id: string, description: string, type = "general-purpose") =>
  hook("pre-agent", { tool_use_id: id, tool_input: { description, prompt: "…", subagent_type: type } });
const start = (id: string, extra: Record<string, unknown> = {}) => hook("subagent-start", { agent_id: id, agent_type: "general-purpose", ...extra });
const stop = (id: string) => hook("subagent-stop", { agent_id: id, agent_type: "general-purpose" });
const result = (id: string, callId: string, description: string, report: string) =>
  hook("post-agent", {
    tool_use_id: callId,
    tool_input: { description, prompt: "…", subagent_type: "general-purpose" },
    tool_response: { status: "completed", agentId: id, content: [{ type: "text", text: report }] },
  });
const agents = (home: string) => readWork(home, SESSION)!.agents.map((a) => [a.id, a.call, a.description, a.status, a.last]);

test("regression: a resumed subagent keeps its own call, and the new one takes the new call (#366)", () => {
  const home = tempHome();
  workHook(home, call("cY", "Y job"), at(0));
  workHook(home, start("Y"), at(1));
  workHook(home, stop("Y"), at(20));
  workHook(home, result("Y", "cY", "Y job", "Y is done."), at(21));
  workHook(home, call("cZ", "Z job"), at(40));
  workHook(home, start("Y"), at(41));
  workHook(home, start("Z"), at(42));
  assert.deepEqual(agents(home), [
    ["Y", "cY", "Y job", "running", "Y is done."],
    ["Z", "cZ", "Z job", "running", undefined],
  ]);
  workHook(home, result("Z", "cZ", "Z job", "Z is done."), at(60));
  assert.deepEqual(agents(home), [
    ["Y", "cY", "Y job", "running", "Y is done."],
    ["Z", "cZ", "Z job", "done", "Z is done."],
  ]);
});

test("regression: one subagent's result marks it done, not the one that took its call by guess (#366)", () => {
  const home = tempHome();
  workHook(home, call("cX", "X job"), at(0));
  workHook(home, call("cY", "Y job"), at(1));
  // Started together: hoop's best guess, by order, pairs them the wrong way round.
  workHook(home, start("Y"), at(2));
  workHook(home, start("X"), at(3));
  workHook(home, result("X", "cX", "X job", "X is done."), at(30));
  assert.deepEqual(agents(home), [
    ["Y", "cY", "Y job", "running", undefined],
    ["X", "cX", "X job", "done", "X is done."],
  ]);
});

test("regression: a subagent starting after the ten-minute window takes no orphaned call (#366)", () => {
  const home = tempHome();
  workHook(home, call("cO", "Orphan"), at(0));
  workHook(home, start("W"), at(10 * 60 + 1));
  assert.deepEqual(agents(home), [["W", undefined, undefined, "running", undefined]]);
  assert.equal(readWork(home, SESSION)!.pending.length, 1, "the old call isn't taken");
});

test("a subagent start without a type takes a waiting call only when one alone waits", () => {
  const home = tempHome();
  workHook(home, call("cE", "Explore it", "Explore"), at(0));
  workHook(home, call("cP", "Plan it", "Plan"), at(1));
  workHook(home, start("U", { agent_type: undefined }), at(2));
  assert.deepEqual(agents(home), [["U", undefined, undefined, "running", undefined]]);
  const alone = tempHome();
  workHook(alone, call("cE", "Explore it", "Explore"), at(0));
  workHook(alone, start("U", { agent_type: undefined }), at(2));
  assert.deepEqual(agents(alone), [["U", "cE", "Explore it", "running", undefined]]);
});

test("an agent hoop never saw start keeps its waiting call's description", () => {
  const home = tempHome();
  workHook(home, call("cS", "Stop me"), at(0));
  workHook(home, hook("post-agent", { tool_use_id: "cS", tool_input: {}, tool_response: { status: "async_launched", agentId: "S" } }), at(1));
  assert.deepEqual(agents(home), [["S", "cS", "Stop me", "running", undefined]]);
});

test("Claude Code's meta file decides a subagent's call and description over hoop's guess (#366)", () => {
  const home = tempHome();
  const folder = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-proj");
  const subagents = join(folder, SESSION, "subagents");
  mkdirSync(subagents, { recursive: true });
  const transcript_path = join(folder, `${SESSION}.jsonl`);
  writeFileSync(transcript_path, "");
  const transcriptOf = (id: string) => join(subagents, `agent-${id}.jsonl`);
  const meta = (id: string, call: string, description: string) => {
    writeFileSync(transcriptOf(id), "");
    writeFileSync(join(subagents, `agent-${id}.meta.json`), JSON.stringify({ agentType: "general-purpose", description, toolUseId: call }));
  };
  const base = { transcript_path, cwd: "/tmp/proj" };
  workHook(home, { ...call("cP", "P job"), ...base }, at(0));
  workHook(home, { ...call("cQ", "Q job"), ...base }, at(1));
  // Q's meta file is there when it starts: it takes its own call, though P's is older.
  meta("Q", "cQ", "Q job");
  workHook(home, { ...start("Q", { agent_transcript_path: transcriptOf("Q") }), ...base }, at(2));
  workHook(home, { ...start("P", { agent_transcript_path: transcriptOf("P") }), ...base }, at(3));
  assert.deepEqual(
    readWork(home, SESSION)!.agents.map((a) => [a.id, a.call, a.description]),
    [
      ["Q", "cQ", "Q job"],
      ["P", "cP", "P job"],
    ],
  );

  // R and T start before their meta files are written: hoop guesses, and the meta files correct the view.
  workHook(home, { ...call("cR", "R job"), ...base }, at(10));
  workHook(home, { ...call("cT", "T job"), ...base }, at(11));
  workHook(home, { ...start("T", { agent_transcript_path: transcriptOf("T") }), ...base }, at(12));
  workHook(home, { ...start("R", { agent_transcript_path: transcriptOf("R") }), ...base }, at(13));
  assert.equal(readWork(home, SESSION)!.agents.find((a) => a.id === "T")!.description, "R job", "hoop's guess");
  meta("T", "cT", "T job");
  meta("R", "cR", "R job");
  const sessions: ClaudeSession[] = [{ session: SESSION, pid: 1, status: "busy", cwd: "/tmp/proj" }];
  const [s] = workView(home, () => sessions);
  assert.deepEqual(
    s!.agents.filter((a) => a.id === "T" || a.id === "R").map((a) => [a.id, a.description]),
    [
      ["T", "T job"],
      ["R", "R job"],
    ],
  );
});

test("regression: a subagent whose stop came before its start still takes its own call, not a later one", () => {
  const home = tempHome();
  workHook(home, call("cX", "X's job"), at(0));
  workHook(home, stop("x"), at(20));
  workHook(home, start("x"), at(21));
  workHook(home, call("cZ", "Z's job"), at(80));
  workHook(home, start("z"), at(81));
  assert.deepEqual(
    agents(home).map((a) => a.slice(0, 4)),
    [
      ["x", "cX", "X's job", "done"],
      ["z", "cZ", "Z's job", "running"],
    ],
  );
  assert.deepEqual(readWork(home, SESSION)!.pending, []);
});

test("regression: a subagent whose result came before its start leaves no call waiting", () => {
  const home = tempHome();
  workHook(home, call("cX", "X's job"), at(0));
  workHook(home, stop("x"), at(20));
  workHook(home, result("x", "cX", "X's job", "X is done."), at(21));
  assert.deepEqual(readWork(home, SESSION)!.pending, [], "the result took its call");
  workHook(home, start("x"), at(22));
  workHook(home, call("cZ", "Z's job"), at(80));
  workHook(home, start("z"), at(81));
  assert.deepEqual(agents(home), [
    ["x", "cX", "X's job", "done", "X is done."],
    ["z", "cZ", "Z's job", "running", undefined],
  ]);
});

const ABC = (): [string, string][] => [
  ["A", "in_progress"],
  ["B", "pending"],
  ["C", "pending"],
];
const AC = (status = "pending", first = "in_progress"): [string, string][] => [
  ["A", first],
  ["C", status],
];
const person = (home: string, change: Record<string, unknown>, s: number) =>
  addChanges(home, SESSION, [change], { by: "ankur", reachable: true, now: at(s) })![0]!;
const changeOf = (home: string, id: string) => readWork(home, SESSION)!.changes!.find((c) => c.id === id)!;

test("regression: a removal of a TodoWrite todo stays with it when the list shifts (#365)", () => {
  const home = tempHome();
  workHook(home, todoWrite(ABC()), at(0));
  const removal = person(home, { kind: "remove", todo: "2" }, 5);
  workHook(home, todoWrite(AC()), at(10));
  assert.equal(changeOf(home, removal.id).delivery, "seen", "B left the list");
  assert.deepEqual(
    workQueue(home, SESSION).todos.map((t) => [t.id, t.text]),
    [["2", "C"]],
    "C, in B's place, isn't removed",
  );
  workHook(home, todoWrite(AC("in_progress")), at(20));
  assert.equal(changeOf(home, removal.id).delivery, "seen", "starting C doesn't override B's removal");
});

test("regression: a park of a TodoWrite todo follows it when the list shifts, both ways (#365)", () => {
  const home = tempHome();
  workHook(home, todoWrite(ABC()), at(0));
  person(home, { kind: "park", todo: "2" }, 5);
  workHook(home, todoWrite(AC("pending", "completed")), at(10));
  assert.equal(readWork(home, SESSION)!.parked, undefined, "B left; C, in its place, isn't parked");

  const other = tempHome();
  workHook(other, todoWrite(ABC()), at(0));
  const park = person(other, { kind: "park", todo: "3" }, 5);
  workHook(other, todoWrite(AC()), at(10));
  assert.deepEqual(readWork(other, SESSION)!.parked, ["2"], "C stays parked in its new place");
  assert.equal(changeOf(other, park.id).todo, "2");
  assert.equal(changeOf(other, park.id).delivery, "pending");
});

test("regression: a comment on a TodoWrite todo stays open when the todo moves up (#365)", () => {
  const home = tempHome();
  workHook(home, todoWrite(ABC()), at(0));
  const note = person(home, { kind: "comment", todo: "3", text: "Mind the old rows" }, 5);
  workHook(home, todoWrite(AC()), at(10));
  const c = changeOf(home, note.id);
  assert.equal(c.todo, "2");
  assert.equal(c.delivery, "pending");
  // What a todo starts after follows it too.
  person(home, { kind: "depend", todo: "2", after: "1" }, 15);
  workHook(home, todoWrite([["Z", "pending"], ...AC()]), at(20));
  assert.deepEqual(readWork(home, SESSION)!.starts_after, { "3": ["2"] });
});

// Leftovers of #365 and #366 (#372): what the gate told, a resumed subagent, and an edited todo that moves.

const preTodoWrite = (todos: [string, string][]) =>
  hook("pre-todowrite", { tool_input: { todos: todos.map(([content, status]) => ({ content, status, activeForm: content })) } });
const pending = (...texts: string[]): [string, string][] => texts.map((t) => [t, "pending"]);
const starting = (texts: string[], i: number): [string, string][] => texts.map((t, n) => [t, n === i ? "in_progress" : "pending"]);

/** C starts after A, its start refused once, then a todo Z comes at the top of the list. */
function toldThenShifted() {
  const home = tempHome();
  workHook(home, todoWrite(pending("A", "B", "C")), at(0));
  person(home, { kind: "depend", todo: "3", after: "1" }, 5);
  assert.match(workGate(home, preTodoWrite(starting(["A", "B", "C"], 2)), at(10))!.deny, /^Todo #3 "C" starts after #1 "A"/);
  workHook(home, todoWrite(pending("Z", "A", "B", "C")), at(20));
  assert.deepEqual(readWork(home, SESSION)!.starts_after, { "4": ["2"] });
  return home;
}

test("regression: a blocked start the gate told about stays told when the TodoWrite list shifts (#372)", () => {
  const home = toldThenShifted();
  assert.equal(workGate(home, preTodoWrite(starting(["Z", "A", "B", "C"], 3)), at(30)), undefined, "C, now #4, was told already");
});

test("regression: a todo that moves into a told todo's place is still refused once (#372)", () => {
  const home = toldThenShifted();
  // B is now #3 and starts after Z, #1: the pair told before was C after A, not B after Z.
  person(home, { kind: "depend", todo: "3", after: "1" }, 40);
  assert.match(workGate(home, preTodoWrite(starting(["Z", "A", "B", "C"], 2)), at(50))!.deny, /^Todo #3 "B" starts after #1 "Z"/);
});

test("regression: a start the person's order refused stays told when the TodoWrite list shifts (#372)", () => {
  const home = tempHome();
  workHook(home, todoWrite(pending("A", "B", "C")), at(0));
  person(home, { kind: "move", todo: "3", before: "1" }, 5);
  assert.match(workGate(home, preTodoWrite(starting(["A", "B", "C"], 0)), at(10))!.deny, /put #3 first/);
  workHook(home, todoWrite(pending("Z", "A", "B", "C")), at(20));
  assert.equal(readWork(home, SESSION)!.queue?.[0], "4");
  assert.equal(workGate(home, preTodoWrite(starting(["Z", "A", "B", "C"], 1)), at(30)), undefined, "A, now #2, was told already");
});

test("regression: a resumed subagent hoop knows without a call takes no new subagent's call (#372)", () => {
  const home = tempHome();
  workHook(home, start("Y"), at(0));
  workHook(home, stop("Y"), at(20));
  workHook(home, call("cZ", "Z job"), at(40));
  workHook(home, start("Y"), at(41));
  workHook(home, start("Z"), at(42));
  assert.deepEqual(
    agents(home).map((a) => a.slice(0, 4)),
    [
      ["Y", undefined, undefined, "running"],
      ["Z", "cZ", "Z job", "running"],
    ],
  );
});

test("regression: a resumed subagent without a call takes no Agent call that arrives before its subagent starts (#372)", () => {
  const home = tempHome();
  workHook(home, start("Y"), at(0));
  workHook(home, stop("Y"), at(60));
  workHook(home, start("Y"), at(180));
  workHook(home, call("cZ", "Z job"), at(240));
  workHook(home, start("Z"), at(241));
  assert.deepEqual(
    agents(home).map((a) => a.slice(0, 4)),
    [
      ["Y", undefined, undefined, "running"],
      ["Z", "cZ", "Z job", "running"],
    ],
  );
});

test("regression: a resumed subagent whose meta file names its own call, no longer waiting, takes no other call (#372)", () => {
  const home = tempHome();
  const folder = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-proj");
  const subagents = join(folder, SESSION, "subagents");
  mkdirSync(subagents, { recursive: true });
  const transcript_path = join(folder, `${SESSION}.jsonl`);
  writeFileSync(transcript_path, "");
  const transcriptOf = (id: string) => join(subagents, `agent-${id}.jsonl`);
  writeFileSync(transcriptOf("Y"), "");
  writeFileSync(join(subagents, "agent-Y.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Y job", toolUseId: "cY" }));
  const base = { transcript_path, cwd: "/tmp/proj" };
  // Y's own call was never recorded.
  workHook(home, { ...start("Y", { agent_transcript_path: transcriptOf("Y") }), ...base }, at(0));
  workHook(home, { ...stop("Y"), ...base }, at(20));
  workHook(home, { ...call("cZ", "Z job"), ...base }, at(40));
  workHook(home, { ...start("Y", { agent_transcript_path: transcriptOf("Y") }), ...base }, at(41));
  workHook(home, { ...start("Z"), ...base }, at(42));
  assert.deepEqual(
    readWork(home, SESSION)!.agents.map((a) => [a.id, a.call, a.description]),
    [
      ["Y", undefined, undefined],
      ["Z", "cZ", "Z job"],
    ],
  );
});

test("regression: an edited todo the agent takes keeps its past when an earlier todo leaves, with one before it (#372)", () => {
  const home = tempHome();
  workHook(home, todoWrite(pending("A", "B", "X")), at(0));
  person(home, { kind: "move", todo: "3", before: "2" }, 2);
  const edit = person(home, { kind: "edit", todo: "3", text: "X, edited" }, 3);
  const removal = person(home, { kind: "remove", todo: "1" }, 4);
  workHook(home, todoWrite(pending("B", "X, edited")), at(10));
  const r = readWork(home, SESSION)!;
  const x = r.todos.find((t) => t.text === "X, edited")!;
  assert.equal(x.id, "2");
  assert.equal(x.created, at(0), "X's past");
  assert.deepEqual(x.history, [{ state: "queued", at: at(0) }]);
  assert.deepEqual(r.queue, ["2", "1"], "X still comes before B");
  assert.equal(changeOf(home, edit.id).todo, "2");
  assert.equal(changeOf(home, edit.id).delivery, "seen", "the edit is taken");
  assert.equal(changeOf(home, removal.id).delivery, "seen", "A left the list");
});

test("regression: an edited todo the agent takes in a removed todo's place keeps its own past, not the removed one's (#372)", () => {
  const home = tempHome();
  workHook(home, todoWrite(pending("A")), at(0));
  workHook(home, todoWrite(pending("A", "X")), at(1));
  const edit = person(home, { kind: "edit", todo: "2", text: "X, edited" }, 3);
  const removal = person(home, { kind: "remove", todo: "1" }, 4);
  workHook(home, todoWrite(pending("X, edited")), at(10));
  const [x] = readWork(home, SESSION)!.todos;
  assert.equal(x!.created, at(1), "X's past, not A's");
  assert.deepEqual(x!.history, [{ state: "queued", at: at(1) }]);
  assert.equal(changeOf(home, edit.id).todo, "1");
  assert.equal(changeOf(home, edit.id).delivery, "seen", "the edit is taken");
  assert.equal(changeOf(home, removal.id).delivery, "seen", "A left the list");
  assert.equal(workGate(home, preTodoWrite([["X, edited", "in_progress"]]), at(20)), undefined, "not refused as the removed A");
});
