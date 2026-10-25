import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { planReview } from "../src/plan.js";
import { Store } from "../src/store.js";
import { tempHome, pagesFor, hoopArgs } from "./helpers.js";

const PLAN = "# Plan\n\n1. Add the export route.\n2. Stream rows.\n";
const input = (plan = PLAN, session = "sess-1") => ({ session_id: session, cwd: process.cwd(), tool_input: { plan } });
const wrapper = new URL("../plugins/hoop/scripts/plan-review.sh", import.meta.url).pathname;

function setup() {
  const repo = tempHome();
  process.env.HOOP_REPO_DIR = repo;
  return { repo, hoop: new Hoop(new Store(tempHome())) };
}

test("a plan waits for approval in hoop, stops with the link when no verdict comes, and goes on once approved", async () => {
  const { repo, hoop } = setup();
  const first = await planReview(input(), hoop, { waitMs: 50, intervalMs: 10 });
  assert.equal(first.hookSpecificOutput.permissionDecision, "deny");
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /No verdict on the plan yet\. Stop here .*http:\/\/localhost:\d+\/r\/rv_/);
  const [review] = hoop.store.list();
  hoop.review(review!.id, { verdict: "approved" });
  const second = await planReview(input(), hoop, { waitMs: 50, intervalMs: 10 });
  assert.equal(second.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(hoop.store.list().length, 1, "a retry finds the session's review");
  assert.equal(existsSync(join(repo, "decisions")), false, "a plan review writes no decision files");
});

test("a review with comments denies with the feedback, and a changed plan becomes a revision", async () => {
  const { hoop } = setup();
  const waiting = planReview(input(), hoop, { waitMs: 30_000, intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 50));
  const [review] = hoop.store.list();
  hoop.review(review!.id, {
    verdict: "changes_requested",
    reviewer: "ankur",
    summary: "Add tests first.",
    comments: [{ words: "Stream rows.", body: "Name the page size." }],
  });
  const denied = await waiting;
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /ankur: Add tests first\.\nankur on .* \("Stream rows\."\): Name the page size\./);
  await planReview(input(PLAN.replace("Stream rows.", "Stream rows, 500 at a time.")), hoop, { waitMs: 20, intervalMs: 10 });
  assert.equal(hoop.store.list().length, 1);
  assert.equal(hoop.store.meta(review!.id).revisions, 2);
});

test("feedback that came after a wait timed out reaches the agent when it leaves plan mode with a changed plan", async () => {
  const { hoop } = setup();
  const quick = { waitMs: 20, intervalMs: 10 };
  assert.match((await planReview(input(), hoop, quick)).hookSpecificOutput.permissionDecisionReason, /No verdict/);
  const [review] = hoop.store.list();
  hoop.review(review!.id, { verdict: "changes_requested", reviewer: "ankur", comments: [{ words: "Stream rows.", body: "Use docker compose locally." }] });
  const changed = PLAN.replace("Stream rows.", "Stream rows in pages.");
  const denied = await planReview(input(changed), hoop, quick);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    denied.hookSpecificOutput.permissionDecisionReason,
    /feedback in hoop you hadn't read.*\nankur on .* \("Stream rows\."\): Use docker compose locally\./s,
  );
  assert.equal(hoop.store.meta(review!.id).revisions, 1, "the changed plan wasn't submitted over the comment");
  // Having passed the comment on, the next try submits the plan.
  assert.match((await planReview(input(changed), hoop, quick)).hookSpecificOutput.permissionDecisionReason, /No verdict/);
  assert.equal(hoop.store.meta(review!.id).revisions, 2);
});

test("an approval the agent missed, then a changed plan, says the previous plan was approved and the new one needs a review", async () => {
  const { hoop } = setup();
  const quick = { waitMs: 20, intervalMs: 10 };
  await planReview(input(), hoop, quick);
  const [review] = hoop.store.list();
  hoop.review(review!.id, { verdict: "approved", reviewer: "ankur", summary: "Go." });
  const denied = await planReview(input(PLAN.replace("Stream rows.", "Stream rows in pages.")), hoop, quick);
  const reason = denied.hookSpecificOutput.permissionDecisionReason;
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(reason, /^Your previous plan was approved in hoop: http:\/\/localhost:\d+\/r\/rv_\w+\nankur: Go\.\nThis changed plan needs a new review/);
  assert.doesNotMatch(reason, /Revise it|left no comments/);
  const next = await planReview(input(PLAN.replace("Stream rows.", "Stream rows in pages.")), hoop, quick);
  assert.match(next.hookSpecificOutput.permissionDecisionReason, /No verdict on the plan yet/);
  assert.equal(hoop.store.list().length, 2, "the changed plan went out as a new review");
});

