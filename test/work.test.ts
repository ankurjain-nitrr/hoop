import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { type ClaudeSession, claudeSessions, lastStep, readWork, workEvents, workHook, workView } from "../src/work.js";
import { BROWSER_SKIP, example, tempHome, withBrowser, hasFocus, pagesFor, hoopArgs } from "./helpers.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const wrapper = new URL("../plugins/hoop/scripts/track-work.sh", import.meta.url).pathname;
/** A fixture hook input, with fields changed. */
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });
/** An ISO time `s` seconds into a test's minute. */
const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();

test("the hook parser reads each task tool, the Agent tool and the subagent events, and nothing else", () => {
  assert.deepEqual(workEvents(hook("post-taskcreate")), [
    {
      kind: "todo",
      id: "3",
      text: "Run the test suite",
      status: "pending",
      created: true,
      active: "Running the test suite",
      description: "Run npm test and fix failures",
    },
  ]);
  assert.deepEqual(workEvents(hook("post-taskupdate")), [{ kind: "todo", id: "3", status: "in_progress" }]);
  assert.deepEqual(workEvents(hook("post-taskupdate-completed")), [{ kind: "todo", id: "3", text: "Run the full test suite", status: "completed" }]);
  assert.deepEqual(workEvents(hook("post-taskupdate-deleted")), [{ kind: "todo", id: "2", status: "deleted" }]);
  assert.deepEqual(workEvents(hook("post-taskupdate", { tool_response: { success: false, taskId: "3", updatedFields: [], error: "Task not found" } })), []);
  assert.deepEqual(workEvents(hook("post-taskget")), [
    { kind: "todo", id: "3", text: "Run the test suite", description: "Run npm test and fix failures", status: "in_progress" },
  ]);
  assert.deepEqual(workEvents(hook("post-tasklist")), [
    {
      kind: "todos",
      todos: [
        { id: "1", text: "Read the code", status: "completed", blocked_by: [] },
        { id: "3", text: "Run the test suite", status: "in_progress", blocked_by: [] },
        { id: "4", text: "Open a PR", status: "pending", blocked_by: ["3"] },
      ],
    },
  ]);
  assert.deepEqual(workEvents(hook("post-todowrite")), [
    {
      kind: "todos",
      todos: [
        { text: "Read the code", active: "Reading the code", status: "completed" },
        { text: "Run tests", active: "Running tests", status: "in_progress" },
      ],
    },
  ]);
  assert.deepEqual(workEvents(hook("pre-agent")), [{ kind: "call", call: "toolu_01AgentFg0000000000000", type: "Explore", description: "Find API endpoints" }]);
  assert.deepEqual(workEvents(hook("subagent-start")), [{ kind: "agent-start", id: "a1b2c3d4e5f607182", type: "Explore" }]);
  assert.deepEqual(workEvents(hook("subagent-stop")), [
    {
      kind: "agent-end",
      id: "a1b2c3d4e5f607182",
      status: "done",
      type: "Explore",
      transcript: `/Users/me/.claude/projects/-tmp-proj/${SESSION}/subagents/agent-a1b2c3d4e5f607182.jsonl`,
      last: "Found 12 endpoints...",
    },
  ]);
  assert.deepEqual(workEvents(hook("post-agent")), [
    {
      kind: "agent-end",
      id: "a1b2c3d4e5f607182",
      call: "toolu_01AgentFg0000000000000",
      description: "Find API endpoints",
      type: "Explore",
      status: "done",
      last: "Found 12 endpoints...",
    },
  ]);
  const bg = workEvents(hook("post-agent-background"))[0] as { status: string; id: string; last?: string };
  assert.equal(bg.status, "running", "a background launch is still running");
  assert.equal(bg.id, "a0f1e2d3c4b5a6978");
  assert.equal(bg.last, undefined);
  assert.deepEqual(workEvents({ ...hook("post-taskupdate"), tool_name: "TaskStop", tool_input: { task_id: "a0f1e2d3c4b5a6978" } }), [
    { kind: "agent-end", id: "a0f1e2d3c4b5a6978", status: "stopped" },
  ]);
  // A tool call from inside a subagent carries agent_id; a task tool call there still counts.
  assert.deepEqual(workEvents(hook("post-tool-from-subagent")), [{ kind: "todo", id: "3", status: "completed" }]);
  assert.deepEqual(workEvents(hook("pre-tool-from-subagent")), [], "other tools hold no work");
  for (const bad of [undefined, null, "text", [], {}, { hook_event_name: "SubagentStart" }, { hook_event_name: "PostToolUse", tool_name: "Bash" }])
    assert.deepEqual(workEvents(bad), [], JSON.stringify(bad));
});

