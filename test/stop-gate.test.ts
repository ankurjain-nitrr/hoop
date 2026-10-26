import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { addChanges } from "../src/steer.js";
import { readTurn, stopGate, stopOutput } from "../src/stop.js";
import { Store } from "../src/store.js";
import { readWork, workHook } from "../src/work.js";
import { example, freePort, hoopArgs, pagesFor, TEST_SESSION, tempHome } from "./helpers.js";

const STOPS = JSON.parse(readFileSync(new URL("./fixtures/stop-hooks.json", import.meta.url), "utf8"));
const WORK = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const script = new URL("../plugins/hoop/scripts/stop-gate.sh", import.meta.url).pathname;
const PROMPT = "66666666-7777-8888-9999-000000000000";
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

// Transcript entries in the shapes Claude Code writes them: each turn opens with a user entry whose
// `origin` says who sent it, and its last assistant entry has `stop_reason` "end_turn".
const human = (s: number, text: string, promptId = PROMPT) => ({
  type: "user",
  promptId,
  origin: { kind: "human" },
  timestamp: ago(s),
  message: { role: "user", content: text },
});
const peer = (s: number, text: string) => ({
  type: "user",
  promptId: "peer-prompt",
  isMeta: true,
  origin: { kind: "peer", from: "unknown" },
  timestamp: ago(s),
  message: { role: "user", content: `Another Claude session sent a message:\n${text}` },
});
const notification = (s: number, call: string, status = "completed") => ({
  type: "user",
  promptId: "notice-prompt",
  isMeta: true,
  origin: { kind: "task-notification", producer: "session-task" },
  timestamp: ago(s),
  message: {
    role: "user",
    content: `<task-notification>\n<task-id>b0x</task-id>\n<tool-use-id>${call}</tool-use-id>\n<status>${status}</status>\n<summary>Background command finished</summary>\n</task-notification>`,
  },
});
const call = (s: number, id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  timestamp: ago(s),
  message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] },
});
const result = (s: number, id: string, promptId = PROMPT) => ({
  type: "user",
  promptId,
  timestamp: ago(s),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});
const reply = (s: number, text: string) => ({
  type: "assistant",
  timestamp: ago(s),
  message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] },
});
const turnEnd = (s: number) => ({ type: "system", subtype: "turn_duration", timestamp: ago(s) });

