import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityOf, recentSteps, stepWords, transcriptActivity, waitsOn } from "../src/activity.js";
import { doingNow } from "../src/work.js";
import { agentHealth, clockText, counts, ENDED_COUNT_MS, sortAgents, sortSessions, sortTodos, span, STALE_MS, todoState } from "../web/activity.js";

const FIXTURE = new URL("./fixtures/work-transcript.jsonl", import.meta.url);
const LINES = readFileSync(FIXTURE, "utf8").split("\n");
/** A time `m` minutes after 11:50 on the fixture's day. */
const at = (m: number) => Date.parse("2026-10-23T11:50:00.000Z") + m * 60_000;
const iso = (m: number) => new Date(at(m)).toISOString();

test("a tool call reads in plain words: tests, edits, hoop waits, subagents and the rest", () => {
  assert.equal(stepWords("Bash", { command: "npm test -- --watch=false\necho done" }), "running tests: npm test -- --watch=false");
  assert.equal(stepWords("Bash", { command: "git status" }), "running: git status");
  assert.equal(stepWords("Edit", { file_path: "/repo/web/work.js" }, "/repo"), "editing web/work.js");
  assert.equal(stepWords("Write", { file_path: "/elsewhere/a.md" }, "/repo"), "writing /elsewhere/a.md");
  assert.equal(stepWords("Read", { file_path: "/repo/src/x.ts" }, "/repo"), "reading src/x.ts");
  assert.equal(stepWords("Grep", { pattern: "workView" }), "searching for workView");
  assert.equal(stepWords("mcp__hoop__hoop_wait", {}), "waiting on a review in hoop");
  assert.equal(stepWords("mcp__plugin_hoop_hoop__hoop_submit_markdown", {}), "submitting a review to hoop");
  assert.equal(stepWords("Agent", { description: "Find the routes" }), "started a subagent: Find the routes");
  assert.equal(stepWords("TaskUpdate", { taskId: "3" }), "updating its todos");
  assert.equal(stepWords("mcp__github__create_pull_request", {}), "github: create pull request");
  assert.equal(stepWords("Skill", {}), "Skill");
  assert.equal(stepWords("mcp__hoop__hoop_ask", {}), "asking you a question in hoop");
  assert.equal(stepWords("mcp__plugin_hoop_hoop__hoop_build_wait", {}), "waiting on you in a hoop build");
});

test("a call waits on the person when it is a hoop wait or ask, under either server name, or AskUserQuestion", () => {
  for (const tool of ["mcp__hoop__hoop_wait", "mcp__plugin_hoop_hoop__hoop_wait", "mcp__hoop__hoop_ask", "mcp__plugin_hoop_hoop__hoop_build_wait"])
    assert.equal(waitsOn(tool), "review", tool);
  assert.equal(waitsOn("AskUserQuestion"), "question");
  for (const tool of ["Bash", "mcp__hoop__hoop_submit", "mcp__hoop__hoop_feedback", "mcp__other__hoop_wait"]) assert.equal(waitsOn(tool), undefined, tool);
  // An open AskUserQuestion reads as a question waiting on the person.
  const asking = activityOf([
    JSON.stringify({ type: "assistant", timestamp: iso(1), message: { content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input: {} }] } }),
  ]);
  assert.deepEqual(doingNow("busy", asking, []), { what: "asking you a question", at: iso(1), open: true, waiting: "question" });
});

test("a transcript's activity is its newest entry's time, its tool calls, and the call still running", () => {
  const a = activityOf(LINES, "/tmp/proj");
  assert.equal(a.last, "2026-10-23T11:59:40.000Z");
  assert.deepEqual(
    a.steps.map((s) => [s.at, s.what]),
    [
      [iso(2), "reading web/work.js"],
      [iso(6), "editing web/work.js"],
      [iso(7), "running tests: npm test"],
      [iso(8), "started a subagent: Find the API routes"],
      [iso(9.5), "waiting on a review in hoop"],
    ],
  );
  assert.deepEqual(a.open, { at: iso(9.5), tool: "mcp__hoop__hoop_wait", what: "waiting on a review in hoop", input: { review_id: "rv_abc" } });
  // Once its result comes, no call runs.
  const answered = [...LINES, JSON.stringify({ type: "user", timestamp: iso(11), message: { content: [{ type: "tool_result", tool_use_id: "t5" }] } })];
  assert.equal(activityOf(answered).open, undefined);
});