test("a todo keeps the full task: TaskCreate's description, and the latest one TaskUpdate or TaskGet gives", () => {
  assert.deepEqual(workEvents(hook("post-taskupdate", { tool_input: { taskId: "3", description: "Run it on Node 18 too" } })), [
    { kind: "todo", id: "3", description: "Run it on Node 18 too" },
  ]);
  assert.deepEqual(workEvents(hook("post-taskget", { tool_response: { task: { id: "3", subject: "Run the test suite", description: "From TaskGet" } } })), [
    { kind: "todo", id: "3", text: "Run the test suite", description: "From TaskGet" },
  ]);
  const home = tempHome();
  const todo = () => readWork(home, SESSION)!.todos.find((t) => t.id === "3")!;
  workHook(home, hook("post-taskcreate"), at(1));
  assert.equal(todo().description, "Run npm test and fix failures");
  workHook(home, hook("post-taskupdate"), at(2));
  assert.equal(todo().description, "Run npm test and fix failures", "an update without a description keeps it");
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "3", description: "Run it on Node 18 too" } }), at(3));
  assert.equal(todo().description, "Run it on Node 18 too", "the latest description wins");
  workHook(home, hook("post-tasklist"), at(4));
  assert.equal(todo().description, "Run it on Node 18 too", "a whole-list read keeps descriptions");
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "3", description: "" } }), at(5));
  assert.equal(todo().description, undefined, "an emptied description is gone");
  // Out of order: a creation after an update keeps the update's description.
  const late = tempHome();
  workHook(late, hook("post-taskupdate", { tool_input: { taskId: "3", description: "Newer" } }), at(1));
  workHook(late, hook("post-taskcreate"), at(2));
  assert.equal(readWork(late, SESSION)!.todos[0]!.description, "Newer");
  // The legacy whole-list tool has no descriptions.
  const legacy = tempHome();
  workHook(legacy, hook("post-todowrite"));
  assert.ok(readWork(legacy, SESSION)!.todos.every((t) => t.description === undefined));
});

test("the work record follows todos through creation, updates, deletion and whole-list writes, in any order", () => {
  const home = tempHome();
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Read the code" }, tool_response: { task: { id: "1", subject: "Read the code" } } }), at(1));
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Drop me" }, tool_response: { task: { id: "2", subject: "Drop me" } } }), at(2));
  workHook(home, hook("post-taskcreate"), at(3));
  workHook(home, hook("post-taskupdate"), at(4));
  workHook(home, hook("post-taskupdate-deleted"), at(5));
  let r = readWork(home, SESSION)!;
  assert.equal(r.cwd, "/tmp/proj");
  assert.deepEqual(
    r.todos.map((t) => [t.id, t.text, t.status, t.updated]),
    [
      ["1", "Read the code", "queued", at(1)],
      ["3", "Run the test suite", "running", at(4)],
    ],
  );
  assert.equal(r.todos[1]!.active, "Running the test suite");
  // Async hooks may land late: an update before its creation, a creation after an update, a deleted task's creation.
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "5", status: "in_progress" } }), at(6));
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Late" }, tool_response: { task: { id: "5", subject: "Late" } } }), at(7));
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Drop me" }, tool_response: { task: { id: "2", subject: "Drop me" } } }), at(8));
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Fourth" }, tool_response: { task: { id: "4", subject: "Fourth" } } }), at(9));
  workHook(home, hook("post-taskupdate-completed"), at(10));
  r = readWork(home, SESSION)!;
  assert.deepEqual(
    r.todos.map((t) => [t.id, t.text, t.status]),
    [
      ["1", "Read the code", "queued"],
      ["3", "Run the full test suite", "done"],
      ["4", "Fourth", "queued"],
      ["5", "Late", "running"],
    ],
  );
  // TaskList and TodoWrite hold the whole list.
  workHook(home, hook("post-tasklist"), at(11));
  assert.deepEqual(
    readWork(home, SESSION)!.todos.map((t) => [t.id, t.status]),
    [
      ["1", "done"],
      ["3", "running"],
      ["4", "queued"],
    ],
  );
  const legacy = tempHome();
  workHook(legacy, hook("post-todowrite"), at(1));
  assert.deepEqual(
    readWork(legacy, SESSION)!.todos.map((t) => [t.id, t.text, t.status, t.order]),
    [
      ["1", "Read the code", "done", 1],
      ["2", "Run tests", "running", 2],
    ],
  );
});

