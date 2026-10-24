import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { planReview } from "../src/plan.js";
import { Store } from "../src/store.js";
import { cli, tempHome, tsx, pagesFor } from "./helpers.js";

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

test("an approval passes on its answers, saying which ones hoop took from the recommendation", async () => {
  const { hoop } = setup();
  const plan = "# Plan\n\n## Question: Which store?\n\n- A. Files (recommended)\n- B. SQLite\n\n## Question: When?\n\n- Now (recommended)\n- Later\n";
  const waiting = planReview(input(plan, "sess-r"), hoop, { waitMs: 30_000, intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 50));
  const [review] = hoop.store.list();
  hoop.review(review!.id, {
    verdict: "approved",
    reviewer: "ankur",
    answers: [
      { item: "S-1", choice: "b" },
      { item: "S-2", choice: "a", recommended: true },
    ],
  });
  const allowed = await waiting;
  assert.equal(allowed.hookSpecificOutput.permissionDecision, "allow");
  const reason = allowed.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /ankur answered "Question: Which store\?": b\) SQLite/);
  assert.match(reason, /ankur approved without answering "Question: When\?", so hoop took the recommended option: a\) Now/);
  const again = await planReview(input(plan, "sess-r"), hoop, { waitMs: 50, intervalMs: 10 });
  assert.match(again.hookSpecificOutput.permissionDecisionReason, /so hoop took the recommended option: a\) Now/, "a later call still says so");
});

test("the command takes the hook's input on stdin and prints the hook's decision", async () => {
  const home = tempHome();
  const pages = await pagesFor(home);
  const r = spawnSync(process.execPath, [tsx, cli, "plan-review"], {
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
