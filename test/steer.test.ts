import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { INSTRUCTIONS } from "../src/mcp.js";
import { OPS } from "../src/ops.js";
import { addChanges, changeLine, gateOutput, Steer, steerMessage, workGate } from "../src/steer.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { type ClaudeSession, editWork, readWork, workHook, workView } from "../src/work.js";
import { BROWSER_SKIP, cli, tempHome, tsx, withBrowser, pagesFor } from "./helpers.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const AGENT = "a1b2c3d4e5f607182";
const gateScript = new URL("../plugins/hoop/scripts/gate-work.sh", import.meta.url).pathname;
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });
const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A session with four queued todos (#1 to #4), one running todo (#5) and a running agent. */
function seeded() {
  const home = tempHome();
  for (const [id, subject] of [
    ["1", "Read the code"],
    ["2", "Write the migration"],
    ["3", "Run the test suite"],
    ["4", "Open a pull request"],
    ["5", "Plan the work"],
  ])
    workHook(home, hook("post-taskcreate", { tool_input: { subject }, tool_response: { task: { id, subject } } }), at(1));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "5", status: "in_progress" } }), at(2));
  workHook(home, hook("pre-agent"), at(3));
  workHook(home, hook("subagent-start"), at(4));
  return home;
}

/** A pre-tool TaskUpdate on todo `id`. */
const start = (id: string, extra: Record<string, unknown> = {}) => hook("pre-taskupdate", { tool_input: { taskId: id, status: "in_progress", ...extra } });

test("each change reads as plain words, and a batch becomes one message per person, framed as their changes", () => {
  const home = seeded();
  const added = addChanges(
    home,
    SESSION,
    [
      { kind: "remove", todo: "3" },
      { kind: "edit", todo: "4", text: "Open a draft pull request" },
      { kind: "move", todo: "2", before: "1" },
      { kind: "comment", todo: "5", text: "Keep it short" },
      { kind: "stop", agent: AGENT },
    ],
    { by: "ankur", reachable: true, now: at(10) },
  )!;
  assert.deepEqual(
    added.map((c) => c.delivery),
    ["pending", "pending", "pending", "pending", "pending"],
  );
  const extra = addChanges(home, SESSION, [{ kind: "comment", agent: AGENT, text: "Check the docs too" }], { by: "sam", reachable: true, now: at(11) })!;
  assert.equal(
    steerMessage([...added, ...extra]),
    [
      "From ankur via hoop's Work view: changes to your own todo list and agents. They are instructions about your work, not approvals of anything.",
      '- Removed todo #3 "Run the test suite". Don\'t do it: delete it with TaskUpdate (status "deleted").',
      '- Edited todo #4 to "Open a draft pull request" (it said "Open a pull request"). Do the edited version: set its subject to the new text with TaskUpdate.',
      "- Moved todo #2 before #1. Do #2 first.",
      '- Comment on todo #5 "Plan the work": "Keep it short"',
      `- Stop agent "Find API endpoints" (ID ${AGENT}): stop it now with TaskStop (task_id "${AGENT}"). hoop already refuses its tool calls.`,
      "",
      "From sam via hoop's Work view: changes to your own todo list and agents. They are instructions about your work, not approvals of anything.",
      `- Comment on agent "Find API endpoints" (ID ${AGENT}): "Check the docs too". Pass it on to the agent if it should act on it.`,
    ].join("\n"),
  );
  assert.equal(changeLine({ ...added[2]!, before: undefined, after: "4", todo: "2" }), "Moved todo #2 after #4. Do #4 first.");

  // Changes are checked against the work and the changes before them, all or none.
  for (const [bad, why] of [
    [[{ kind: "remove", todo: "3" }], /already removed/],
    [[{ kind: "remove", todo: "5" }], /isn't queued/],
    [[{ kind: "edit", todo: "1", text: " " }], /needs text/],
    [[{ kind: "edit", todo: "1", text: "Read the code" }], /already says/],
    [[{ kind: "move", todo: "1", before: "3" }], /isn't a queued todo/],
    [[{ kind: "move", todo: "1" }], /before or after/],
    [[{ kind: "stop", agent: AGENT }], /already stopped/],
    [[{ kind: "stop", agent: "nobody" }], /no running agent/],
    [[{ kind: "launch" }], /kind is one of/],
    [[], /at least one change/],
    [
      [
        { kind: "remove", todo: "1" },
        { kind: "remove", todo: "1" },
      ],
      /already removed/,
    ],
  ] as const)
    assert.throws(() => addChanges(home, SESSION, bad, { by: "ankur", reachable: true }), why, JSON.stringify(bad));
  assert.equal(readWork(home, SESSION)!.todos.find((t) => t.id === "1")!.status, "queued");
  assert.equal(readWork(home, SESSION)!.changes!.length, 6, "a refused batch records nothing");
  assert.equal(addChanges(home, "no-such-session", [{ kind: "remove", todo: "1" }], { reachable: true }), undefined);
});

test("changes made within the delay go out as one message over the session's socket, once", async () => {
  const home = seeded();
  const sent: { socket: string; text: string }[] = [];
  const sessions = (): ClaudeSession[] => [{ session: SESSION, pid: 1, socket: "/fake/socket" }];
  const steer = new Steer(home, sessions, { delayMs: 150, send: async (socket, text) => void sent.push({ socket, text }) });
  steer.record(SESSION, [{ kind: "remove", todo: "3" }], "ankur");
  await sleep(50);
  steer.record(SESSION, [{ kind: "comment", todo: "1", text: "Start here" }], "ankur");
  await sleep(50);
  steer.record(SESSION, [{ kind: "stop", agent: AGENT }], "ankur");
  assert.equal(sent.length, 0, "nothing goes out while changes keep coming");
  await sleep(300);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.socket, "/fake/socket");
  assert.match(sent[0]!.text, /^From ankur via hoop's Work view/);
  assert.equal(sent[0]!.text.split("\n").filter((l) => l.startsWith("- ")).length, 3);
  const changes = readWork(home, SESSION)!.changes!;
  assert.deepEqual(
    changes.map((c) => c.delivery),
    ["sent", "sent", "sent"],
  );
  assert.ok(changes.every((c) => c.sent_at));
  assert.deepEqual(await steer.flush(SESSION), [], "a flush with nothing pending sends nothing");
  assert.equal(sent.length, 1);

  // A send that fails leaves the changes to the gate.
  const failing = new Steer(seeded(), sessions, { delayMs: 10_000, send: async () => Promise.reject(new Error("refused")) });
  failing.record(SESSION, [{ kind: "remove", todo: "2" }], "ankur");
  const [c] = await failing.flush(SESSION);
  assert.equal(c!.delivery, "waiting");
});

test("a message reaches a fake session socket as one JSON line, and nothing is sent to a session that isn't live or has no socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-"));
  const path = join(dir, "s.sock");
  const lines: string[] = [];
  const server = createSocketServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  try {
    const home = seeded();
    const steer = new Steer(home, () => [{ session: SESSION, pid: 1, socket: path }], { delayMs: 10_000 });
    steer.record(SESSION, [{ kind: "edit", todo: "2", text: "Write the down migration too" }], "ankur");
    const [c] = await steer.flush(SESSION);
    assert.equal(c!.delivery, "sent");
    for (let i = 0; i < 50 && !lines.length; i++) await sleep(20);
    assert.equal(lines.length, 1);
    const msg = JSON.parse(lines[0]!);
    assert.deepEqual(Object.keys(msg), ["type", "message"]);
    assert.equal(msg.type, "user");
    assert.equal(msg.message.role, "user");
    assert.match(msg.message.content, /^From ankur via hoop's Work view.*\n- Edited todo #2 to "Write the down migration too"/s);

    // Not live (no session entry) or live without a socket: recorded as waiting, nothing sent.
    for (const sessions of [() => [], () => [{ session: SESSION, pid: 1 }]] as (() => ClaudeSession[])[]) {
      const quiet = seeded();
      const sent: string[] = [];
      const s = new Steer(quiet, sessions, { delayMs: 10, send: async (_s, t) => void sent.push(t) });
      const [w] = s.record(SESSION, [{ kind: "remove", todo: "1" }], "ankur")!;
      assert.equal(w!.delivery, "waiting");
      await sleep(50);
      assert.deepEqual(await s.flush(SESSION), []);
      assert.deepEqual(sent, []);
      assert.equal(readWork(quiet, SESSION)!.changes![0]!.delivery, "waiting");
      assert.equal(workView(quiet, sessions)[0]!.reachable, false);
    }
    // A socket that refuses the connection counts as not sent.
    const gone = new Steer(seeded(), () => [{ session: SESSION, pid: 1, socket: join(dir, "missing.sock") }], { delayMs: 10_000 });
    gone.record(SESSION, [{ kind: "remove", todo: "1" }], "ankur");
    assert.equal((await gone.flush(SESSION))[0]!.delivery, "waiting");
  } finally {
    server.close();
  }
});