test("an approval that came after a wait timed out is received, so the session's next plan isn't refused", async () => {
  const { hoop } = setup();
  const quick = { waitMs: 20, intervalMs: 10 };
  await planReview(input(), hoop, quick);
  const [review] = hoop.store.list();
  hoop.review(review!.id, { verdict: "approved", reviewer: "ankur", summary: "Go." });
  assert.equal((await planReview(input(), hoop, quick)).hookSpecificOutput.permissionDecision, "allow");
  const next = await planReview(input("# Plan\n\n1. The next task.\n"), hoop, quick);
  assert.match(next.hookSpecificOutput.permissionDecisionReason, /No verdict on the plan yet/);
  assert.equal(hoop.store.list().length, 2, "the new plan superseded the approved one");
});

test("a plan's answers go with a request for changes, and the plan without its questions is approved", async () => {
  const { hoop } = setup();
  const plan = "# Plan\n\n## Question: Which store?\n\n- A. Files (recommended)\n- B. SQLite\n\n## Steps\n\n1. Build it.\n";
  const waiting = planReview(input(plan, "sess-r"), hoop, { waitMs: 30_000, intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 50));
  const [review] = hoop.store.list();
  // A plan with a question in it isn't approved: the reviewer answers with a request for changes.
  assert.throws(() => hoop.review(review!.id, { verdict: "approved", reviewer: "ankur" }, true), /1 question is still in the text/);
  hoop.review(review!.id, { verdict: "changes_requested", reviewer: "ankur", answers: [{ item: "S-1", choice: "b" }] }, true);
  const denied = await waiting;
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /ankur answered "Question: Which store\?": b\) SQLite/);
  // Claude writes the decision in and removes the question; that plan is approved.
  const decided = "# Plan\n\nStore orders in SQLite.\n\n## Steps\n\n1. Build it.\n";
  const again = planReview(input(decided, "sess-r"), hoop, { waitMs: 30_000, intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 50));
  hoop.review(review!.id, { verdict: "approved", reviewer: "ankur", summary: "Go." }, true);
  const allowed = await again;
  assert.equal(allowed.hookSpecificOutput.permissionDecision, "allow");
  assert.match(allowed.hookSpecificOutput.permissionDecisionReason, /ankur: Go\./);
});

test("the command takes the hook's input on stdin and prints the hook's decision", async () => {
  const home = tempHome();
  const pages = await pagesFor(home);
  const r = spawnSync(process.execPath, [...hoopArgs, "plan-review"], {
    input: JSON.stringify(input()),
    encoding: "utf8",
    env: { ...process.env, ...pages, HOOP_REPO_DIR: tempHome(), HOOP_PLAN_WAIT_SECONDS: "1", HOOP_PAGES: "off" },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});

test("the hook fails closed: a missing hoop, a crash, no decision or the alarm each deny with exit 2", () => {
  const bin = mkdtempSync(join(tmpdir(), "hoop-plan-bin-"));
  const fake = (name: string, body: string) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\ncat >/dev/null\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const run = (hoopBin: string, env: Record<string, string> = {}) =>
    spawnSync("sh", [wrapper], { input: JSON.stringify(input()), encoding: "utf8", env: { ...process.env, HOOP_BIN: hoopBin, ...env } });
  const cases: [string, ReturnType<typeof run>][] = [
    ["missing", run(join(bin, "no-such-hoop"))],
    ["crash", run(fake("crash", "exit 1"))],
    ["no decision", run(fake("garbage", "echo hello"))],
    ["alarm", run(fake("slow", "sleep 5"), { HOOP_PLAN_ALARM: "1" })],
  ];
  for (const [name, r] of cases) {
    assert.equal(r.status, 2, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /hoop: .*stop here and tell the user/, name);
  }
  const ok = run(fake("allow", `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"ok"}}'`));
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).hookSpecificOutput.permissionDecision, "allow");
});

test("a plan's answered question reaches the agent with the chosen option", async () => {
  const { hoop } = setup();
  const plan = "# Plan\n\n## Question: Which store?\n\n- A. Files (recommended)\n- B. SQLite\n";
  const waiting = planReview(input(plan, "sess-q"), hoop, { waitMs: 30_000, intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 50));
  const [review] = hoop.store.list();
  hoop.review(review!.id, { verdict: "comment", reviewer: "ankur", answers: [{ item: "S-1", choice: "b" }] });
  const denied = await waiting;
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /ankur answered "Question: Which store\?": b\) SQLite/);
  const own = planReview(input(plan.replace("SQLite", "A database"), "sess-q"), hoop, { waitMs: 30_000, intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 50));
  hoop.review(review!.id, { verdict: "comment", reviewer: "ankur", answers: [{ item: "S-1", choice: "other", text: "Keep files for now." }] });
  assert.match((await own).hookSpecificOutput.permissionDecisionReason, /ankur answered "Question: Which store\?": in their own words: Keep files for now\./);
});
