import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { permissionHook } from "../src/permission-hook.js";
import {
  answerPermission,
  askPermission,
  decisionOutput,
  hasResult,
  isOn,
  listPermissions,
  HOOK_LIFE_MS,
  openCall,
  permissionsGate,
  prunePermissions,
  readPermission,
  settlePermission,
} from "../src/permissions.js";
import { permissionStep, PERMISSION_QUESTION } from "../src/init.js";
import { BROWSER_SKIP, fakeBin, hoopArgs, hoopCli, pagesFor, postJson, sleep, tempHome, withBrowser, withServer } from "./helpers.js";
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

/** What a page of `base` sends with an answer: its Origin, the browser's same-origin word, and the page's cookie. */
async function pageHeaders(base: string): Promise<Record<string, string>> {
  const cookie = (await fetch(`${base}/`)).headers.get("set-cookie") ?? "";
  return {
    origin: base,
    "sec-fetch-site": "same-origin",
    cookie: cookie.split(";")[0]!,
  };
}

test("an answer comes only from a page these pages served: its Origin, same-origin and its cookie, each required", async () => {
  const home = tempHome();
  turnOn(home);
  await withServer(
    {},
    async (base) => {
      const { id } = askPermission(home, request());
      const url = `${base}/api/permissions/${id}`;
      const page = await pageHeaders(base);
      const { cookie, ...noCookie } = page;
      const { "sec-fetch-site": _site, ...noSite } = page;
      const { origin: _origin, ...noOrigin } = page;
      // The cookie is HttpOnly, SameSite=Strict and sent only to the permission answers.
      const set = (await fetch(`${base}/`)).headers.get("set-cookie") ?? "";
      assert.match(set, /^hoop_answer=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/api\/permissions$/);
      assert.equal((await fetch(`${base}/api/permissions`)).headers.get("set-cookie"), null, "the list never hands it out");
      assert.doesNotMatch(await (await fetch(`${base}/api/permissions`)).text(), new RegExp(String(cookie).split("=")[1]!), "nor holds it");
      for (const [why, headers] of [
        ["no Origin, as a local program sends", {}],
        ["no Origin", noOrigin],
        ["another Origin", { ...page, origin: "http://localhost:9999" }],
        ["no Sec-Fetch-Site", noSite],
        ["a cross-site Sec-Fetch-Site", { ...page, "sec-fetch-site": "cross-site" }],
        ["no cookie", noCookie],
        ["another process's cookie", { ...page, cookie: `hoop_answer=${"0".repeat(64)}` }],
      ] as const) {
        const r = await postJson(url, { decision: "allow" }, headers as Record<string, string>);
        assert.equal(r.status, 403, `${why}: ${JSON.stringify(r.body)}`);
      }
      assert.equal(readPermission(home, id)!.state, "waiting", "nothing was answered");
      // A page's own request is taken; the first answer wins, and a later one is refused with how it went.
      const ok = await postJson(url, { decision: "deny", reason: "Keep it" }, page);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual([ok.body.state, ok.body.reason], ["denied", "Keep it"]);
      const again = await postJson(url, { decision: "allow" }, page);
      assert.deepEqual([again.status, again.body.state], [409, "denied"]);
      assert.equal((await postJson(`${base}/api/permissions/pm_nosuch1`, { decision: "allow" }, page)).status, 400);
      const listed = await (await fetch(`${base}/api/permissions`)).json();
      assert.deepEqual([listed[0].id, listed[0].state, listed[0].input], [id, "denied", undefined]);
    },
    new Hoop(new Store(home)),
  );
});

test("a page in the browser answers with its own Origin, Sec-Fetch-Site and cookie", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  turnOn(home);
  await withBrowser(
    async ({ base, page }) => {
      const { id } = askPermission(home, request());
      await page.goto(`${base}/`);
      const status = await page.evaluate(
        async (u) => (await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "allow" }) })).status,
        `/api/permissions/${id}`,
      );
      assert.equal(status, 200);
      assert.equal(readPermission(home, id)!.state, "allowed");
    },
    new Hoop(new Store(home)),
  );
});

test("records are the owner's alone, and a prompt that lost its hook is handed to the terminal, its input gone", () => {
  const home = tempHome();
  turnOn(home);
  const { id } = askPermission(home, request(), new Date("2026-11-08T10:00:00Z"));
  assert.equal(statSync(join(home, "permissions")).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, "permissions", `${id}.json`)).mode & 0o777, 0o600);
  settlePermission(home, askPermission(home, request(), new Date("2026-11-08T10:00:01Z")).id, "terminal");
  for (const f of readdirSync(join(home, "permissions"))) assert.equal(statSync(join(home, "permissions", f)).mode & 0o777, 0o600, f);
  // Its hook was killed: past a hook's longest life, the next prompt hands it over.
  prunePermissions(home, Date.parse("2026-11-08T10:05:00Z"));
  assert.equal(readPermission(home, id)!.state, "waiting", "within a hook's life it still waits");
  askPermission(home, request(), new Date(Date.parse("2026-11-08T10:00:00Z") + HOOK_LIFE_MS + 1000));
  const handed = readPermission(home, id)!;
  assert.deepEqual([handed.state, handed.input], ["handed", undefined]);
});