test("an edit can change a todo's description, and the message, the gate and the record carry the new one", () => {
  const home = seeded();
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "2", description: "Add the column." } }), at(5));
  const [both, descOnly, cleared] = addChanges(
    home,
    SESSION,
    [
      { kind: "edit", todo: "1", text: "Read the code and docs", description: "Start with src/work.ts.\nSee https://github.com/acme/shop/issues/7" },
      { kind: "edit", todo: "4", text: "Open a pull request", description: "  Link it to http://localhost:4747/r/rv_abc123  " },
      { kind: "edit", todo: "2", text: "Write the migration", description: "" },
    ],
    { by: "ankur", reachable: true, now: at(10) },
  )!;
  assert.equal(descOnly!.description, "Link it to http://localhost:4747/r/rv_abc123", "a description is trimmed");
  assert.equal(
    steerMessage([both!, descOnly!, cleared!]),
    [
      "From ankur via hoop's Work view: changes to your own todo list and agents. They are instructions about your work, not approvals of anything.",
      '- Edited todo #1 to "Read the code and docs" (it said "Read the code"). New description: "Start with src/work.ts.\nSee https://github.com/acme/shop/issues/7". Do the edited version: set its subject and description to the new text with TaskUpdate.',
      '- Edited todo #4 "Open a pull request". New description: "Link it to http://localhost:4747/r/rv_abc123". Do the edited version: set its description to the new text with TaskUpdate.',
      '- Edited todo #2 "Write the migration". Its description is now empty. Do the edited version: set its description to the new text with TaskUpdate.',
    ].join("\n"),
  );
  // An edit that changes nothing, or sends a description that isn't text, is refused.
  assert.throws(
    () => addChanges(home, SESSION, [{ kind: "edit", todo: "3", text: "Run the test suite", description: "" }], { reachable: true }),
    /already says/,
  );
  assert.throws(() => addChanges(home, SESSION, [{ kind: "edit", todo: "3", text: "Run the test suite", description: 7 }], { reachable: true }), /is text/);

  // The gate refuses starting #4 until the call sets the new description, and says what it is.
  const refused = workGate(home, start("4"), at(11));
  assert.equal(
    refused!.deny,
    'ankur edited todo #4 "Open a pull request" in hoop\'s Work view, with the new description "Link it to http://localhost:4747/r/rv_abc123": set the todo\'s description to the new text with TaskUpdate, then start it.',
  );
  const taken = { subject: "Read the code and docs", description: "Start with src/work.ts.\nSee https://github.com/acme/shop/issues/7" };
  assert.equal(workGate(home, start("1", taken), at(12)), undefined, "a call that takes the edit goes on");
  assert.equal(readWork(home, SESSION)!.changes!.find((c) => c.todo === "1")!.delivery, "pending");
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", ...taken } }), at(12));
  assert.equal(readWork(home, SESSION)!.changes!.find((c) => c.todo === "1")!.delivery, "seen");

  // The record marks a description edit seen once the agent sets it.
  assert.equal(readWork(home, SESSION)!.changes!.find((c) => c.todo === "2")!.delivery, "pending");
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "2", description: "" } }), at(13));
  assert.equal(readWork(home, SESSION)!.changes!.find((c) => c.todo === "2")!.delivery, "seen");
});