test("the work record follows subagents from the Agent call to their end, foreground, background and stopped", () => {
  const home = tempHome();
  workHook(home, hook("pre-agent"), at(0));
  workHook(home, hook("subagent-start"), at(1));
  let a = readWork(home, SESSION)!.agents;
  assert.deepEqual(a, [
    {
      id: "a1b2c3d4e5f607182",
      status: "running",
      started: at(1),
      type: "Explore",
      description: "Find API endpoints",
      call: "toolu_01AgentFg0000000000000",
      transcript: `/Users/me/.claude/projects/-tmp-proj/${SESSION}/subagents/agent-a1b2c3d4e5f607182.jsonl`,
    },
  ]);
  workHook(home, hook("subagent-stop"), at(49));
  workHook(home, hook("post-agent"), at(50));
  a = readWork(home, SESSION)!.agents;
  assert.equal(a.length, 1);
  assert.equal(a[0]!.status, "done");
  assert.equal(a[0]!.ended, at(49), "it ended when it stopped, not when its result came back");
  assert.equal(a[0]!.last, "Found 12 endpoints...");

  // Async hooks out of order: the start comes before its Agent call.
  const late = tempHome();
  workHook(late, hook("subagent-start"), at(1));
  workHook(late, hook("pre-agent"), at(2));
  assert.equal(readWork(late, SESSION)!.agents[0]!.description, "Find API endpoints");

  // A background agent: launched, then stopped by Claude with TaskStop.
  const bg = tempHome();
  const start = hook("subagent-start", { agent_id: "a0f1e2d3c4b5a6978", agent_type: "general-purpose" });
  workHook(bg, { ...hook("pre-agent"), tool_input: hook("post-agent-background").tool_input, tool_use_id: "toolu_01AgentBg0000000000000" }, at(0));
  workHook(bg, start, at(1));
  workHook(bg, hook("post-agent-background"), at(2));
  let b = readWork(bg, SESSION)!.agents[0]!;
  assert.deepEqual([b.description, b.status, b.ended], ["Run migrations", "running", undefined]);
  assert.match(b.transcript!, /subagents\/agent-a0f1e2d3c4b5a6978\.jsonl$/, "the transcript, not the output file");
  workHook(bg, { ...hook("post-taskupdate"), tool_name: "TaskStop", tool_input: { task_id: "a0f1e2d3c4b5a6978" }, tool_response: {} }, at(30));
  workHook(bg, hook("subagent-stop", { agent_id: "a0f1e2d3c4b5a6978" }), at(31));
  b = readWork(bg, SESSION)!.agents[0]!;
  assert.deepEqual([b.status, b.ended], ["stopped", at(30)], "a stopped agent stays stopped");
});

test("the work hook writes nothing for other input, never throws, and keeps sessions apart", () => {
  const home = tempHome();
  for (const bad of [{}, hook("pre-tool-from-subagent"), hook("post-taskcreate", { session_id: "../escape" }), "nope"])
    assert.equal(workHook(home, bad), undefined);
  assert.throws(() => readdirSync(join(home, "work")), /ENOENT/);
  workHook(home, hook("post-taskcreate"));
  workHook(home, hook("post-taskcreate", { session_id: "other-session" }));
  assert.deepEqual(
    readdirSync(join(home, "work"))
      .filter((f) => f.endsWith(".json"))
      .sort(),
    [`${SESSION}.json`, "other-session.json"],
  );
  writeFileSync(join(home, "work", `${SESSION}.json`), "{ broken");
  assert.equal(readWork(home, SESSION), undefined);
  assert.ok(workHook(home, hook("post-taskcreate")), "a broken record starts again");
});

test("hoop work-hook and the plugin's wrapper always exit 0 quietly, and record through hoop", async () => {
  const home = tempHome();
  const pages = await pagesFor(home);
  const env = { ...process.env, ...pages } as Record<string, string>;
  for (const input of ["", "not json", JSON.stringify(hook("pre-tool-from-subagent"))]) {
    const r = spawnSync(process.execPath, [...hoopArgs, "work-hook"], { input, encoding: "utf8", env });
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout + r.stderr, "");
  }
  const bin = mkdtempSync(join(tmpdir(), "hoop-work-bin-"));
  const crash = join(bin, "crash");
  writeFileSync(crash, `#!/bin/sh\ncat >/dev/null\necho ran >> "${bin}/ran"\necho boom >&2\nexit 1\n`, { mode: 0o755 });
  const run = (hoopBin: string, input: object) =>
    spawnSync("sh", [wrapper], { input: JSON.stringify(input), encoding: "utf8", env: { ...env, HOOP_BIN: hoopBin } });
  for (const [name, r] of [
    ["missing hoop", run(join(bin, "nothing"), hook("post-taskcreate"))],
    ["crash", run(crash, hook("subagent-start"))],
    ["other tool", run(crash, hook("pre-tool-from-subagent"))],
  ] as const) {
    assert.equal(r.status, 0, name);
    assert.equal(r.stdout + r.stderr, "", name);
  }
  assert.equal(readFileSync(join(bin, "ran"), "utf8"), "ran\n", "another tool's input doesn't start hoop");
  assert.throws(() => readdirSync(join(home, "work")), /ENOENT/);
  const ok = run(`${[process.execPath, ...hoopArgs].join(" ")}`, hook("post-taskcreate"));
  assert.equal(ok.status, 0);
  assert.equal(readWork(home, SESSION)?.todos[0]?.text, "Run the test suite");
  // Spaced JSON reaches hoop too.
  run(`${[process.execPath, ...hoopArgs].join(" ")}`, JSON.parse(JSON.stringify(hook("subagent-start"), null, 1)));
  assert.equal(readWork(home, SESSION)?.agents.length, 1);

  const hooks = JSON.parse(readFileSync(new URL("../plugins/hoop/hooks/hooks.json", import.meta.url), "utf8")).hooks;
  const work = (list: { matcher?: string; hooks: { command: string; async?: boolean }[] }[]) => list.filter((h) => /track-work\.sh/.test(h.hooks[0]!.command));
  assert.deepEqual(
    work(hooks.PostToolUse).map((h) => h.matcher),
    ["TaskCreate|TaskUpdate|TaskList|TaskGet|TaskStop|TodoWrite|Agent|Task"],
  );
  assert.deepEqual(
    work(hooks.PreToolUse).map((h) => h.matcher),
    ["Agent|Task"],
  );
  for (const event of ["PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop"])
    for (const h of work(hooks[event])) assert.equal(h.hooks[0]!.async, true, `${event} runs in the background, so it never slows a tool call`);
});

