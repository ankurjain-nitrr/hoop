import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { addChanges } from "../src/steer.js";
import { stopGate, stopOutput, turnStart } from "../src/stop.js";
import { Store } from "../src/store.js";
import { readWork, workHook } from "../src/work.js";
import { example, freePort, hoopArgs, pagesFor, TEST_SESSION, tempHome } from "./helpers.js";

const STOPS = JSON.parse(readFileSync(new URL("./fixtures/stop-hooks.json", import.meta.url), "utf8"));
const WORK = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const script = new URL("../plugins/hoop/scripts/stop-gate.sh", import.meta.url).pathname;
const PROMPT = "66666666-7777-8888-9999-000000000000";
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

/** The session's transcript in the test's Claude Code folder: a prompt `start` seconds ago, then a tool call if `tool`, then a reply. */
function transcript(start = 60, tool = false, folder = "-tmp-stop") {
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "projects", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${TEST_SESSION}.jsonl`);
  const lines = [
    { type: "user", promptId: "old-prompt", timestamp: ago(start + 600), message: { role: "user", content: "Start the work" } },
    {
      type: "assistant",
      timestamp: ago(start + 590),
      message: { content: [{ type: "tool_use", id: "t0", name: "Read", input: { file_path: "/tmp/stop/a" } }] },
    },
    { type: "user", promptId: "old-prompt", timestamp: ago(start + 589), message: { content: [{ type: "tool_result", tool_use_id: "t0", content: "ok" }] } },
    { type: "user", promptId: PROMPT, timestamp: ago(start), message: { role: "user", content: "What time is it?" } },
    ...(tool
      ? [
          { type: "assistant", timestamp: ago(start - 5), message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "date" } }] } },
          { type: "user", promptId: PROMPT, timestamp: ago(start - 6), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "noon" }] } },
        ]
      : []),
    { type: "assistant", timestamp: ago(1), message: { content: [{ type: "text", text: "Noon." }] } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

const stop = (path: string, name = "stop") => ({ ...structuredClone(STOPS[name]), transcript_path: path });
const work = (name: string, path: string, extra: Record<string, unknown>) => ({
  ...structuredClone(WORK[name]),
  session_id: TEST_SESSION,
  transcript_path: path,
  ...extra,
});

/** A record whose todo #1 started 20 minutes ago and is still in progress. */
function running(home: string, path: string) {
  workHook(
    home,
    work("post-taskcreate", path, { tool_input: { subject: "Write the migration" }, tool_response: { task: { id: "1", subject: "Write the migration" } } }),
    ago(1300),
  );
  workHook(home, work("post-taskupdate", path, { tool_input: { taskId: "1", status: "in_progress" } }), ago(1200));
}

test("the turn starts at the first entry of its prompt, or at the latest plain prompt without prompt IDs", () => {
  const lines = readFileSync(transcript(60, true), "utf8").split("\n");
  assert.equal(turnStart(lines, PROMPT), JSON.parse(lines[3]!).timestamp);
  assert.equal(turnStart(lines), JSON.parse(lines[3]!).timestamp, "without the hook's prompt ID, the latest one");
  const plain = [
    { type: "user", timestamp: "2026-10-26T10:00:00.000Z", message: { content: "Fix the bug" } },
    { type: "user", timestamp: "2026-10-26T10:01:00.000Z", message: { content: [{ type: "tool_result", tool_use_id: "x" }] } },
    { type: "user", isMeta: true, timestamp: "2026-10-26T10:02:00.000Z", message: { content: "<local-command-caveat>" } },
  ].map((l) => JSON.stringify(l));
  assert.equal(turnStart(plain), "2026-10-26T10:00:00.000Z");
  assert.equal(turnStart(["{ not json", ""]), undefined);
});

test("a todo left in progress by a turn with no tool calls blocks once, naming it", () => {
  const home = tempHome();
  const store = new Store(home);
  const path = transcript();
  running(home, path);
  assert.ok(existsSync(join(home, "work", `${TEST_SESSION}.stop`)), "the script's marker says the gate has something to check");
  const first = stopGate(store, stop(path));
  assert.match(
    first!.block,
    /^Before you end your turn \(hoop says this once\): Todo #1 "Write the migration" is still in progress, but this turn did no work on it/,
  );
  assert.match(first!.block, /mark it completed or pending/);
  assert.deepEqual(stopOutput(first), { decision: "block", reason: first!.block });
  assert.ok(!first!.block.includes("\n"), "one line");
  assert.deepEqual(readWork(home, TEST_SESSION)!.stop_told, [`todo:1@${readWork(home, TEST_SESSION)!.todos[0]!.since}`]);
  assert.equal(stopGate(store, stop(path)), undefined, "told once: the next stop goes through");
  assert.deepEqual(stopOutput(undefined), {});

  // Started again later, it is a new cause.
  workHook(home, work("post-taskupdate", path, { tool_input: { taskId: "1", status: "pending" } }), ago(30));
  workHook(home, work("post-taskupdate", path, { tool_input: { taskId: "1", status: "in_progress" } }), ago(20));
  assert.equal(stopGate(store, stop(path, "stop-active")), undefined, "a stop the hook already blocked never blocks");
  assert.match(stopGate(store, stop(path))!.block, /Todo #1/);
});

test("a todo the turn worked on, a running subagent and a subagent's stop never block", () => {
  const home = tempHome();
  const store = new Store(home);
  const busy = transcript(60, true);
  running(home, busy);
  assert.equal(stopGate(store, stop(busy)), undefined, "the turn ran a tool call");
  const idle = transcript();
  assert.equal(stopGate(store, stop(idle, "subagent-stop")), undefined);
  workHook(home, work("pre-agent", idle, {}), ago(50));
  workHook(home, work("subagent-start", idle, {}), ago(49));
  assert.equal(stopGate(store, stop(idle)), undefined, "a running subagent may be working on it");
  assert.equal(readWork(home, TEST_SESSION)!.stop_told, undefined);
});

test("feedback that came during the turn unread blocks once; feedback read, or from before the turn, doesn't", async () => {
  const home = tempHome();
  const store = new Store(home);
  const path = transcript(60);
  const hoop = new Hoop(store);
  const { review_id } = hoop.submit(example());
  assert.ok(store.dirOf(review_id).includes(`${TEST_SESSION}/.hoop`), "the review sits in the session's folder");
  hoop.review(review_id, { verdict: "changes_requested", reviewer: "ana", comments: [], summary: "Split it." });
  const first = stopGate(store, stop(path));
  assert.match(first!.block, new RegExp(`ana reviewed ".+" in hoop, and you haven't read it: read it with hoop_feedback ${review_id}\\.`));
  assert.equal(readWork(home, TEST_SESSION)?.todos.length, 0, "a session with no todos keeps what it was told");
  assert.equal(stopGate(store, stop(path)), undefined, "told once");

  // A second review, read before the turn ends, doesn't block.
  hoop.review(review_id, { verdict: "changes_requested", reviewer: "bo", comments: [], summary: "And this." });
  hoop.receive(review_id);
  assert.equal(stopGate(store, stop(path)), undefined);

  // Feedback from before the turn started is old news.
  hoop.review(review_id, { verdict: "changes_requested", reviewer: "cy", comments: [], summary: "Old." });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stopGate(store, stop(transcript(0))), undefined);
});