test("the gate refuses a removed todo, an edited one once, every call of a stopped agent, and lets the rest go", () => {
  const home = seeded();
  addChanges(
    home,
    SESSION,
    [
      { kind: "remove", todo: "3" },
      { kind: "edit", todo: "4", text: "Open a draft pull request" },
      { kind: "stop", agent: AGENT },
    ],
    { by: "ankur", reachable: true },
  );
  // Unchanged todos and other tools go on.
  assert.equal(workGate(home, start("1")), undefined);
  assert.equal(workGate(home, hook("pre-agent")), undefined);
  assert.deepEqual(gateOutput(undefined), {});
  // A removed todo: refused when started or marked done, every time; deleting it goes on.
  const removed = workGate(home, start("3"));
  assert.match(removed!.deny, /^ankur removed todo #3 "Run the test suite" in hoop's Work view\. Don't start it or mark it done/);
  assert.ok(workGate(home, start("3", { status: "completed" })));
  assert.ok(workGate(home, start("3")), "a removed todo stays refused");
  assert.equal(workGate(home, start("3", { status: "deleted" })), undefined);
  // An edited todo: refused once with the new text; then, or with the new subject, it goes on.
  assert.equal(workGate(home, start("4", { subject: "Open a draft pull request" })), undefined);
  const edited = workGate(home, start("4"));
  assert.match(edited!.deny, /edited todo #4 in hoop's Work view to "Open a draft pull request"\. Do that instead of "Open a pull request"/);
  assert.equal(workGate(home, start("4")), undefined, "an edit is refused only once");
  assert.equal(readWork(home, SESSION)!.changes!.find((c) => c.kind === "edit")!.delivery, "seen");
  // A stopped agent: any of its tool calls, but not the session's own.
  const stopped = workGate(home, hook("pre-tool-from-subagent"));
  assert.equal(stopped!.deny, "Stopped by ankur in hoop's Work view. Don't call any more tools: end your turn now and say what you finished.");
  assert.ok(workGate(home, hook("pre-tool-from-subagent")), "it stays stopped");
  assert.equal(workGate(home, hook("pre-tool-from-subagent", { agent_id: "another-agent" })), undefined);
  assert.equal(
    workGate(home, hook("pre-tool-from-subagent", { agent_id: undefined, tool_input: { agent_id: AGENT } })),
    undefined,
    "an agent_id in a tool's input isn't the caller",
  );
  assert.deepEqual(gateOutput(stopped), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: stopped!.deny },
  });
  // Anything else goes on.
  for (const other of [{}, "x", { ...start("3"), session_id: "other" }, { ...start("3"), hook_event_name: "PostToolUse" }])
    assert.equal(workGate(home, other), undefined, JSON.stringify(other));

  // The legacy whole-list tool: a todo is known by its text.
  const legacy = tempHome();
  workHook(
    legacy,
    hook("post-todowrite", {
      tool_input: {
        todos: [
          { content: "Read the code", status: "pending" },
          { content: "Run tests", status: "pending" },
        ],
      },
    }),
  );
  addChanges(legacy, SESSION, [{ kind: "remove", todo: "2" }], { by: "ankur", reachable: false });
  assert.match(workGate(legacy, hook("pre-todowrite"))!.deny, /removed todo #2 "Run tests"/);
  assert.equal(workGate(legacy, hook("pre-todowrite", { tool_input: { todos: [{ content: "Read the code", status: "in_progress" }] } })), undefined);
});

test("a move or comment the session never got is told once by the gate, and a waiting comment reaches its agent", () => {
  const home = seeded();
  addChanges(
    home,
    SESSION,
    [
      { kind: "move", todo: "2", before: "1" },
      { kind: "comment", todo: "3", text: "Use the fast suite" },
      { kind: "comment", agent: AGENT, text: "Skip the vendored code" },
    ],
    { by: "ankur", reachable: false },
  );
  assert.match(workGate(home, start("1"))!.deny, /asked in hoop's Work view for todo #2 to come before #1\. Start #2 first\./);
  assert.equal(workGate(home, start("1")), undefined, "told once");
  assert.equal(workGate(home, start("2")), undefined);
  assert.match(workGate(home, start("3"))!.deny, /commented on todo #3 in hoop's Work view: "Use the fast suite"/);
  assert.match(
    workGate(home, hook("pre-tool-from-subagent"))!.deny,
    /^ankur commented on your work in hoop's Work view: "Skip the vendored code"\. Take it into account, then go on\.$/,
  );
  assert.equal(workGate(home, hook("pre-tool-from-subagent")), undefined, "a comment is told once");
  // A sent move is the message's job; the person's order still stands at the gate, once.
  const sent = seeded();
  addChanges(sent, SESSION, [{ kind: "move", todo: "2", before: "1" }], { by: "ankur", reachable: true });
  editWork(sent, SESSION, (r) => void (r.changes![0]!.delivery = "sent"));
  assert.equal(workGate(sent, start("1"))!.deny, "The person put #2 first in hoop's Work view; start #2, or ask them.");
  assert.equal(workGate(sent, start("1")), undefined);
});

test("the hooks mark each change seen when the agent acts on it, or overridden when it goes another way", () => {
  const home = seeded();
  addChanges(
    home,
    SESSION,
    [
      { kind: "remove", todo: "1" },
      { kind: "edit", todo: "2", text: "Write both migrations" },
      { kind: "move", todo: "4", before: "3" },
      { kind: "comment", todo: "5", text: "Faster" },
      { kind: "stop", agent: AGENT },
    ],
    { by: "ankur", reachable: true },
  );
  const delivery = () => Object.fromEntries(readWork(home, SESSION)!.changes!.map((c) => [c.kind, c.delivery]));
  workHook(home, hook("post-taskupdate-deleted", { tool_input: { taskId: "1", status: "deleted" } }));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "2", subject: "Write both migrations" } }));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "4", status: "in_progress" } }));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "5", status: "completed" } }));
  workHook(home, hook("subagent-stop"));
  assert.deepEqual(delivery(), { remove: "seen", edit: "seen", move: "seen", comment: "seen", stop: "seen" });

  const other = seeded();
  addChanges(
    other,
    SESSION,
    [
      { kind: "remove", todo: "1" },
      { kind: "edit", todo: "2", text: "Write both migrations" },
      { kind: "move", todo: "4", before: "3" },
    ],
    { by: "ankur", reachable: true },
  );
  for (const id of ["1", "2", "3"]) workHook(other, hook("post-taskupdate", { tool_input: { taskId: id, status: "in_progress" } }));
  assert.deepEqual(
    readWork(other, SESSION)!.changes!.map((c) => c.delivery),
    ["overridden", "overridden", "overridden"],
  );
  // The stopped agent stays in the gate's file for good; other settled changes leave it.
  const files = join(home, "work", SESSION);
  assert.equal(readFileSync(`${files}.agents`, "utf8"), `${AGENT}\tstop\tankur\n`);
  assert.equal(existsSync(`${files}.gate`), false);
});