test("the sessions reader reads Claude Code's session files and skips ended processes", () => {
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "live-session", cwd: "/tmp/proj", status: "busy", name: "Order export", updatedAt: 1, kind: "interactive" }),
  );
  writeFileSync(join(dir, "999999.json"), JSON.stringify({ pid: 999999, sessionId: "dead-session", status: "idle" }));
  writeFileSync(join(dir, "12.json"), "{ broken");
  writeFileSync(join(dir, `${process.pid}.abc.key`), "{}");
  assert.deepEqual(claudeSessions(), [{ session: "live-session", pid: process.pid, status: "busy", name: "Order export", cwd: "/tmp/proj", updatedAt: 1 }]);
});

test("a subagent's last step is its transcript's last tool call, else its last words", () => {
  const dir = mkdtempSync(join(tmpdir(), "hoop-agent-"));
  const path = join(dir, "agent-a1.jsonl");
  const line = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
  writeFileSync(
    path,
    `${line([{ type: "text", text: "Looking around." }])}\n${line([{ type: "tool_use", name: "Bash", input: { command: "npm test", description: "Run the tests" } }])}\n${JSON.stringify({ type: "user", message: { content: [] } })}\n`,
  );
  assert.equal(lastStep(path), "Bash: Run the tests");
  writeFileSync(path, `${line([{ type: "text", text: "All   done.\nBye" }])}\n`);
  assert.equal(lastStep(path), "All done. Bye");
  assert.equal(lastStep(join(dir, "missing.jsonl")), undefined);
});