test("the last five minutes list the steps newest first, at most ten", () => {
  const a = activityOf(LINES, "/tmp/proj");
  assert.deepEqual(
    recentSteps(a, at(12)).map((s) => s.what),
    ["waiting on a review in hoop", "started a subagent: Find the API routes", "running tests: npm test"],
    "steps from 11:57 on, at 12:02",
  );
  assert.deepEqual(recentSteps(a, at(30)), []);
  const many = activityOf(
    Array.from({ length: 14 }, (_, n) =>
      JSON.stringify({
        type: "assistant",
        timestamp: iso(n * 0.1),
        message: { content: [{ type: "tool_use", id: `x${n}`, name: "Bash", input: { command: `step ${n}` } }] },
      }),
    ),
  );
  const recent = recentSteps(many, at(2));
  assert.equal(recent.length, 10);
  assert.equal(recent[0]!.what, "running: step 13");
  assert.equal(recentSteps(undefined, at(0)).length, 0);
});

test("only a transcript's tail is read, a cut first line is skipped, and the file's time counts as activity", () => {
  const dir = mkdtempSync(join(tmpdir(), "hoop-activity-"));
  const path = join(dir, "s.jsonl");
  // Over 256 KB of old entries, then the fixture: the old ones lie outside the tail.
  const old = JSON.stringify({
    type: "assistant",
    timestamp: iso(-60),
    message: { content: [{ type: "tool_use", id: "old", name: "Read", input: { file_path: "x".repeat(900) } }] },
  });
  writeFileSync(path, `${`${old}\n`.repeat(400)}${LINES.join("\n")}`);
  utimesSync(path, new Date(at(5)), new Date(at(5)));
  const a = transcriptActivity(path, "/tmp/proj")!;
  const old_ = a.steps.filter((s) => s.at === iso(-60)).length;
  assert.ok(old_ > 100 && old_ < 400, `only the tail's old steps are read (${old_})`);
  assert.equal(a.steps[0]!.what, `reading ${"x".repeat(99)}…`, "the cut first line is skipped, the next read whole");
  assert.equal(a.steps.at(-1)!.what, "waiting on a review in hoop");
  assert.equal(a.last, "2026-10-23T11:59:40.000Z", "the newest entry is newer than the file's time");
  utimesSync(path, new Date(at(20)), new Date(at(20)));
  assert.equal(transcriptActivity(path, "/tmp/proj")!.last, iso(20), "a newer file time counts");
  assert.equal(transcriptActivity(join(dir, "missing.jsonl")), undefined);
});

test("what a session does now: its running call, else its latest one while busy; an idle one's running subagent", () => {
  const a = activityOf(LINES, "/tmp/proj");
  const agent = { status: "running" as const, description: "Check the docs", started: iso(1) };
  assert.deepEqual(doingNow("busy", a, []), { what: "waiting on a review in hoop", at: iso(9.5), open: true, waiting: "review" });
  const done = activityOf(LINES.slice(0, 7));
  assert.deepEqual(doingNow("busy", done, []), { what: "running tests: npm test", at: iso(7), open: false });
  const agentOpen = activityOf(LINES.slice(0, 8));
  assert.deepEqual(doingNow("busy", agentOpen, []), { what: "a subagent is running: Find the API routes", at: iso(8), open: true });
  assert.deepEqual(doingNow("idle", a, [agent]), { what: "a subagent is running: Check the docs", at: iso(1), open: true });
  assert.equal(doingNow("idle", a, []), undefined);
  assert.equal(doingNow("ended", a, [agent]), undefined);
  assert.equal(doingNow("busy", undefined, []), undefined);
});

test("the page lists what runs first and keeps the person's queue order", () => {
  const s = (id: string, state: string) => ({ id, state });
  assert.deepEqual(
    sortSessions([s("a", "ended"), s("b", "idle"), s("c", "busy"), s("d", "ended"), s("e", "busy")] as never[]).map((x: { id: string }) => x.id),
    ["c", "e", "b", "a", "d"],
  );
  const t = (id: string, status: string) => ({ id, status });
  // The person's order: 5, 2, 4 queued; 3 done; 1 running in the middle.
  const todos = [t("5", "queued"), t("3", "done"), t("2", "queued"), t("1", "running"), t("4", "queued"), t("6", "running")];
  assert.deepEqual(
    sortTodos(todos as never[]).map((x: { id: string }) => x.id),
    ["1", "6", "5", "2", "4", "3"],
  );
  const g = (id: string, status: string) => ({ id, status });
  assert.deepEqual(
    sortAgents([g("a", "done"), g("b", "running"), g("c", "stopped"), g("d", "running")] as never[]).map((x: { id: string }) => x.id),
    ["b", "d", "a", "c"],
  );
});