test("the Work page shows people's queued todos in the order they asked for", () => {
  const home = seeded();
  addChanges(home, SESSION, [{ kind: "move", todo: "4", before: "2" }], { by: "ankur", reachable: false });
  addChanges(home, SESSION, [{ kind: "move", todo: "1", after: "3" }], { by: "ankur", reachable: false });
  assert.deepEqual(
    workView(home, () => [])[0]!.todos.map((t) => t.id),
    ["4", "2", "3", "1", "5"],
  );
});

test("the gate script is quick and quiet without changes, fails open for todos, and fails closed for a stopped agent", async () => {
  const home = tempHome();
  const pages = await pagesFor(home);
  const bin = mkdtempSync(join(tmpdir(), "hoop-gate-bin-"));
  const crash = join(bin, "crash");
  writeFileSync(crash, `#!/bin/sh\ncat >/dev/null\necho ran >> "${bin}/ran"\nexit 1\n`);
  chmodSync(crash, 0o755);
  const junk = join(bin, "junk");
  writeFileSync(junk, "#!/bin/sh\ncat >/dev/null\necho hello\n");
  chmodSync(junk, 0o755);
  const real = `${process.execPath} ${tsx} ${cli}`;
  const run = (hoopBin: string, input: object) =>
    spawnSync("sh", [gateScript], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...pages, HOOP_BIN: hoopBin } });
  const ran = () => (existsSync(join(bin, "ran")) ? readFileSync(join(bin, "ran"), "utf8").split("\n").length - 1 : 0);

  // No changes: nothing starts hoop.
  for (const input of [start("3"), hook("pre-tool-from-subagent"), {}]) {
    const r = run(crash, input);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
  }
  assert.equal(ran(), 0);

  for (const [id, subject] of [
    ["3", "Run the test suite"],
    ["4", "Open a pull request"],
  ])
    workHook(home, hook("post-taskcreate", { tool_input: { subject }, tool_response: { task: { id, subject } } }));
  workHook(home, hook("pre-agent"));
  workHook(home, hook("subagent-start"));
  addChanges(home, SESSION, [{ kind: "remove", todo: "3" }], { by: "ankur", reachable: false });

  // hoop decides through the script.
  const denied = run(real, start("3"));
  assert.equal(denied.status, 0);
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /ankur removed todo #3/);
  const allowed = run(real, start("4"));
  assert.deepEqual([allowed.status, allowed.stdout], [0, ""]);
  // Other tools of the session don't start hoop; a broken hoop lets a todo call go on.
  run(crash, hook("pre-tool-from-subagent", { agent_id: undefined }));
  assert.equal(ran(), 0);
  for (const broken of [crash, junk, join(bin, "missing")]) {
    const r = run(broken, start("3"));
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], broken);
  }

  // A stopped agent: refused by hoop, and refused when hoop is missing, crashes or gives no decision.
  addChanges(home, SESSION, [{ kind: "stop", agent: AGENT }], { by: "ankur", reachable: false });
  const stopped = run(real, hook("pre-tool-from-subagent"));
  assert.equal(JSON.parse(stopped.stdout).hookSpecificOutput.permissionDecision, "deny");
  for (const broken of [crash, junk, join(bin, "missing")]) {
    const r = run(broken, hook("pre-tool-from-subagent"));
    assert.equal(r.status, 2, broken);
    assert.match(r.stderr, /^Stopped by ankur in hoop's Work view \(.+\)\. Don't call any more tools/);
  }
  // Spaced JSON, and an agent_id the tool's input names before the caller's, still find it.
  const spaced = JSON.stringify({ tool_input: { agent_id: "someone-else" }, ...hook("pre-tool-from-subagent") }, null, 1);
  const r = spawnSync("sh", [gateScript], { input: spaced, encoding: "utf8", env: { ...process.env, ...pages, HOOP_BIN: crash } });
  assert.equal(r.status, 2);
  // Another session's agent with the same ID isn't this one.
  assert.equal(run(crash, hook("pre-tool-from-subagent", { session_id: "other-session" })).status, 0);

  const hooks = JSON.parse(readFileSync(new URL("../plugins/hoop/hooks/hooks.json", import.meta.url), "utf8")).hooks;
  const gate = hooks.PreToolUse.filter((h: { hooks: { command: string }[] }) => /gate-work\.sh/.test(h.hooks[0]!.command));
  assert.equal(gate.length, 1);
  assert.equal(gate[0].matcher, "*", "the gate sees every tool call, so a stopped agent can't use any");
  assert.equal(gate[0].hooks[0].async, undefined, "the gate runs before the call, not in the background");
  assert.ok(gate[0].hooks[0].timeout > 20, "Claude Code's timeout is longer than the script's alarm");
});

