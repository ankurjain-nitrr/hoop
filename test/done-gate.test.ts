import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DoneLook, doneGate, isDoneInput } from "../src/done.js";
import { Hoop } from "../src/hoop.js";
import type { PrState } from "../src/prs.js";
import { Store } from "../src/store.js";
import { type Evidence, readWork, workHook, workView } from "../src/work.js";
import { BROWSER_SKIP, example, freePort, hoopArgs, pagesFor, TEST_SESSION, tempHome, withBrowser } from "./helpers.js";

const DONE = JSON.parse(readFileSync(new URL("./fixtures/done-hooks.json", import.meta.url), "utf8"));
const WORK = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const script = new URL("../plugins/hoop/scripts/done-gate.sh", import.meta.url).pathname;
const PR = (n: number) => `https://github.com/acme/app/pull/${n}`;
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

const done = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(DONE[name]), ...extra });
const hook = (name: string, extra: Record<string, unknown>) => ({ ...structuredClone(WORK[name]), session_id: TEST_SESSION, ...extra });

/** Todo `id` with its subject and description, created `at` seconds ago and started a second later. */
function start(home: string, id: string, subject: string, description: string, at = 600) {
  workHook(home, hook("post-taskcreate", { tool_input: { subject, description }, tool_response: { task: { id, subject } } }), ago(at));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: id, status: "in_progress" } }), ago(at - 1));
}

/** The done gate's evidence: pull requests by URL, reviews by ID, and the session's tracked pull requests. */
const look = (
  prs: Record<string, PrState["state"]>,
  reviews: Record<string, string> = {},
  tracked: Evidence["tracked"] = [],
  fresh?: DoneLook["fresh"],
): DoneLook => ({
  evidence: {
    review: (id) => (reviews[id] ? { title: "The plan", status: reviews[id]!, at: ago(900) } : undefined),
    pr: (url) => (prs[url] ? { state: prs[url]! } : undefined),
    tracked,
  },
  ...(fresh ? { fresh } : {}),
});

test("the recorded TaskCompleted inputs are what the gate reads; other hooks aren't", () => {
  assert.ok(isDoneInput(DONE.completed));
  assert.ok(isDoneInput(DONE.deliverable));
  assert.equal(isDoneInput({ ...DONE.completed, hook_event_name: "TaskCreated" }), false);
  assert.equal(isDoneInput({ ...DONE.completed, task_id: undefined }), false);
  assert.equal(isDoneInput({ ...DONE.completed, session_id: "../x" }), false);
});

test("a todo whose pull request is open is refused once; the next completion goes ahead and keeps a done-without note", async () => {
  const home = tempHome();
  start(home, "1", "Fix the parser", `Lands in ${PR(12)}`);
  const open = look({ [PR(12)]: "open" });
  const first = await doneGate(home, done("completed"), open);
  assert.match(
    first?.refuse ?? "",
    /^hoop \(once\): todo #1 "Fix the parser" isn't done yet: PR #12 isn't merged \(https:\/\/github\.com\/acme\/app\/pull\/12\)\. Keep it in progress/,
  );
  assert.deepEqual(readWork(home, TEST_SESSION)?.done_told, [`1:${PR(12)}`]);
  assert.equal(await doneGate(home, done("completed"), open), undefined, "told once: it goes ahead");
  assert.deepEqual(readWork(home, TEST_SESSION)?.done_without, { "1": `PR #12 isn't merged (${PR(12)})` });
  // The Work view shows the note once the todo is done.
  assert.equal(workView(home, () => [])[0]!.todos[0]!.done_without, undefined, "not while it runs");
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", status: "completed" } }));
  assert.equal(workView(home, () => [])[0]!.todos[0]!.done_without, `PR #12 isn't merged (${PR(12)})`);
});

test("the Work page shows a todo done past the gate with what it was done without", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  start(home, "1", "Fix the parser", `Lands in ${PR(12)}`);
  await doneGate(home, done("completed"), look({ [PR(12)]: "open" }));
  await doneGate(home, done("completed"), look({ [PR(12)]: "open" }));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", status: "completed" } }));
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/work`);
      const row = page.locator(`#todo-${TEST_SESSION}-1`);
      // An ended session folds: the row is there, hidden.
      await row.waitFor({ state: "attached" });
      assert.equal(await row.locator(".why").first().textContent(), `Done without it: PR #12 isn't merged (${PR(12)})`);
    },
    new Hoop(new Store(home)),
    { sessions: () => [], gh: async () => JSON.stringify({ state: "OPEN" }) },
  );
});