/** A home with two sessions' work: one busy with todos and a running agent, one ended with nothing left running. */
function seeded() {
  const home = tempHome();
  const claude = process.env.HOOP_CLAUDE_DIR!;
  mkdirSync(join(claude, "projects", "-tmp-proj"), { recursive: true });
  writeFileSync(join(claude, "projects", "-tmp-proj", `${SESSION}.jsonl`), `${JSON.stringify({ type: "custom-title", customTitle: "Order export" })}\n`);
  const agentLog = join(mkdtempSync(join(tmpdir(), "hoop-agent-")), "agent.jsonl");
  writeFileSync(
    agentLog,
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "router" } }] } })}\n`,
  );
  const now = new Date();
  const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
  for (const [id, subject] of [
    ["1", "Read the code"],
    ["2", "Run the test suite"],
    ["3", "Open a pull request"],
  ])
    workHook(home, hook("post-taskcreate", { tool_input: { subject }, tool_response: { task: { id, subject } } }), ago(100));
  workHook(home, hook("post-taskupdate-completed", { tool_input: { taskId: "1", status: "completed" } }), ago(90));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "2", status: "in_progress", activeForm: "Running the test suite" } }), ago(80));
  workHook(home, hook("pre-agent"), ago(75));
  workHook(home, hook("subagent-start", { agent_transcript_path: agentLog }), ago(75));
  workHook(home, hook("pre-agent", { tool_use_id: "t2", tool_input: { description: "Check the docs", subagent_type: "general-purpose" } }), ago(200));
  workHook(home, hook("subagent-start", { agent_id: "a2", agent_type: "general-purpose" }), ago(200));
  workHook(home, hook("subagent-stop", { agent_id: "a2", agent_type: "general-purpose", last_assistant_message: "The docs are current." }), ago(150));
  const ended = hook("post-todowrite", { session_id: "ended-session", cwd: "/work/other-repo" });
  workHook(home, ended, ago(3600));
  workHook(home, hook("pre-agent", { session_id: "ended-session", cwd: "/work/other-repo" }), ago(3600));
  workHook(home, hook("subagent-start", { session_id: "ended-session", cwd: "/work/other-repo" }), ago(3600));
  const sessions: ClaudeSession[] = [{ session: SESSION, pid: 1, status: "busy", cwd: "/tmp/proj", name: "ignored: the transcript's title wins" }];
  return { home, sessions };
}

test("the Work API lists each session with its state, name, folder, todos and agents", async () => {
  const { home, sessions } = seeded();
  const view = workView(home, () => sessions);
  assert.deepEqual(
    view.map((s) => [s.id, s.name, s.state, s.folder]),
    [
      [SESSION, "Order export", "busy", "proj"],
      ["ended-session", undefined, "ended", "other-repo"],
    ],
  );
  const [busy, ended] = view;
  assert.deepEqual(
    busy!.todos.map((t) => [t.text, t.status]),
    [
      ["Read the code", "done"],
      ["Run the test suite", "running"],
      ["Open a pull request", "queued"],
    ],
  );
  assert.deepEqual(
    busy!.agents.map((a) => [a.description, a.status, a.last]),
    [
      ["Find API endpoints", "running", "Grep: router"],
      ["Check the docs", "done", "The docs are current."],
    ],
  );
  assert.equal("call" in busy!.agents[0]!, false);
  assert.equal(ended!.agents[0]!.status, "stopped", "a running agent of an ended session shows as stopped");
  assert.equal(workView(home, () => [{ ...sessions[0]!, status: "idle" }])[0]!.state, "idle");

  const server = createWebServer(new Hoop(new Store(home)), [], { sessions: () => sessions });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body = await (await fetch(`${base}/api/work`)).json();
    assert.deepEqual(
      body.sessions.map((s: { id: string }) => s.id),
      [SESSION, "ended-session"],
    );
    assert.equal((await fetch(`${base}/work`)).status, 200);
    const empty = createWebServer(new Hoop(new Store(tempHome())), [], { sessions: () => [] });
    await new Promise<void>((r) => empty.listen(0, "127.0.0.1", r));
    const none = await (await fetch(`http://127.0.0.1:${(empty.address() as AddressInfo).port}/api/work`)).json();
    empty.close();
    assert.deepEqual(none, { sessions: [] });
  } finally {
    server.close();
  }
});

test("the Work page shows sessions, todos in order with done ones folded, agents, and refreshes", { skip: BROWSER_SKIP }, async () => {
  const { home, sessions } = seeded();
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => ((window as unknown as { HOOP_WORK_MS: number }).HOOP_WORK_MS = 200));
      await page.goto(`${base}/work`);
      const busy = page.locator("section.work-session").first();
      await busy.waitFor();
      assert.equal(await page.title(), "Work · hoop");
      assert.equal(await page.locator('header.frame a[aria-current="page"]').innerText(), "Work");
      assert.equal(await busy.locator("h2").innerText(), "Order export");
      assert.match(await busy.locator(".session-head").innerText(), /11111111.*proj.*Working/s);
      assert.deepEqual(await busy.locator("ol.todos").first().locator(".t").allInnerTexts(), ["Running the test suite", "Open a pull request"]);
      const done = busy.locator("details.done");
      assert.equal(await done.locator("summary").innerText(), "1 done");
      assert.equal(await done.getAttribute("open"), null, "done todos are folded");
      const agent = busy.locator(".agent").first();
      // Elapsed time counts from the seeded start, so a page that loads slowly shows a few seconds more.
      assert.match(await agent.innerText(), /Running\s*Find API endpoints\s*running for 1 m · last activity \d+ s ago/);
      assert.equal(await agent.locator(".last").count(), 0, "its transcript shows no step with a time, so only how long it runs");
      // The finished agent folds below the running one, and says what it came to.
      const finished = busy.locator("details.finished > summary");
      assert.equal(await finished.innerText(), "1 finished");
      await finished.click();
      assert.match(await busy.locator(".agent").nth(1).innerText(), /Done\s*Check the docs\s*ran for 50s\s*The docs are current\./);
      const ended = page.locator("section.work-session").nth(1);
      assert.equal(await ended.locator("h2").innerText(), "Unnamed session");
      assert.match(await ended.locator(".session-head").innerText(), /Ended/);
      assert.match((await ended.locator(".agent").textContent()) ?? "", /Stopped.*Stopped: its session ended/);
      // A todo added while the page is open appears, and an opened fold stays open.
      await done.locator("summary").click();
      workHook(home, hook("post-taskcreate", { tool_input: { subject: "Write the docs" }, tool_response: { task: { id: "4", subject: "Write the docs" } } }));
      await busy.locator(".todo", { hasText: "Write the docs" }).waitFor();
      assert.notEqual(await busy.locator("details.done").getAttribute("open"), null);
    },
    new Hoop(new Store(home)),
    { sessions: () => sessions },
  );
});