test("the changes API records a person's changes and refuses cross-site, non-JSON and unknown requests", async () => {
  const home = seeded();
  const sent: string[] = [];
  const server = createWebServer(new Hoop(new Store(home)), [], {
    sessions: () => [{ session: SESSION, pid: 1, status: "busy", socket: "/fake" }],
    send: async (_s, t) => void sent.push(t),
    steerMs: 50,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const url = `${base}/api/work/${SESSION}/changes`;
    const body = JSON.stringify({ changes: [{ kind: "remove", todo: "3" }] });
    const json = { "content-type": "application/json" };
    const refused = [
      await fetch(url, { method: "POST", headers: { ...json, origin: "https://evil.example" }, body }),
      await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body }),
    ].map((r) => r.status);
    // fetch can't set Host, so a rebinding request goes through http.
    refused.push(
      await new Promise<number>((resolve) => {
        const req = request(
          { host: "127.0.0.1", port, method: "POST", path: `/api/work/${SESSION}/changes`, headers: { ...json, host: `evil.example:${port}` } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", () => resolve(0)).end(body);
      }),
    );
    assert.deepEqual(refused, [403, 415, 403]);
    assert.equal(readWork(home, SESSION)!.changes, undefined, "a refused request changes nothing");

    const ok = await fetch(url, { method: "POST", headers: { ...json, origin: base }, body });
    assert.equal(ok.status, 201);
    const reply = await ok.json();
    assert.equal(reply.changes[0].kind, "remove");
    assert.equal(reply.changes[0].delivery, "pending");
    assert.equal(reply.session.id, SESSION);
    assert.equal(reply.session.reachable, true);
    for (let i = 0; i < 50 && !sent.length; i++) await sleep(20);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /Removed todo #3/);

    const bad = await fetch(url, { method: "POST", headers: json, body: JSON.stringify({ changes: [{ kind: "remove", todo: "3" }] }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /already removed/);
    const none = await fetch(`${base}/api/work/nobody/changes`, { method: "POST", headers: json, body });
    assert.equal(none.status, 404);
  } finally {
    server.close();
  }
});

test("the Work page comments on, edits, moves and removes queued todos, and stops agents, with inline confirmation", { skip: BROWSER_SKIP }, async () => {
  const home = seeded();
  await withBrowser(
    async ({ base, page }) => {
      const dialogs: string[] = [];
      page.on("dialog", (d) => void dialogs.push(d.message()));
      await page.addInitScript(() => ((window as unknown as { HOOP_WORK_MS: number }).HOOP_WORK_MS = 200));
      await page.goto(`${base}/work`);
      const session = page.locator("section.work-session");
      await session.waitFor();
      const todo = (id: string) => session.locator(`.todo[data-todo="${id}"]`);
      // A running todo takes only a comment; queued ones take every control, minus a move off the end.
      assert.deepEqual(await todo("5").locator("[data-act]").allInnerTexts(), ["Comment"]);
      assert.deepEqual(await todo("1").locator("[data-act]").allInnerTexts(), ["Comment", "Edit", "Move down", "Remove"]);
      assert.deepEqual(await todo("4").locator("[data-act]").allInnerTexts(), ["Comment", "Edit", "Move up", "Remove"]);

      // Comment, from the keyboard.
      await page.getByRole("button", { name: "Comment on todo #2, Write the migration" }).focus();
      await page.keyboard.press("Enter");
      await page.getByLabel("Comment on todo #2").fill("Mind the old rows");
      // A refresh while typing keeps the text: two polls answer, so the first one has painted.
      const poll = () => page.waitForResponse((r) => new URL(r.url()).pathname === "/api/work");
      await poll();
      await poll();
      assert.equal(await page.getByLabel("Comment on todo #2").inputValue(), "Mind the old rows");
      await page.keyboard.press("Enter");
      await todo("2").locator(".note", { hasText: "Mind the old rows" }).waitFor();
      assert.match(await todo("2").locator(".note").innerText(), /Waits for the gate/);
      assert.match(await session.locator(".gate-note").innerText(), /can't take messages now/);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Comment on todo #2, Write the migration");

      // Edit, with a refused edit shown in place, then Escape closes it.
      await todo("1").getByRole("button", { name: /^Edit/ }).click();
      const field = page.getByLabel("New text for todo #1");
      assert.equal(await field.inputValue(), "Read the code");
      await field.press("Enter");
      await page.locator(".steer-error", { hasText: "already says that" }).waitFor();
      await field.fill("Read the code and the docs");
      await field.press("Enter");
      await todo("1").locator(".note", { hasText: "edited it to “Read the code and the docs”" }).waitFor();
      // Edit the description too: Shift+Enter starts a new line, Enter sends.
      await todo("4").getByRole("button", { name: /^Edit/ }).click();
      const about = page.getByLabel("Description of todo #4");
      assert.equal(await about.inputValue(), "");
      await about.fill("Link it to the plan");
      await about.press("Shift+Enter");
      await about.pressSequentially("http://localhost:4747/r/rv_abc123");
      await about.press("Enter");
      await todo("4").locator(".note", { hasText: "edited its description to “Link it to the plan" }).waitFor();

      // Move #4 up: it shows before #3.
      await todo("4")
        .getByRole("button", { name: /^Move up/ })
        .click();
      await todo("4").locator(".note", { hasText: "moved #4 up, before #3" }).waitFor();
      assert.deepEqual(await session.locator("ol.todos > .todo").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.todo)), [
        "1",
        "2",
        "4",
        "3",
        "5",
      ]);

      // Remove asks first, in the page; Cancel keeps it.
      await todo("3")
        .getByRole("button", { name: /^Remove/ })
        .click();
      const confirm = todo("3").getByRole("group");
      assert.match(await confirm.innerText(), /Remove todo #3 from the agent's list\?/);
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Remove");
      await confirm.getByRole("button", { name: "Cancel" }).click();
      assert.equal(await todo("3").locator(".note").count(), 0);
      await todo("3")
        .getByRole("button", { name: /^Remove/ })
        .click();
      await todo("3").getByRole("group").getByRole("button", { name: "Remove" }).click();
      await todo("3").locator(".note", { hasText: "removed it" }).waitFor();
      assert.equal(await todo("3").locator("[data-act]").count(), 0, "a removed todo takes no more changes");

      // Stop an agent, after confirming.
      const agent = session.locator(".agent").first();
      await agent.getByRole("button", { name: "Stop agent Find API endpoints" }).click();
      assert.match(await agent.getByRole("group").innerText(), /Stop agent “Find API endpoints”\?/);
      await agent.getByRole("group").getByRole("button", { name: "Stop" }).click();
      await agent.locator(".note", { hasText: "stopped it" }).waitFor();
      assert.deepEqual(dialogs, [], "no browser dialogs");

      const r = readWork(home, SESSION)!;
      assert.deepEqual(
        r.changes!.map((c) => [c.kind, c.todo ?? c.agent, c.delivery]),
        [
          ["comment", "2", "waiting"],
          ["edit", "1", "waiting"],
          ["edit", "4", "waiting"],
          ["move", "4", "waiting"],
          ["remove", "3", "waiting"],
          ["stop", AGENT, "waiting"],
        ],
      );
      assert.equal(r.changes!.find((c) => c.kind === "edit" && c.todo === "4")!.description, "Link it to the plan\nhttp://localhost:4747/r/rv_abc123");
      // When the agent deletes the todo, the page says it saw the removal.
      workHook(home, hook("post-taskupdate-deleted", { tool_input: { taskId: "1", status: "deleted" } }));
      workHook(home, hook("post-taskupdate", { tool_input: { taskId: "2", status: "in_progress" } }));
      await todo("2").locator(".note", { hasText: "Seen by the agent" }).waitFor();
    },
    new Hoop(new Store(home)),
    { sessions: () => [{ session: SESSION, pid: 1, status: "busy", cwd: "/tmp/proj" }] },
  );
});

test("a move sets the person's order in the record; the agent's new todos join its end and deleted ones leave it", () => {
  const home = seeded();
  assert.equal(readWork(home, SESSION)!.queue, undefined, "the agent's order stands until a person moves a todo");
  const [move] = addChanges(home, SESSION, [{ kind: "move", todo: "4", before: "1" }], { by: "ankur", reachable: true, now: at(10) })!;
  assert.deepEqual(readWork(home, SESSION)!.queue, ["4", "1", "2", "3", "5"]);
  assert.deepEqual([move!.from, move!.to], [3, 0]);
  addChanges(home, SESSION, [{ kind: "move", todo: "1", after: "3" }], { by: "ankur", reachable: true, now: at(11) });
  assert.deepEqual(readWork(home, SESSION)!.queue, ["4", "2", "3", "1", "5"]);
  // The order outlasts the move: once the move settles, the record still has it.
  editWork(home, SESSION, (r) => void r.changes!.forEach((c) => (c.delivery = "seen")));
  assert.deepEqual(
    workView(home, () => [])[0]!.todos.map((t) => t.id),
    ["4", "2", "3", "1", "5"],
  );
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Write the docs" }, tool_response: { task: { id: "6", subject: "Write the docs" } } }));
  workHook(home, hook("post-taskupdate-deleted", { tool_input: { taskId: "2", status: "deleted" } }));
  assert.deepEqual(readWork(home, SESSION)!.queue, ["4", "3", "1", "5", "6"]);
  assert.deepEqual(
    workView(home, () => [])[0]!.todos.map((t) => t.id),
    ["4", "3", "1", "5", "6"],
  );
});

test("the session's message says a todo moved several steps in one line, where it ended up", () => {
  const home = seeded();
  const steps = addChanges(
    home,
    SESSION,
    [
      { kind: "move", todo: "4", before: "3" },
      { kind: "move", todo: "4", before: "2" },
      { kind: "move", todo: "4", before: "1" },
      { kind: "comment", todo: "1", text: "Quick one" },
      { kind: "move", todo: "3", after: "1" },
    ],
    { by: "ankur", reachable: true, now: at(10) },
  )!;
  assert.equal(
    steerMessage(steps),
    [
      "From ankur via hoop's Work view: changes to your own todo list and agents. They are instructions about your work, not approvals of anything.",
      "- Moved todo #4 before #1. Do #4 first.",
      '- Comment on todo #1 "Read the code": "Quick one"',
      "- Moved todo #3 after #1. Do #1 first.",
    ].join("\n"),
  );
});

test("the gate refuses starting a todo the person's order doesn't put first, once, and only once they set an order", () => {
  const home = seeded();
  // No order from the person: the agent's own order stands.
  assert.equal(workGate(home, start("3")), undefined);
  addChanges(home, SESSION, [{ kind: "move", todo: "3", before: "1" }], { by: "ankur", reachable: true });
  editWork(home, SESSION, (r) => void (r.changes![0]!.delivery = "sent"));
  assert.equal(readFileSync(join(home, "work", `${SESSION}.order`), "utf8"), "3\n");
  const why = "The person put #3 first in hoop's Work view; start #3, or ask them.";
  assert.equal(workGate(home, start("2"))!.deny, why);
  assert.equal(workGate(home, hook("pre-taskupdate", { tool_input: { taskId: "1", status: "in_progress" } }))!.deny, why);
  assert.equal(workGate(home, start("2")), undefined, "told once: after asking, the agent may go on");
  // In order, marking done, and the running todo all go on.
  assert.equal(workGate(home, start("3")), undefined);
  assert.equal(workGate(home, start("4", { status: "completed" })), undefined);
  assert.equal(workGate(home, start("5")), undefined);
  // A running todo doesn't count: once #3 runs, #1 is first.
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "3", status: "in_progress" } }));
  assert.equal(readFileSync(join(home, "work", `${SESSION}.order`), "utf8"), "1\n");
  assert.equal(workGate(home, start("1")), undefined);
  assert.equal(workGate(home, start("4"))!.deny, "The person put #1 first in hoop's Work view; start #1, or ask them.");
  // A todo the person removed isn't first.
  addChanges(home, SESSION, [{ kind: "remove", todo: "1" }], { by: "ankur", reachable: true });
  assert.equal(workGate(home, start("2")), undefined);

  // Bad files let the call go on.
  const bad = seeded();
  addChanges(bad, SESSION, [{ kind: "move", todo: "3", before: "1" }], { by: "ankur", reachable: true });
  const path = join(bad, "work", `${SESSION}.json`);
  const record = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...record, changes: [], queue: "3,1,2" }));
  assert.equal(workGate(bad, start("2")), undefined);
  writeFileSync(path, JSON.stringify({ ...record, changes: [], queue: [7, null, {}], queue_told: "x" }));
  assert.equal(workGate(bad, start("2")), undefined);
  writeFileSync(path, "{ not json");
  assert.equal(workGate(bad, start("2")), undefined);
});

