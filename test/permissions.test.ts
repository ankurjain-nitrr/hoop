import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { permissionHook } from "../src/permission-hook.js";
import {
  answerPermission,
  askPermission,
  decisionOutput,
  hasResult,
  isOn,
  listPermissions,
  openCall,
  readPermission,
  settlePermission,
} from "../src/permissions.js";
import { permissionStep, PERMISSION_QUESTION } from "../src/init.js";
import { fakeBin, hoopArgs, hoopCli, pagesFor, postJson, sleep, tempHome, withServer } from "./helpers.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";

// Claude Code's permission prompts answered from hoop's pages too (rv_mw7wkyez20853f): on only with
// permission_prompts in hoop's on list, the first answer wins, and hoop never answers by itself.

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/hook-inputs/permission.json", import.meta.url), "utf8"));
/** A recorded PermissionRequest input, with its session's transcript at `transcript`. */
const request = (transcript?: string) => ({ ...FIXTURE["permission-request"], ...(transcript ? { transcript_path: transcript } : {}) });
const turnOn = (home: string) => writeFileSync(join(home, "on"), "permission_prompts\n");
const scripts = new URL("../plugins/hoop/scripts/", import.meta.url).pathname;

/** A stand-in for the pages process's writes, run on `home` as the pages process runs them. */
function writer(home: string, fail = false) {
  const calls: string[] = [];
  return {
    calls,
    post: async (action: string, body: Record<string, unknown>) => {
      calls.push(action);
      if (fail) throw new Error("no pages process");
      if (action === "permission_ask") return askPermission(home, body.input);
      if (action === "permission_settle") return settlePermission(home, String(body.id), body.how);
      throw new Error(action);
    },
  };
}

/** A transcript holding the call a prompt is for, and the line that gives its result. */
function transcriptWith(dir: string, earlier = false) {
  const path = join(dir, "session.jsonl");
  const use = (id: string) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "rm -rf build", description: "Remove the build folder" } }] },
  });
  const result = (id: string) => `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "" }] } })}\n`;
  // The same command, run and answered earlier, is never the call the prompt is for.
  const lines = earlier ? `${JSON.stringify(use("toolu_old"))}\n${result("toolu_old")}` : "";
  writeFileSync(path, `${lines}${JSON.stringify(use("toolu_now"))}\n`);
  return { path, answer: () => appendFileSync(path, result("toolu_now")) };
}

test("hoop's on list names a part only on a line of its own", () => {
  const home = tempHome();
  assert.equal(isOn(home, "permission_prompts"), false, "off until named");
  for (const [text, want] of [
    ["permission_prompts\n", true],
    ["\tpermission_prompts \r\n", true],
    ["# permission_prompts\n", false],
    ["permission_prompts_off\n", false],
  ] as const) {
    writeFileSync(join(home, "on"), text);
    assert.equal(isOn(home, "permission_prompts"), want, JSON.stringify(text));
  }
});

test("a prompt keeps its full input while it waits, and the first answer wins and drops it", () => {
  const home = tempHome();
  assert.throws(() => askPermission(home, request()), /permission prompts aren't on: add a line permission_prompts to/);
  turnOn(home);
  assert.throws(() => askPermission(home, { ...request(), hook_event_name: "PreToolUse" }), /expected a PermissionRequest hook input/);
  const { id } = askPermission(home, request());
  const waiting = readPermission(home, id)!;
  assert.deepEqual([waiting.state, waiting.tool, waiting.input], ["waiting", "Bash", { command: "rm -rf build", description: "Remove the build folder" }]);
  assert.equal(decisionOutput(waiting), undefined, "nothing decided while it waits");

  const allowed = answerPermission(home, id, { decision: "allow" }, "ana");
  assert.deepEqual([allowed.state, allowed.by, allowed.input], ["allowed", "ana", undefined], "the full input goes once answered");
  assert.deepEqual(decisionOutput(allowed), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  assert.throws(() => answerPermission(home, id, { decision: "deny" }, "ana"), /already answered: it was allowed in hoop/);
  assert.equal(settlePermission(home, id, "terminal")!.state, "allowed", "a later terminal answer doesn't undo the first");
  assert.throws(() => answerPermission(home, askPermission(home, request()).id, { decision: "always" }, "ana"), /expected \{ decision: "allow" \}/);

  const denied = answerPermission(home, askPermission(home, request()).id, { decision: "deny", reason: "  Not the build folder  " }, "ana");
  assert.deepEqual(decisionOutput(denied), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "The person denied this in hoop: Not the build folder" } },
  });
  const plain = answerPermission(home, askPermission(home, request()).id, { decision: "deny" }, "ana");
  assert.equal(
    (decisionOutput(plain) as { hookSpecificOutput: { decision: { message: string } } }).hookSpecificOutput.decision.message,
    "The person denied this in hoop.",
  );

  const inTerminal = settlePermission(home, askPermission(home, request()).id, "terminal")!;
  assert.deepEqual([inTerminal.state, inTerminal.input], ["terminal", undefined]);
  assert.throws(() => answerPermission(home, inTerminal.id, { decision: "allow" }, "ana"), /already answered: it was answered in the terminal/);
  // No decision ever carries rules for later calls.
  for (const p of listPermissions(home)) assert.doesNotMatch(JSON.stringify(decisionOutput(p) ?? {}), /updatedPermissions|addRules|setMode/);
});