test("a merged pull request, an approved review, a fresh read that finds it merged, or a closed review let the completion go ahead", async () => {
  const home = tempHome();
  const description = `Lands in ${PR(12)}. Plan: http://localhost:4747/r/rv_plan`;
  start(home, "1", "Fix the parser", description);
  const completed = (_: string) => done("completed", { task_description: description });
  assert.equal(await doneGate(home, completed(""), look({ [PR(12)]: "merged" }, { rv_plan: "approved" })), undefined);
  assert.equal(await doneGate(home, completed(""), look({ [PR(12)]: "merged" }, { rv_plan: "closed" })), undefined);
  const fresh = async () => ({ state: "merged" as const });
  assert.equal(await doneGate(home, completed(""), look({ [PR(12)]: "open" }, { rv_plan: "approved" }, [], fresh)), undefined);
  // A review still waiting on the person refuses.
  const waiting = await doneGate(home, completed(""), look({ [PR(12)]: "merged" }, { rv_plan: "awaiting_review" }));
  assert.match(waiting?.refuse ?? "", /the review "The plan" isn't approved/);
  assert.equal(readWork(home, TEST_SESSION)?.done_without, undefined);
});

test("a todo whose subject delivers the pull request or review is done once it exists", async () => {
  const home = tempHome();
  start(home, "1", "Open a PR for the fix", `Ships ${PR(12)}`);
  assert.equal(await doneGate(home, done("deliverable"), look({ [PR(12)]: "open" })), undefined);
  start(home, "2", "Submit the plan for review", "http://localhost:4747/r/rv_plan");
  const review = done("deliverable", { task_id: "2", task_subject: "Submit the plan for review", task_description: "http://localhost:4747/r/rv_plan" });
  assert.equal(await doneGate(home, review, look({}, { rv_plan: "awaiting_review" })), undefined);
  assert.equal(readWork(home, TEST_SESSION)?.done_told, undefined);
});

test("#299 replay: with two running todos naming their own pull requests, completing one refuses only over its own", async () => {
  const home = tempHome();
  start(home, "1", "Fix the push hook (#21)", "", 600);
  start(home, "2", "Build the gate (#22)", "", 300);
  // Both opened after todo 2 started: by start time, both were todo 2's.
  const tracked = [21, 22].map((n) => ({ url: PR(n), session: TEST_SESSION, added: ago(100 - n) }));
  const evidence = look({ [PR(21)]: "merged", [PR(22)]: "open" }, {}, tracked);
  const one = done("completed", { task_id: "1", task_subject: "Fix the push hook (#21)", task_description: "" });
  assert.equal(await doneGate(home, one, evidence), undefined, "todo 1's own PR merged");
  const two = done("completed", { task_id: "2", task_subject: "Build the gate (#22)", task_description: "" });
  assert.match((await doneGate(home, two, evidence))?.refuse ?? "", /PR #22 isn't merged/);
});

test("the gate fails open: no record, an unknown todo, a pull request not read yet, or evidence that throws", async () => {
  const home = tempHome();
  assert.equal(await doneGate(home, done("completed"), look({ [PR(12)]: "open" })), undefined, "no record");
  start(home, "1", "Fix the parser", `Lands in ${PR(12)}`);
  assert.equal(await doneGate(home, done("completed", { task_id: "9" }), look({ [PR(12)]: "open" })), undefined, "a todo hoop never saw");
  assert.equal(await doneGate(home, done("completed"), look({})), undefined, "state not read yet");
  const broken: DoneLook = {
    evidence: {
      review: () => undefined,
      pr: () => {
        throw new Error("gh broke");
      },
      tracked: [],
    },
  };
  assert.equal(await doneGate(home, done("completed"), broken), undefined);
  // A slow fresh read goes by the state last read.
  const slow = () => new Promise<PrState>(() => {});
  const t0 = Date.now();
  assert.match((await doneGate(home, done("completed"), look({ [PR(12)]: "open" }, {}, [], slow)))?.refuse ?? "", /PR #12/);
  assert.ok(Date.now() - t0 < 1900);
});

test("the script is POSIX sh, starts hoop only for a session with work, fails open, and refuses with exit 2 and the reason on stderr", async () => {
  const home = tempHome();
  const bin = mkdtempSync(join(tmpdir(), "hoop-done-bin-"));
  const crash = join(bin, "crash");
  writeFileSync(crash, `#!/bin/sh\ncat >/dev/null\necho ran >> "${bin}/ran"\nexit 1\n`);
  chmodSync(crash, 0o755);
  const slow = join(bin, "slow");
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

  for (const input of [done("completed"), { ...done("completed"), hook_event_name: "Stop" }, {}, "not json"]) {
    const r = run(crash, input);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
  }
  assert.equal(ran(), 0, "no work record: hoop doesn't start");

  const hoop = new Hoop(new Store(home));
  const { review_id } = hoop.submit(example());
  start(home, "1", "Fix the parser", `Plan: http://localhost:4747/r/${review_id}`);
  assert.deepEqual([run(crash, done("completed")).status, ran()], [0, 1], "a broken hoop lets the todo complete");
  // A PATH with the script's tools and no perl.
  const tools = mkdtempSync(join(tmpdir(), "hoop-done-tools-"));
  for (const t of ["cat", "dirname", "grep", "head", "mktemp", "rm", "sed", "sleep"]) {
    const from = ["/usr/bin", "/bin"].map((d) => join(d, t)).find((f) => existsSync(f));
    if (from) symlinkSync(from, join(tools, t));
  }
  const t0 = Date.now();
  const late = run(slow, done("completed"), { HOOP_DONE_WAIT: "1", PATH: tools });
  assert.deepEqual([late.status, late.stderr], [0, ""], "a slow hoop lets the todo complete");
  assert.ok(Date.now() - t0 < 4000);
  const down = run(real, done("completed"), { HOOP_PORT: String(await freePort()) });
  assert.deepEqual([down.status, down.stderr], [0, ""], "no pages process: the todo completes, and none starts");

  const pages = await pagesFor(home);
  const planned = done("completed", { task_description: `Plan: http://localhost:4747/r/${review_id}` });
  const refused = run(real, planned, pages);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^hoop \(once\): todo #1 "Fix the parser" isn't done yet: the review ".+" isn't approved\./);
  assert.deepEqual([run(real, planned, pages).status], [0], "once");
  assert.match(readWork(home, TEST_SESSION)?.done_without?.["1"] ?? "", /isn't approved/);

  const hooks = JSON.parse(readFileSync(new URL("../plugins/hoop/hooks/hooks.json", import.meta.url), "utf8")).hooks;
  const gate = hooks.TaskCompleted[0].hooks[0];
  assert.match(gate.command, /done-gate\.sh/);
  assert.equal(gate.async, undefined, "it runs before the todo completes");
  assert.ok(gate.timeout > 4, "Claude Code's timeout is longer than the script's wait");
});