test("the gate script starts hoop for an out-of-order start only while the person has set an order", async () => {
  const home = seeded();
  const pages = await pagesFor(home);
  const bin = mkdtempSync(join(tmpdir(), "hoop-gate-bin-"));
  const crash = join(bin, "crash");
  writeFileSync(crash, `#!/bin/sh\ncat >/dev/null\necho ran >> "${bin}/ran"\nexit 1\n`);
  chmodSync(crash, 0o755);
  const real = `${process.execPath} ${tsx} ${cli}`;
  const run = (hoopBin: string, input: object) =>
    spawnSync("sh", [gateScript], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...pages, HOOP_BIN: hoopBin } });
  const ran = () => (existsSync(join(bin, "ran")) ? readFileSync(join(bin, "ran"), "utf8").split("\n").length - 1 : 0);
  run(crash, start("3"));
  assert.equal(ran(), 0, "no order: hoop doesn't start");
  addChanges(home, SESSION, [{ kind: "move", todo: "3", before: "1" }], { by: "ankur", reachable: true });
  editWork(home, SESSION, (r) => void (r.changes![0]!.delivery = "sent"));
  run(crash, start("3"));
  run(crash, hook("pre-taskupdate", { tool_input: { taskId: "2", subject: "Write it" } }));
  assert.equal(ran(), 0, "starting the first todo, or a call that starts nothing, doesn't start hoop");
  const broken = run(crash, start("2"));
  assert.equal(ran(), 1);
  assert.deepEqual([broken.status, broken.stdout, broken.stderr], [0, "", ""], "a broken hoop lets the call go on");
  const denied = run(real, start("2"));
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, "The person put #3 first in hoop's Work view; start #3, or ask them.");
});