test("while permission prompts are on, the write gate refuses a call of the answers' API, or a page script naming it, and nothing else", () => {
  const call = (tool: string, tool_input: Record<string, unknown>) => ({
    session_id: "test-session-0000",
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input,
  });
  const home = tempHome();
  const curl = call("Bash", { command: "curl -X POST localhost:4747/api/permissions/pm_x -d '{}'" });
  assert.equal(permissionsGate(home, curl), undefined, "off: nothing is refused");
  turnOn(home);
  const refused = (c: object) => /answered only by the person/.test(permissionsGate(home, c) ?? "");
  for (const c of [
    curl,
    call("Bash", { command: "curl http://127.0.0.1/api/permissions" }),
    call("WebFetch", { url: "http://localhost:4747/api/permissions", prompt: "x" }),
    call("mcp__plugin_playwright_playwright__browser_evaluate", { function: "() => fetch('/api/permissions/pm_x', { method: 'POST' })" }),
    call("mcp__plugin_playwright_playwright__browser_run_code_unsafe", { code: "await page.request.post('/api/permissions/pm_x')" }),
    call("mcp__plugin_chrome-devtools-mcp_chrome-devtools__evaluate_script", { function: "() => fetch('/api/permissions')" }),
  ])
    assert.equal(refused(c), true, JSON.stringify(c));
  // A mention of the path is no call, and a browser tool's navigation and clicks stay allowed.
  for (const c of [
    call("Bash", { command: "grep -rn /api/permissions src" }),
    call("Bash", { command: 'git commit -m "Harden POST /api/permissions/<id>"' }),
    call("Bash", { command: "ls" }),
    call("Read", { file_path: "/repo/src/api/permissions.ts" }),
    call("Edit", { file_path: "src/web.ts", old_string: "/api/permissions", new_string: "/api/permissions" }),
    call("mcp__plugin_playwright_playwright__browser_navigate", { url: "http://localhost:4747/work" }),
    call("mcp__plugin_playwright_playwright__browser_click", { element: "Allow once", ref: "e12" }),
    call("mcp__plugin_playwright_playwright__browser_evaluate", { function: "() => document.title" }),
  ])
    assert.equal(refused(c), false, JSON.stringify(c));

  // The gate script asks hoop only for such a call, and only while permission prompts are on.
  const log = join(home, "hoop.log");
  const bin = fakeBin(home, "fake-hoop", `cat >/dev/null\necho "$*" >> "${log}"\necho '{}'`);
  const gate = (input: object) =>
    spawnSync("sh", [join(scripts, "gate-work.sh")], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: home, HOOP_HOME: home, HOOP_BIN: bin },
    });
  for (const c of [
    call("Bash", { command: "ls" }),
    call("Bash", { command: "grep -rn /api/permissions src" }),
    call("Bash", { command: 'git commit -m "Harden /api/permissions"' }),
    call("Read", { file_path: "src/api/permissions.ts" }),
    call("mcp__plugin_playwright_playwright__browser_click", { element: "Allow once", ref: "e12" }),
  ])
    gate(c);
  assert.equal(existsSync(log), false, "no round trip for a mention, a read or a click");
  gate(call("Bash", { command: "curl localhost:4747/api/permissions" }));
  gate(call("mcp__plugin_playwright_playwright__browser_evaluate", { function: "() => fetch('/api/permissions')" }));
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["work-gate", "work-gate"]);
  writeFileSync(join(home, "on"), "");
  gate(call("Bash", { command: "curl localhost:4747/api/permissions" }));
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2, "off: no round trip");
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
  const res = await postJson(
    `http://127.0.0.1:${env.HOOP_PORT}/api/permissions/${id}`,
    { decision: "allow" },
    await pageHeaders(`http://127.0.0.1:${env.HOOP_PORT}`),
  );
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
    "Answer Claude Code's permission prompts from hoop's pages too? The terminal still asks; nothing is allowed without a click, but a Claude session with a browser tool, or another program you run, could click it too. [y/N] ",
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

test("regression: Claude Code's question tool and leaving plan mode are never recorded or answered, so the terminal answers them", async () => {
  // Allow once can't answer them: an allow needs the answer itself (updatedInput), and the plan hook reviews a plan.
  const home = tempHome();
  turnOn(home);
  const question = {
    ...request(),
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Which framework?", header: "Framework", options: [{ label: "React" }, { label: "Vue" }], multiSelect: false }] },
  };
  const plan = { ...request(), tool_name: "ExitPlanMode", tool_input: { plan: "# Plan\n" } };
  for (const input of [question, plan]) {
    assert.throws(() => askPermission(home, input), /hoop doesn't answer (AskUserQuestion|ExitPlanMode): the terminal does/);
    const w = writer(home);
    assert.equal(await permissionHook(input, { home, remote: w, waitMs: 1000, pollMs: 20 }), undefined);
    assert.deepEqual(w.calls, [], "nothing is recorded");
  }
  assert.deepEqual(listPermissions(home), []);
  // The hook script leaves them to the terminal without starting hoop.
  const log = join(home, "hoop.log");
  const bin = fakeBin(home, "fake-hoop", `cat >/dev/null\necho "$*" >> "${log}"\necho '{}'`);
  for (const input of [question, plan]) {
    const r = spawnSync("sh", [join(scripts, "permission.sh")], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: home, HOOP_HOME: home, HOOP_BIN: bin },
    });
    assert.deepEqual([r.status, r.stdout], [0, ""]);
  }
  assert.equal(existsSync(log), false, "no hoop started");
  // A spaced JSON form is caught too.
  const spaced = JSON.stringify(question).replace('"tool_name":"AskUserQuestion"', '"tool_name": "AskUserQuestion"');
  spawnSync("sh", [join(scripts, "permission.sh")], {
    input: spaced,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: home, HOOP_HOME: home, HOOP_BIN: bin },
  });
  assert.equal(existsSync(log), false);
});