test("the Work page explains how to turn todos on when there is no work", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/work`);
      const empty = page.locator(".work .empty");
      await empty.waitFor();
      assert.match(await empty.innerText(), /No work tracked yet/);
      assert.match(await empty.innerText(), /CLAUDE_CODE_ENABLE_TODO_TOOLS=1/);
      assert.match(await empty.innerText(), /Run hoop init and answer yes to turn the todo tools on/);
    },
    new Hoop(new Store(tempHome())),
    { sessions: () => [] },
  );
  // A session with agents but no todos says how to turn them on, in its own section.
  const home = tempHome();
  workHook(home, hook("subagent-start"));
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/work`);
      await page.locator("section.work-session").waitFor();
      assert.match(await page.locator("section.work-session .none").first().innerText(), /No todos.*CLAUDE_CODE_ENABLE_TODO_TOOLS=1.*run hoop init/s);
    },
    new Hoop(new Store(home)),
    { sessions: () => [] },
  );
});

test("each Work session, and its todos and subagents, collapses from its heading, and stays so across polls and reloads", { skip: BROWSER_SKIP }, async () => {
  const { home, sessions } = seeded();
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => ((window as unknown as { HOOP_WORK_MS: number }).HOOP_WORK_MS = 200));
      await page.goto(`${base}/work`);
      const busy = page.locator("section.work-session").first();
      await busy.locator(".agent").first().waitFor();
      const toggle = page.getByRole("button", { name: "Order export", exact: true });
      const expanded = (b = toggle) => b.getAttribute("aria-expanded");
      assert.equal(await expanded(), "true");
      const body = page.locator(`#${await toggle.getAttribute("aria-controls")}`);
      assert.equal(await busy.locator(".fold-summary").count(), 0, "an open session shows no summary");

      // A click folds the session and shows what it holds beside its name.
      await toggle.click();
      assert.equal(await expanded(), "false");
      assert.equal(await body.isHidden(), true);
      assert.equal(await busy.locator(".session-head .fold-summary").innerText(), "1 queued · 1 running · 1 done · 1 agent running");
      assert.equal(await hasFocus(toggle), true, "focus stays on the button");
      // Enter and Space toggle it from the keyboard.
      await page.keyboard.press("Enter");
      assert.equal(await expanded(), "true");
      assert.equal(await busy.locator(".agent").first().isVisible(), true);
      // Space toggles once, even when a repaint replaces the button between key down and key up (#251).
      await page.keyboard.press(" ");
      assert.equal(await expanded(), "false");
      await page.keyboard.press(" ");
      assert.equal(await expanded(), "true");
      await page.keyboard.down(" ");
      await page.locator(".list.work").evaluate((el) => el.setAttribute("data-old", ""));
      await page.locator(".list.work:not([data-old])").waitFor();
      // Its key up is cancelled too, so no browser clicks the button a second time.
      await page.evaluate(() =>
        window.addEventListener("keyup", (e) => ((window as unknown as { spaceUp: boolean }).spaceUp = e.defaultPrevented), { once: true }),
      );
      await page.keyboard.up(" ");
      assert.equal(await page.evaluate(() => (window as unknown as { spaceUp: boolean }).spaceUp), true);
      assert.equal(await expanded(), "false");
      assert.equal(await hasFocus(toggle), true);
      await page.keyboard.press("Enter");

      // Its Todos and Subagents fold on their own, each with its counts.
      const todos = busy.getByRole("button", { name: "Todos" });
      const agents = busy.getByRole("button", { name: "Subagents" });
      await todos.click();
      await agents.focus();
      await page.keyboard.press("Enter");
      assert.equal(await expanded(todos), "false");
      assert.equal(await expanded(agents), "false");
      assert.deepEqual(await busy.locator(".part-head .fold-summary").allInnerTexts(), ["1 queued · 1 running · 1 done", "1 running · 1 done"]);
      assert.equal(await busy.locator(".todo").first().isVisible(), false);
      assert.equal(await busy.locator(".agent").first().isVisible(), false);

      // The poll paints the page again, and the folds and focus stay.
      await page.getByRole("button", { name: "Unnamed session", exact: true }).click();
      await busy.evaluate((el) => el.setAttribute("data-old", ""));
      await page.locator("section.work-session:not([data-old])").first().waitFor();
      assert.equal(await expanded(page.getByRole("button", { name: "Unnamed session", exact: true })), "false");
      assert.equal(await hasFocus(page.getByRole("button", { name: "Unnamed session", exact: true })), true);
      assert.equal(await expanded(todos), "false");
      // A reload keeps them too.
      await page.reload();
      await page.locator("section.work-session").first().waitFor();
      assert.equal(await expanded(page.getByRole("button", { name: "Unnamed session", exact: true })), "false");
      assert.equal(await expanded(agents), "false");
      assert.equal(await expanded(), "true");

      // Expand all opens every part; Collapse all folds every session.
      await page.getByRole("button", { name: "Expand all" }).click();
      assert.deepEqual(await page.locator("[data-collapse]").evaluateAll((els) => els.map((el) => el.getAttribute("aria-expanded"))), Array(6).fill("true"));
      assert.equal(await hasFocus(page.getByRole("button", { name: "Expand all" })), true);
      await page.getByRole("button", { name: "Collapse all" }).click();
      assert.deepEqual(await page.locator("[data-level=session]").evaluateAll((els) => els.map((el) => el.getAttribute("aria-expanded"))), ["false", "false"]);
      assert.equal(await page.locator(".work-session .fold-body").first().isHidden(), true);
      assert.deepEqual(await page.locator(".session-head .fold-summary").allInnerTexts(), [
        "1 queued · 1 running · 1 done · 1 agent running",
        "1 not running · 1 done",
      ]);
    },
    new Hoop(new Store(home)),
    { sessions: () => sessions },
  );
});