test("hoop_work_queue gives the session's queued todos in the person's order, with descriptions", async () => {
  const home = seeded();
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "2", description: "Add the column" } }));
  assert.match(INSTRUCTIONS, /take the next queued todo in the order the Work view shows it\. hoop_work_queue lists/);
  const queue = OPS.find((o) => o.name === "work_queue")!;
  const read = () => queue.run(new Hoop(new Store(home), SESSION), {}, { actor: "claude" });
  assert.deepEqual(await read(), {
    session: SESSION,
    person_order: false,
    todos: [
      { id: "1", text: "Read the code" },
      { id: "2", text: "Write the migration", description: "Add the column" },
      { id: "3", text: "Run the test suite" },
      { id: "4", text: "Open a pull request" },
    ],
  });
  addChanges(home, SESSION, [{ kind: "move", todo: "4", before: "1" }], { by: "ankur", reachable: true });
  addChanges(home, SESSION, [{ kind: "remove", todo: "3" }], { by: "ankur", reachable: true });
  const now = (await read()) as { person_order: boolean; todos: { id: string }[] };
  assert.equal(now.person_order, true);
  assert.deepEqual(
    now.todos.map((t) => t.id),
    ["4", "1", "2"],
  );
  assert.deepEqual(await queue.run(new Hoop(new Store(home), "no-work-session"), {}, { actor: "claude" }), {
    session: "no-work-session",
    person_order: false,
    todos: [],
  });
  assert.throws(() => queue.run(new Hoop(new Store(home), null), {}, { actor: "me" }), /isn't in a Claude Code session/);
  const out = spawnSync(process.execPath, [tsx, cli, "work-queue", "--json"], {
    encoding: "utf8",
    env: { ...process.env, HOOP_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(
    JSON.parse(out.stdout).todos.map((t: { id: string }) => t.id),
    ["4", "1", "2"],
  );
});

test("the Work page shows one note per move however many steps, and every step in a folded History", { skip: BROWSER_SKIP }, async () => {
  const home = seeded();
  addChanges(
    home,
    SESSION,
    [
      { kind: "move", todo: "4", before: "3" },
      { kind: "move", todo: "4", before: "2" },
      { kind: "move", todo: "4", before: "1" },
    ],
    { by: "ankur", reachable: false, now: new Date().toISOString() },
  );
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/work`);
      const session = page.locator("section.work-session");
      await session.waitFor();
      const notes = session.locator('.todo[data-todo="4"] .note');
      assert.deepEqual(await notes.allInnerTexts(), [await notes.first().innerText()]);
      assert.match(await notes.first().innerText(), /^ankur moved #4 up, before #1 \d/);
      assert.doesNotMatch(await notes.first().innerText(), /Waits for the gate/);
      assert.deepEqual(await session.locator("ol.todos > .todo").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.todo)), [
        "4",
        "1",
        "2",
        "3",
        "5",
      ]);
      const history = session.locator("details.history");
      assert.equal(await history.evaluate((d) => (d as HTMLDetailsElement).open), false);
      assert.equal(await history.locator(".note").first().isVisible(), false);
      await history.locator("summary").focus();
      await page.keyboard.press("Enter");
      const steps = await history.locator(".note").allInnerTexts();
      assert.equal(steps.length, 3);
      assert.match(steps[0]!, /^ankur moved #4 up, before #3 .*Waits for the gate$/);
      assert.match(steps[2]!, /^ankur moved #4 up, before #1 .*Waits for the gate$/);
    },
    new Hoop(new Store(home)),
    { sessions: () => [] },
  );
});