test("a prompt's records go a day after they settle", () => {
  const home = tempHome();
  turnOn(home);
  const old = askPermission(home, request(), new Date("2026-11-01T10:00:00Z")).id;
  settlePermission(home, old, "handed", new Date("2026-11-01T10:05:00Z"));
  const open = askPermission(home, request(), new Date("2026-11-01T10:06:00Z")).id;
  askPermission(home, request(), new Date("2026-11-03T10:00:00Z"));
  assert.equal(readPermission(home, old), undefined, "settled two days ago");
  assert.ok(readPermission(home, open), "a waiting prompt stays");
});

test("the prompt's call is found in the transcript, not an earlier call of the same command, and its result means the terminal answered", () => {
  const t = transcriptWith(tempHome(), true);
  const input = { command: "rm -rf build", description: "Remove the build folder" };
  assert.equal(openCall(t.path, "Bash", input), "toolu_now");
  assert.equal(openCall(t.path, "Bash", { command: "ls" }), undefined);
  assert.equal(openCall(t.path, "Edit", input), undefined);
  assert.equal(hasResult(t.path, "toolu_now"), false);
  t.answer();
  assert.equal(hasResult(t.path, "toolu_now"), true);
  assert.equal(openCall("/no/such/transcript.jsonl", "Bash", input), undefined);
});

test("the hook waits for the first answer: a page's becomes its decision, the terminal's ends it with none, and it hands over at its time", async () => {
  const off = tempHome();
  const w0 = writer(off);
  assert.equal(await permissionHook(request(), { home: off, remote: w0, waitMs: 1000, pollMs: 20 }), undefined);
  assert.deepEqual(w0.calls, [], "off: nothing is recorded");

  const home = tempHome();
  turnOn(home);
  const answerSoon = (decision: Record<string, unknown>) =>
    setTimeout(() => {
      const p = listPermissions(home).find((x) => x.state === "waiting")!;
      answerPermission(home, p.id, decision, "ana");
    }, 100);
  answerSoon({ decision: "allow" });
  assert.deepEqual(await permissionHook(request(), { home, remote: writer(home), waitMs: 5000, pollMs: 20 }), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  });
  answerSoon({ decision: "deny", reason: "No" });
  const denied = (await permissionHook(request(), { home, remote: writer(home), waitMs: 5000, pollMs: 20 })) as {
    hookSpecificOutput: { decision: { behavior: string } };
  };
  assert.equal(denied.hookSpecificOutput.decision.behavior, "deny");

  // Answered in the terminal: the call's result shows in the transcript.
  const t = transcriptWith(tempHome());
  setTimeout(t.answer, 100);
  const w = writer(home);
  assert.equal(await permissionHook(request(t.path), { home, remote: w, waitMs: 5000, pollMs: 20 }), undefined);
  assert.equal(listPermissions(home)[0]!.state, "terminal");
  assert.deepEqual(w.calls, ["permission_ask", "permission_settle"]);

  // Nobody answers in time: the prompt is handed to the terminal, and the hook decides nothing.
  assert.equal(await permissionHook(request(), { home, remote: writer(home), waitMs: 150, pollMs: 20 }), undefined);
  assert.equal(listPermissions(home)[0]!.state, "handed");

  // A signal from Claude Code, as when the terminal answered first, hands it over too.
  let stop: (() => Promise<void>) | undefined;
  const waiting = permissionHook(request(), { home, remote: writer(home), waitMs: 5000, pollMs: 20, onStop: (s) => void (stop = s) });
  await sleep(50);
  await stop!();
  assert.equal(await waiting, undefined);
  assert.equal(listPermissions(home)[0]!.state, "terminal");

  // No pages process: the terminal asks.
  assert.equal(await permissionHook(request(), { home, remote: writer(home, true), waitMs: 1000, pollMs: 20 }), undefined);
});