test("a Work poll that repaints the page mid-Tab keeps the focus on the same control, in the header too", { skip: BROWSER_SKIP }, async () => {
  const { home, sessions } = seeded();
  await withBrowser(
    async ({ base, page }) => {
      // The page's own poll waits; the test repaints it at each stop instead.
      await page.addInitScript(() => ((window as unknown as { HOOP_WORK_MS: number }).HOOP_WORK_MS = 600_000));
      await page.goto(`${base}/work`);
      await page.locator(".work-session .agent").first().waitFor();
      const repaint = async () => {
        await page.evaluate(() => document.querySelector("#app")!.firstElementChild!.setAttribute("data-old", ""));
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await page.locator("#app > [data-old]").waitFor({ state: "detached" });
      };
      // What the focused control is, and which of the controls like it.
      const focused = () =>
        page.evaluate(`(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const what = (e) => e.tagName + " " + (e.getAttribute("href") ?? "") + " " + (e.getAttribute("aria-label") ?? "") + " " + (e.textContent ?? "").trim().slice(0, 40);
          const same = [...document.querySelectorAll("a[href], button, summary")].filter((e) => what(e) === what(el));
          return what(el) + " #" + same.indexOf(el);
        })()`) as Promise<string | null>;
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      const seen: string[] = [];
      for (let i = 0; i < 80; i++) {
        await page.keyboard.press("Tab");
        const stop = await focused();
        // Past the last control, Tab leaves the page or wraps to the first.
        if (!stop || stop === seen[0]) break;
        seen.push(stop);
        await repaint();
        assert.equal(await focused(), stop, "the repaint keeps the focus where it was");
      }
      assert.ok(seen.length > 10, `the walk passed ${seen.length} controls`);
      assert.ok(
        seen.some((s) => s.startsWith("A / ")),
        "it passed the header's links",
      );
    },
    new Hoop(new Store(home)),
    { sessions: () => sessions },
  );
});

test("a Work repaint that adds controls above the focused link keeps the focus on that link", { skip: BROWSER_SKIP }, async () => {
  const { home, hoop } = described();
  const live: ClaudeSession[] = [];
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => ((window as unknown as { HOOP_WORK_MS: number }).HOOP_WORK_MS = 600_000));
      await page.goto(`${base}/work`);
      const link = page.locator('.todo[data-todo="1"] .desc a[href*="issues/7"]');
      await link.focus();
      // A busy session starts, and sorts above the ended one with its own controls.
      const other = "22222222-3333-4444-5555-666666666666";
      workHook(
        home,
        hook("post-taskcreate", { session_id: other, cwd: "/tmp/other", tool_input: { subject: "Other work" }, tool_response: { task: { id: "1" } } }),
      );
      live.push({ session: other, pid: 1, status: "busy", cwd: "/tmp/other" });
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.locator("section.work-session", { hasText: "Other work" }).waitFor();
      assert.equal(await page.locator("section.work-session").first().locator(".todo .t", { hasText: "Other work" }).count(), 1, "the new session is above");
      assert.equal(await hasFocus(link, 2000), true, "the focus stays on the same link");
    },
    hoop,
    { sessions: () => live },
  );
});