test("a quick question's answer and a Work change that came during the turn unread each block once", () => {
  const home = tempHome();
  const store = new Store(home);
  const path = transcript(60, true);
  const hoop = new Hoop(store);
  const { review_id } = hoop.ask({
    questions: [{ question: "Keep the old endpoint?", options: [{ label: "Keep it", recommended: true }, { label: "Remove it" }] }],
  });
  hoop.answer(review_id, { question: "Q1", choice: "B" });
  assert.match(
    stopGate(store, stop(path))!.block,
    new RegExp(`"Keep the old endpoint\\?" got an answer in hoop, and you haven't read it: read it with hoop_feedback ${review_id}\\.`),
  );
  assert.equal(stopGate(store, stop(path)), undefined);
  running(home, path);
  addChanges(home, TEST_SESSION, [{ kind: "comment", todo: "1", text: "Keep it small" }], { by: "ankur", reachable: false, now: ago(30) });
  const first = stopGate(store, stop(path));
  assert.match(first!.block, /ankur changed your work in hoop's Work view, and you haven't read it: Comment on todo #1 "Write the migration": "Keep it small"/);
  assert.doesNotMatch(first!.block, /still in progress/, "the turn worked");
  assert.equal(stopGate(store, stop(path)), undefined);
  // A change from before the turn isn't this turn's.
  addChanges(home, TEST_SESSION, [{ kind: "comment", todo: "1", text: "Old" }], { by: "ankur", reachable: false, now: ago(120) });
  assert.equal(stopGate(store, stop(path)), undefined);
});

test("the script starts hoop only with something to check, fails open, and prints hoop's block", async () => {
  const home = tempHome();
  const bin = mkdtempSync(join(tmpdir(), "hoop-stop-bin-"));
  const crash = join(bin, "crash");
  writeFileSync(crash, `#!/bin/sh\ncat >/dev/null\necho ran >> "${bin}/ran"\nexit 1\n`);
  chmodSync(crash, 0o755);
  const slow = join(bin, "slow");
  writeFileSync(slow, `#!/bin/sh\ncat >/dev/null\nexec sleep 5\n`);
  chmodSync(slow, 0o755);
  const ran = () => (existsSync(join(bin, "ran")) ? readFileSync(join(bin, "ran"), "utf8").split("\n").length - 1 : 0);
  const real = [process.execPath, ...hoopArgs].join(" ");
  const run = (hoopBin: string, input: object | string, env: Record<string, string> = {}) =>
    spawnSync("sh", [script], {
      input: typeof input === "string" ? input : JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, HOOP_HOME: home, HOOP_BIN: hoopBin, ...env },
    });
  assert.equal(spawnSync("sh", ["-n", script]).status, 0, "POSIX sh");

  // A folder of its own: the other tests' reviews sit beside their transcript.
  const path = transcript(60, false, "-tmp-stop-script");
  for (const input of [stop(path), stop(path, "stop-active"), stop(path, "subagent-stop"), {}, "not json"]) {
    const r = run(crash, input);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
  }
  assert.equal(ran(), 0, "nothing to check: hoop doesn't start");

  // A review of the session's with feedback newer than its receipts starts hoop; one read doesn't.
  const review = join(path.slice(0, -".jsonl".length), ".hoop", "reviews", "rv_stopscript");
  mkdirSync(review, { recursive: true });
  writeFileSync(join(review, "feedback-1.json"), "[]");
  run(crash, stop(path));
  assert.equal(ran(), 1, "feedback with no receipts");
  writeFileSync(join(review, "receipts.json"), "{}");
  utimesSync(join(review, "feedback-1.json"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  run(crash, stop(path));
  assert.equal(ran(), 1, "feedback received");
  utimesSync(join(review, "feedback-1.json"), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  run(crash, stop(path));
  assert.equal(ran(), 2, "feedback newer than its receipts");
  rmSync(review, { recursive: true });

  running(home, path);
  assert.deepEqual([run(crash, stop(path)).status, run(crash, stop(path)).stdout], [0, ""], "a broken hoop lets the turn end");
  assert.equal(ran(), 4);
  for (const input of [stop(path, "stop-active"), stop(path, "subagent-stop")]) run(crash, input);
  assert.equal(ran(), 4, "stop_hook_active and a subagent's stop never start hoop");
  const t0 = Date.now();
  const late = run(slow, stop(path), { HOOP_STOP_ALARM: "1" });
  assert.deepEqual([late.status, late.stdout], [0, ""], "a slow hoop lets the turn end");
  assert.ok(Date.now() - t0 < 4000);
  const down = run(real, stop(path), { HOOP_PORT: String(await freePort()) });
  assert.deepEqual([down.status, down.stdout], [0, ""], "no pages process: the turn ends, and none starts");

  const pages = await pagesFor(home);
  const blocked = run(real, stop(path), pages);
  assert.equal(blocked.status, 0);
  assert.match(JSON.parse(blocked.stdout).reason, /Todo #1 "Write the migration" is still in progress/);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  assert.deepEqual([run(real, stop(path), pages).stdout], [""], "once");

  const hooks = JSON.parse(readFileSync(new URL("../plugins/hoop/hooks/hooks.json", import.meta.url), "utf8")).hooks;
  const gate = hooks.Stop.filter((h: { hooks: { command: string }[] }) => /stop-gate\.sh/.test(h.hooks[0]!.command));
  assert.equal(gate.length, 1);
  assert.equal(gate[0].hooks[0].async, undefined, "the gate runs before the turn ends, not in the background");
  assert.ok(gate[0].hooks[0].timeout > 4, "Claude Code's timeout is longer than the script's alarm");
  assert.equal(
    hooks.SubagentStop.some((h: { hooks: { command: string }[] }) => /stop-gate/.test(h.hooks[0]!.command)),
    false,
  );
});