/** The session's transcript in the test's Claude Code folder: a finished earlier turn with tool work, then `turn`. */
function write(turn: object[], folder = "-tmp-stop", before: object[] = []) {
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "projects", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${TEST_SESSION}.jsonl`);
  const lines = [
    ...before,
    human(1200, "Start the migration", "old-prompt"),
    call(1190, "t0", "Read", { file_path: "/tmp/stop/a" }),
    result(1189, "t0", "old-prompt"),
    reply(1180, "Started it."),
    turnEnd(1180),
    ...turn,
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

/** A person's prompt `start` seconds ago, then a tool call if `tool`, then a reply. */
const transcript = (start = 60, tool = false, folder = "-tmp-stop") =>
  write(
    [human(start, "What time is it?"), ...(tool ? [call(start - 5, "t1", "Bash", { command: "date" }), result(start - 6, "t1")] : []), reply(1, "Noon.")],
    folder,
  );

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

/** A person's comment on todo #1 from the Work view, `at` seconds ago, that never reached the session (no messaging socket). */
const comment = (home: string, text: string, at: number) =>
  addChanges(home, TEST_SESSION, [{ kind: "comment", todo: "1", text }], { by: "ankur", reachable: false, now: ago(at) });

test("the turn opens at the first message after the previous turn's end", () => {
  const lines = (turn: object[]) => readFileSync(write(turn), "utf8").split("\n");
  const chat = lines([human(60, "What time is it?"), reply(1, "Noon.")]);
  assert.deepEqual(readTurn(chat, true), { start: JSON.parse(chat[5]!).timestamp, last: JSON.parse(chat[6]!).timestamp });
  // A local command's notes come before the prompt; the prompt opens the turn.
  const local = lines([
    { type: "user", isMeta: true, timestamp: ago(70), message: { content: "<local-command-caveat>Caveat</local-command-caveat>" } },
    { type: "user", timestamp: ago(70), message: { content: "<command-name>/model</command-name>" } },
    human(60, "Go on"),
    reply(1, "On it."),
  ]);
  assert.equal(readTurn(local, true)!.start, JSON.parse(local[7]!).timestamp);
  // A message taken mid-turn after a tool call opens nothing.
  const mid = lines([
    human(100, "Do it"),
    call(90, "t1", "Bash", { command: "make" }),
    result(50, "t1", "P2"),
    human(50, "stop there", "P2"),
    reply(2, "Stopped."),
  ]);
  assert.equal(readTurn(mid, true)!.start, JSON.parse(mid[5]!).timestamp);
  // A peer's message or a notification opens a turn too.
  const told = lines([peer(40, "hi"), reply(2, "Thanks.")]);
  assert.equal(readTurn(told, true)!.start, JSON.parse(told[5]!).timestamp);
  const notice = lines([notification(40, "toolu_ci"), reply(2, "CI passed.")]);
  assert.equal(readTurn(notice, true)!.start, JSON.parse(notice[5]!).timestamp);
  // Without the previous turn's end or the file's start, the lines don't say where the turn opened.
  assert.equal(readTurn(lines([human(60, "Hi"), reply(1, "Hello.")]).slice(5), false), undefined);
  assert.equal(readTurn(["{ not json", ""], true), undefined);
});

test("a todo in progress alone never blocks, and writes no marker for the script", () => {
  const home = tempHome();
  const store = new Store(home);
  const path = transcript();
  running(home, path);
  assert.equal(existsSync(join(home, "work", `${TEST_SESSION}.stop`)), false);
  assert.equal(stopGate(store, stop(path)), undefined, "a person's side question while the todo waits");
  assert.equal(readWork(home, TEST_SESSION)!.stop_told, undefined);
});

test("a reply to a waiting Work comment marks it seen, and the stop gate no longer counts it", () => {
  const home = tempHome();
  const store = new Store(home);
  const path = transcript();
  running(home, path);
  comment(home, "Keep it small", 30);
  const c = readWork(home, TEST_SESSION)!.changes![0]!;
  assert.equal(c.delivery, "waiting");
  new Hoop(store, { session: TEST_SESSION, claude: true }).reply(c.id, "Kept it small");
  assert.equal(readWork(home, TEST_SESSION)!.changes![0]!.delivery, "seen");
  assert.equal(existsSync(join(home, "work", `${TEST_SESSION}.stop`)), false, "nothing left for the script to check");
  assert.equal(stopGate(store, stop(path)), undefined);
});

test("a Work change the session hasn't read blocks once in one line; a subagent's stop and stop_hook_active never block", () => {
  const home = tempHome();
  const store = new Store(home);
  const path = transcript();
  running(home, path);
  comment(home, "Keep it small", 30);
  const marker = join(home, "work", `${TEST_SESSION}.stop`);
  assert.ok(existsSync(marker), "the script's marker: a change the gate hasn't told");
  assert.equal(stopGate(store, stop(path, "subagent-stop")), undefined);
  assert.equal(stopGate(store, stop(path, "stop-active")), undefined);
  const first = stopGate(store, stop(path));
  assert.equal(
    first!.block,
    `Before you end your turn (hoop says this once): ankur changed your work in hoop's Work view, and you haven't read it: Comment ${readWork(home, TEST_SESSION)!.changes![0]!.id} on todo #1 "Write the migration": "Keep it small". Answer it with hoop_reply on ${readWork(home, TEST_SESSION)!.changes![0]!.id}, as well as in chat.`,
  );
  assert.deepEqual(stopOutput(first), { decision: "block", reason: first!.block });
  assert.deepEqual(readWork(home, TEST_SESSION)!.stop_told, [`change:${readWork(home, TEST_SESSION)!.changes![0]!.id}`]);
  assert.equal(existsSync(marker), false, "told: the marker goes");
  assert.equal(stopGate(store, stop(path)), undefined, "told once: the next stop goes through");
  assert.deepEqual(stopOutput(undefined), {});
});

test("a message taken mid-turn doesn't move the turn's start, and a turn longer than the transcript's tail lets the turn end", () => {
  const home = tempHome();
  const store = new Store(home);
  const mid = write([
    human(100, "Do the migration"),
    call(90, "t1", "Bash", { command: "make" }),
    result(50, "t1", "P2"),
    human(50, "stop there and wait for me", "P2"),
    reply(2, "Stopped."),
  ]);
  running(home, mid);
  // The change came after the turn's prompt, before the message taken mid-turn: it is this turn's.
  comment(home, "Before the pause", 70);
  assert.match(stopGate(store, stop(mid))?.block ?? "", /"Before the pause"/);
  // One Write call larger than the tail: the lines hold its result but not the prompt.
  const big = write([
    human(100, "Write the fixture"),
    call(90, "t2", "Write", { file_path: "/tmp/x.json", content: "x".repeat(300_000) }),
    result(85, "t2"),
    reply(2, "Written."),
  ]);
  comment(home, "During the write", 60);
  assert.equal(stopGate(store, stop(big)), undefined);
  assert.equal(readTurn(readFileSync(big, "utf8").trimEnd().split("\n").slice(-2), false), undefined, "the opener isn't in the lines");
});