test("a running todo is stalled after ten quiet minutes, and not running when its session ended or idles", () => {
  const todo = { id: "1", status: "running" as const, since: iso(0) };
  const busy = { state: "busy" as const, activity: iso(0), agents: [], todos: [todo] };
  const state = (x: Parameters<typeof todoState>[0], m: number, t: Parameters<typeof todoState>[1] = todo) => todoState(x, t, at(m))?.state;
  assert.equal(todoState(busy, { status: "queued" }, at(60)), undefined);
  assert.equal(todoState(busy, todo, at(0) + STALE_MS - 1000)?.state, "running");
  assert.deepEqual(todoState(busy, todo, at(47)), { state: "stalled", note: "Stalled: no activity for 47 m", since: iso(0) });
  assert.equal(state({ ...busy, doing: { what: "running tests", at: iso(0), open: true } }, 47), "running", "a call still running is no stall");
  assert.deepEqual(todoState({ ...busy, state: "ended" }, todo, at(1)), {
    state: "notrunning",
    note: "Not running: the session ended; this todo was left in progress",
    since: iso(0),
  });
  assert.equal(todoState({ ...busy, state: "idle" }, todo, at(1))?.note, "Not running: the session is idle; this todo was left in progress");
  const agent = { id: "a", started: iso(0), status: "running" as const, activity: iso(130) };
  assert.equal(state({ state: "idle", activity: iso(0), agents: [agent], todos: [todo] }, 134), "running", "an idle session's live subagent works on");
  assert.equal(state({ state: "busy", agents: [], todos: [todo] }, 600), "running", "no activity known: no judgement");
});

test("a running subagent is stalled after ten quiet minutes unless a call runs; times read as people say them", () => {
  assert.deepEqual(agentHealth({ status: "running", activity: iso(0) }, at(9)), { state: "running" });
  assert.deepEqual(agentHealth({ status: "running", activity: iso(0) }, at(134)), { state: "stalled", note: "Stalled: no activity for 2 h 14 m" });
  assert.deepEqual(agentHealth({ status: "running", activity: iso(0), doing: { what: "x", at: iso(0), open: true } }, at(134)), { state: "running" });
  assert.equal(agentHealth({ status: "done", activity: iso(0) }, at(134)), undefined);
  assert.equal(span(45_000), "45 s");
  assert.equal(span(3 * 60_000 + 59_000), "3 m");
  assert.equal(span(134 * 60_000), "2 h 14 m");
  assert.equal(clockText(iso(0), iso(131), at(134)), "running for 2 h 14 m · last activity 3 m ago");
  assert.equal(clockText(iso(0), undefined, at(1)), "running for 1 m");
  assert.equal(clockText(iso(0), undefined, at(1), true), "marked running for 1 m");
});

test("the counts list the rows running, waiting on you, stalled and not running, in page order", () => {
  const sessions = [
    { id: "old", state: "ended", activity: iso(30), todos: [{ id: "1", status: "running", since: iso(0) }], agents: [] },
    {
      id: "now",
      state: "busy",
      activity: iso(60),
      todos: [
        { id: "1", status: "done" },
        { id: "2", status: "running", since: iso(1) },
        { id: "3", status: "queued" },
      ],
      agents: [
        { id: "a", status: "running", activity: iso(0) },
        { id: "b", status: "running", activity: iso(59) },
      ],
    },
  ];
  const row = (session: string, kind: string, id: string) => ({ session, kind, id });
  assert.deepEqual(counts(sessions as never[], at(61)), {
    running: [row("now", "todo", "2"), row("now", "agent", "b")],
    waiting: [],
    stalled: [row("now", "agent", "a")],
    notrunning: [row("old", "todo", "1")],
  });
});

test("a todo an ended session left over an hour ago keeps its note but leaves the not-running count", () => {
  const todo = { id: "1", status: "running" as const, since: iso(0) };
  const ended = (activity?: string) => ({ id: "x", state: "ended" as const, todos: [todo], agents: [], ...(activity ? { activity } : {}) });
  assert.equal(todoState(ended(iso(0)), todo, at(0) + ENDED_COUNT_MS + 60_000)!.state, "notrunning");
  assert.deepEqual(counts([ended(iso(0))] as never[], at(0) + ENDED_COUNT_MS + 60_000).notrunning, []);
  assert.deepEqual(counts([ended()] as never[], at(0)).notrunning, [], "no activity known: left out");
  assert.equal(counts([ended(iso(0))] as never[], at(0) + ENDED_COUNT_MS - 60_000).notrunning.length, 1);
  const idle = { id: "y", state: "idle" as const, activity: iso(0), todos: [todo], agents: [] };
  assert.equal(counts([idle] as never[], at(600)).notrunning.length, 1, "an idle session's todo counts however old");
});