test("the pages take Allow once or Deny, the first answer only, and list the prompts", async () => {
  const home = tempHome();
  turnOn(home);
  await withServer(
    {},
    async (base) => {
      const { id } = askPermission(home, request());
      const listed = await (await fetch(`${base}/api/permissions`)).json();
      assert.deepEqual([listed[0].id, listed[0].state, listed[0].input.command], [id, "waiting", "rm -rf build"]);
      const ok = await postJson(`${base}/api/permissions/${id}`, { decision: "deny", reason: "Keep it" });
      assert.equal(ok.status, 200);
      assert.deepEqual([ok.body.state, ok.body.reason], ["denied", "Keep it"]);
      const again = await postJson(`${base}/api/permissions/${id}`, { decision: "allow" });
      assert.equal(again.status, 409);
      assert.equal(again.body.state, "denied");
      assert.equal((await postJson(`${base}/api/permissions/pm_nosuch1`, { decision: "allow" })).status, 400);
    },
    new Hoop(new Store(home)),
  );
});

test("hoop permission-hook records the prompt through the pages process and prints a page's Allow once", async () => {
  const home = tempHome();
  turnOn(home);
  const env = { ...process.env, ...(await pagesFor(home)) };
  const child = spawn(process.execPath, [...hoopArgs, "permission-hook"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => void (out += d));
  child.stdin.end(JSON.stringify(request()));
  let id: string | undefined;
  for (let i = 0; i < 200 && !id; i++) {
    await sleep(50);
    id = listPermissions(home).find((p) => p.state === "waiting")?.id;
  }
  assert.ok(id, "the prompt was recorded");
  const res = await postJson(`http://127.0.0.1:${env.HOOP_PORT}/api/permissions/${id}`, { decision: "allow" }, { host: `localhost:${env.HOOP_PORT}` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await new Promise((r) => child.on("close", r));
  assert.deepEqual(JSON.parse(out), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
});

test("permission.sh exits at once without starting hoop while permission prompts are off, and passes on a decision while on", () => {
  const home = tempHome();
  const log = join(home, "hoop.log");
  const decision = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
  const bin = fakeBin(home, "fake-hoop", `cat >/dev/null\necho "$*" >> "${log}"\necho '${decision}'`);
  const run = () =>
    spawnSync("sh", [join(scripts, "permission.sh")], {
      input: JSON.stringify(request()),
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: home, HOOP_HOME: home, HOOP_BIN: bin },
    });
  const offRun = run();
  assert.deepEqual([offRun.status, offRun.stdout, existsSync(log)], [0, "", false], "off: no hoop, no node, no decision");
  writeFileSync(join(home, "on"), "# permission_prompts\n");
  assert.equal(run().stdout, "", "a comment names nothing");
  turnOn(home);
  const onRun = run();
  assert.equal(onRun.status, 0);
  assert.equal(onRun.stdout.trim(), decision);
  assert.equal(readFileSync(log, "utf8").trim(), "permission-hook");
});

test("hoop init asks before answering permission prompts from hoop's pages, and a yes adds the line to hoop's on list", async () => {
  const home = tempHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "on"), "something_else");
  let out = "";
  const say = (s: string) => void (out += s);
  let asked = "";
  assert.equal(await permissionStep({ home, tty: true, ask: async (q) => ((asked = q), false), out: say }), 0);
  assert.equal(asked, PERMISSION_QUESTION);
  assert.equal(
    PERMISSION_QUESTION,
    "Answer Claude Code's permission prompts from hoop's pages too? The terminal still asks; nothing is allowed without your click. [y/N] ",
  );
  assert.equal(isOn(home, "permission_prompts"), false, "no: stays off");
  assert.equal(await permissionStep({ home, tty: false, out: say }), 0);
  assert.match(out, /run hoop init --permission-prompts, or add a line permission_prompts to /);
  assert.equal(isOn(home, "permission_prompts"), false, "no terminal and no flag: nothing changes");
  assert.equal(await permissionStep({ home, answer: "yes", out: say }), 0);
  assert.equal(readFileSync(join(home, "on"), "utf8"), "something_else\npermission_prompts\n", "other lines stay");
  out = "";
  await permissionStep({ home, answer: "yes", out: say });
  assert.match(out, /already show on hoop's pages too/);
  assert.equal(hoopCli(["init", "--permission-prompts", "--no-permission-prompts"]).status, 2);
});