test("the previous Stop's time starts the turn when it comes after the opener the lines show, but not this turn's own", () => {
  // Assistant entries without stop_reason, as older transcripts write them: the lines read one long turn.
  const said = (t: number, text: string) => ({ type: "assistant", timestamp: ago(t), message: { role: "assistant", content: [{ type: "text", text }] } });
  const lines = [human(600, "Plan it"), said(590, "Planned."), human(300, "And now?"), said(2, "Done.")];
  for (const [stopAt, told] of [
    [400, ["Second"]],
    [0, ["First", "Second"]],
  ] as const) {
    const home = tempHome();
    const path = write(lines);
    running(home, path);
    workHook(home, stop(path), ago(stopAt));
    comment(home, "First", 450);
    comment(home, "Second", 350);
    const block = stopGate(new Store(home), stop(path))!.block;
    assert.deepEqual(
      ["First", "Second"].filter((t) => block.includes(`"${t}"`)),
      told,
      stopAt ? "the previous turn's Stop starts this turn" : "this turn's own Stop, after its last words, is ignored",
    );
  }
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

test("regression: a review the person closed doesn't block the stop over its unread feedback", () => {
  const store = new Store(tempHome());
  const path = transcript(60);
  const hoop = new Hoop(store);
  const { review_id } = hoop.submit(example());
  hoop.review(review_id, { verdict: "changes_requested", reviewer: "ana", comments: [], summary: "Split it." });
  hoop.close(review_id, "Not needed");
  assert.equal(stopGate(store, stop(path)), undefined);
});

test("a quick question's answer that came during the turn unread blocks once; a change from before the turn doesn't", () => {
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
  comment(home, "Old", 120);
  assert.equal(stopGate(store, stop(path)), undefined);
});

test("the script starts hoop only with something to check, fails open, and prints hoop's block", async () => {
  const home = tempHome();
  const bin = mkdtempSync(join(tmpdir(), "hoop-stop-bin-"));
  const crash = join(bin, "crash");
  writeFileSync(crash, `#!/bin/sh\ncat >/dev/null\necho ran >> "${bin}/ran"\nexit 1\n`);
  chmodSync(crash, 0o755);
  const slow = join(bin, "slow");
  // Like npx: a process that starts another, which keeps its output open, and neither answers.
  writeFileSync(slow, `#!/bin/sh\ncat >/dev/null\nsleep 30 &\nsleep 30\n`);
  chmodSync(slow, 0o755);
  const ran = () => (existsSync(join(bin, "ran")) ? readFileSync(join(bin, "ran"), "utf8").split("\n").length - 1 : 0);
  const real = [process.execPath, ...hoopArgs].join(" ");
  const run = (hoopBin: string, input: object | string, env: Record<string, string> = {}) =>
    spawnSync("/bin/sh", [script], {
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
  run(crash, stop(path));
  assert.equal(ran(), 2, "a running todo alone doesn't start hoop");
  comment(home, "Keep it small", 30);
  assert.deepEqual([run(crash, stop(path)).status, run(crash, stop(path)).stdout], [0, ""], "a broken hoop lets the turn end");
  assert.equal(ran(), 4);
  for (const input of [stop(path, "stop-active"), stop(path, "subagent-stop")]) run(crash, input);
  assert.equal(ran(), 4, "stop_hook_active and a subagent's stop never start hoop");
  // A PATH with the script's tools and no perl, as on Alpine.
  const tools = mkdtempSync(join(tmpdir(), "hoop-stop-tools-"));
  for (const t of ["cat", "dirname", "find", "grep", "head", "mktemp", "rm", "sed", "sleep"]) {
    const from = ["/usr/bin", "/bin"].map((d) => join(d, t)).find((f) => existsSync(f));
    if (from) symlinkSync(from, join(tools, t));
  }
  const t0 = Date.now();
  const late = run(slow, stop(path), { HOOP_STOP_WAIT: "1", PATH: tools });
  assert.deepEqual([late.status, late.stdout], [0, ""], "a slow hoop lets the turn end");
  assert.ok(Date.now() - t0 < 4000, "the wait bounds hoop and what it started, without perl");
  const down = run(real, stop(path), { HOOP_PORT: String(await freePort()) });
  assert.deepEqual([down.status, down.stdout], [0, ""], "no pages process: the turn ends, and none starts");

  const pages = await pagesFor(home);
  const blocked = run(real, stop(path), pages);
  assert.equal(blocked.status, 0);
  assert.match(JSON.parse(blocked.stdout).reason, /ankur changed your work in hoop's Work view, and you haven't read it: Comment ch_\w+ on todo #1/);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  assert.deepEqual([run(real, stop(path), pages).stdout], [""], "once");

  const hooks = JSON.parse(readFileSync(new URL("../plugins/hoop/hooks/hooks.json", import.meta.url), "utf8")).hooks;
  const gate = hooks.Stop.filter((h: { hooks: { command: string }[] }) => /stop-gate\.sh/.test(h.hooks[0]!.command));
  assert.equal(gate.length, 1);
  assert.equal(gate[0].hooks[0].async, undefined, "the gate runs before the turn ends, not in the background");
  assert.ok(gate[0].hooks[0].timeout > 4, "Claude Code's timeout is longer than the script's wait");
  assert.equal(
    hooks.SubagentStop.some((h: { hooks: { command: string }[] }) => /stop-gate/.test(h.hooks[0]!.command)),
    false,
  );
});