/** A session whose queued todo links to a review, to another review hoop doesn't know, and to GitHub. */
function described() {
  const home = tempHome();
  const hoop = new Hoop(new Store(home));
  const { review_id } = hoop.submit(example());
  const title = hoop.store.meta(review_id).title;
  const long = [
    `Plan approved in http://localhost:4747/r/${review_id}.`,
    "Then see [the issue](https://github.com/acme/shop/issues/7) and https://github.com/acme/shop/pull/9, and the old plan at http://localhost:4747/r/rv_unknown0.",
    "Write the **migration** with `ALTER TABLE` first, then backfill the rows in batches of a thousand, and check the counts match before switching reads over.",
    "Last line, only seen once expanded.",
  ].join("\n");
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Ship the export", description: long }, tool_response: { task: { id: "1" } } }));
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Tidy up", description: "Short one." }, tool_response: { task: { id: "2" } } }));
  return { home, hoop, review_id, title };
}

test("the Work API titles the reviews a todo's description links to, when the store knows them", async () => {
  const { hoop, review_id, title } = described();
  const server = createWebServer(hoop, [], { sessions: () => [] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/work`)).json();
    const [ship, tidy] = body.sessions[0].todos;
    assert.match(ship.description, /^Plan approved in http:\/\/localhost:4747\/r\//);
    assert.deepEqual(ship.reviews, { [review_id]: title }, "an unknown review gets no title");
    assert.equal(tidy.reviews, undefined);
  } finally {
    server.close();
  }
});

test("the Work page shows a todo's description in two lines, More shows it all, and its links work", { skip: BROWSER_SKIP }, async () => {
  const { hoop, review_id, title } = described();
  await withBrowser(
    async ({ base, page }) => {
      await page.setViewportSize({ width: 400, height: 800 });
      await page.goto(`${base}/work`);
      const ship = page.locator('.todo[data-todo="1"]');
      const desc = ship.locator(".desc");
      await desc.waitFor();
      const lineHeight = await desc.evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight));
      const height = async () => (await desc.boundingBox())!.height;
      assert.ok((await height()) <= lineHeight * 2 + 1, "two lines at first");
      const more = ship.getByRole("button", { name: /^More of the description of todo #1/ });
      assert.equal(await more.getAttribute("aria-expanded"), "false");
      assert.equal(await more.getAttribute("aria-controls"), await desc.getAttribute("id"));
      assert.equal(await page.locator('.todo[data-todo="2"] [data-act="more"]').isVisible(), false, "a short description needs no More");

      // From the keyboard: More shows it all, Less folds it again, and focus stays on the button.
      await more.focus();
      await page.keyboard.press("Enter");
      const less = ship.getByRole("button", { name: /^Less of the description/ });
      assert.equal(await less.getAttribute("aria-expanded"), "true");
      assert.ok((await height()) > lineHeight * 4, "the whole description shows");
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Less");
      await page.keyboard.press("Space");
      assert.equal(await more.getAttribute("aria-expanded"), "false");
      assert.ok((await height()) <= lineHeight * 2 + 1);

      // Links: a known review shows its title and opens here; others open a new tab.
      const links = await desc
        .locator("a")
        .evaluateAll((els) => els.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")]));
      assert.deepEqual(links, [
        [title, `http://localhost:4747/r/${review_id}`, null, null],
        ["the issue", "https://github.com/acme/shop/issues/7", "_blank", "noopener noreferrer"],
        ["https://github.com/acme/shop/pull/9", "https://github.com/acme/shop/pull/9", "_blank", "noopener noreferrer"],
        ["http://localhost:4747/r/rv_unknown0", "http://localhost:4747/r/rv_unknown0", null, null],
      ]);
      // Links sit in the text, not boxed like Home's review rows.
      const boxes = await desc
        .locator("a")
        .evaluateAll((els) => els.map((a) => [getComputedStyle(a).display, getComputedStyle(a).borderTopWidth, getComputedStyle(a).paddingTop]));
      for (const box of boxes) assert.deepEqual(box, ["inline", "0px", "0px"]);
      assert.equal(await desc.locator("strong").innerText(), "migration");
      assert.equal(await desc.locator("code").innerText(), "ALTER TABLE");
    },
    hoop,
    { sessions: () => [] },
  );
});

test("with a mouse, a todo's buttons show only while it's pointed at or holds focus", { skip: BROWSER_SKIP }, async () => {
  const { hoop } = described();
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/work`);
      const ship = page.locator('.todo[data-todo="1"]');
      const acts = ship.locator(".acts").first();
      await acts.waitFor();
      const opacity = () => acts.evaluate((el) => getComputedStyle(el).opacity);
      await page.mouse.move(0, 0);
      assert.equal(await opacity(), "0", "hidden in a list at rest");
      await ship.hover();
      assert.equal(await opacity(), "1", "shown while pointed at");
      await page.mouse.move(0, 0);
      await acts.locator("button").first().focus();
      assert.equal(await opacity(), "1", "shown while a button holds focus");
    },
    hoop,
    { sessions: () => [] },
  );
});