test("work waiting on the person shows as waiting, never stalled or running, and counts as waiting on you", () => {
  const todo = { id: "1", status: "running" as const, since: iso(0) };
  const busy = (waiting: "review" | "question") => ({
    id: "s",
    state: "busy" as const,
    activity: iso(0),
    doing: { what: "w", at: iso(0), open: true, waiting },
    todos: [todo],
    agents: [],
  });
  assert.deepEqual(todoState(busy("review"), todo, at(120)), { state: "waiting", note: "Waiting on you: a review in hoop", since: iso(0) });
  assert.equal(todoState(busy("question"), todo, at(120))?.note, "Waiting on you: a question in Claude Code");
  assert.deepEqual(counts([busy("review")] as never[], at(120)).waiting, [{ session: "s", kind: "todo", id: "1" }]);
  const agent = {
    id: "a",
    started: iso(0),
    status: "running" as const,
    activity: iso(0),
    doing: { what: "w", at: iso(0), open: true, waiting: "question" as const },
  };
  assert.deepEqual(agentHealth(agent, at(120)), { state: "waiting" });
  assert.deepEqual(counts([{ id: "s", state: "busy", activity: iso(119), todos: [], agents: [agent] }] as never[], at(120)).waiting, [
    { session: "s", kind: "agent", id: "a" },
  ]);
});

test("a transcript whose last 256 KB is one line is read further back", () => {
  const dir = mkdtempSync(join(tmpdir(), "hoop-activity-"));
  const path = join(dir, "long.jsonl");
  const small = JSON.stringify({
    type: "assistant",
    timestamp: iso(1),
    message: { content: [{ type: "tool_use", id: "a", name: "Read", input: { file_path: "/p/a.md" } }] },
  });
  const big = JSON.stringify({
    type: "assistant",
    timestamp: iso(2),
    message: { content: [{ type: "tool_use", id: "b", name: "Write", input: { file_path: "/p/b.md", content: "y".repeat(300 * 1024) } }] },
  });
  writeFileSync(path, `${small}\n${big}\n`);
  const a = transcriptActivity(path, "/p")!;
  assert.deepEqual(
    a.steps.map((s) => s.what),
    ["reading a.md", "writing b.md"],
  );
  assert.equal(a.open?.what, "writing b.md");
});

test("a working session counts itself unless a todo stands for its own work", () => {
  const busy = (extra: object) => ({ id: "s", state: "busy" as const, activity: iso(0), todos: [], agents: [], ...extra });
  const self = { session: "s", kind: "session", id: "" };
  const todo = (id: string, extra: object = {}) => ({ id, status: "running" as const, since: iso(0), ...extra });
  // No todos at all, or only done ones: the session is what's running.
  assert.deepEqual(counts([busy({})] as never[], at(1)).running, [self]);
  assert.deepEqual(counts([busy({ todos: [{ id: "1", status: "done" }] })] as never[], at(1)).running, [self]);
  // Waiting on the person, or quiet for long with no tool call open.
  assert.deepEqual(counts([busy({ doing: { what: "w", at: iso(0), open: true, waiting: "question" } })] as never[], at(1)).waiting, [self]);
  assert.deepEqual(counts([busy({})] as never[], at(600)).stalled, [self]);
  // A todo the session itself works on stands for it: counted once, as the todo.
  assert.deepEqual(counts([busy({ todos: [todo("1")] })] as never[], at(1)).running, [{ session: "s", kind: "todo", id: "1" }]);
  // A todo waiting only on its pull request doesn't: the session's other work still counts.
  const pr = { kind: "pr", url: "https://github.com/o/r/pull/1", number: 1, state: "open", ready: true, checks: "green" };
  const linked = counts([busy({ todos: [todo("1", { links: [pr] })] })] as never[], at(1));
  assert.equal(linked.waiting.length, 1);
  assert.deepEqual(linked.running, [self], "a todo waiting on its pull request doesn't hide the working session");
  // A subagent, running or stalled, is its own row: the session counts beside it.
  const agent = (activity: string) => ({ id: "a", started: iso(0), status: "running", activity });
  assert.deepEqual(counts([busy({ activity: iso(599), agents: [agent(iso(0))] })] as never[], at(600)), {
    running: [self],
    waiting: [],
    stalled: [{ session: "s", kind: "agent", id: "a" }],
    notrunning: [],
  });
  // The session's own wait counts while a subagent runs its todo.
  const waiting = busy({ doing: { what: "w", at: iso(0), open: true, waiting: "question" }, todos: [todo("1")], agents: [agent(iso(1))] });
  const withAgent = counts([waiting] as never[], at(1));
  assert.deepEqual(withAgent.waiting, [self]);
  // An idle session counts nothing of its own.
  assert.deepEqual(counts([{ ...busy({}), state: "idle" }] as never[], at(1)).running, []);
});
