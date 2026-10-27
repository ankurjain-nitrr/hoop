// Live end-to-end run: `hoop mcp` (with its review pages), a reviewer in Chrome, `hoop wait` in the
// background, then an approval. Part two: quotes, hoop_wait, diagrams and tables, an approval
// from the page, the history and the plan hook.
// Needs Chrome.
// Usage: npx tsx scripts/e2e-local.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chrome, cli, connectMcp, root, runHome, step, tsx, waitFor as waitForReview } from "./lib.js";
import { chromium } from "playwright-core";

const repoDir = mkdtempSync(join(tmpdir(), "hoop-e2e-repo-"));
const env = { ...(process.env as Record<string, string>), HOOP_HOME: runHome("hoop-e2e-home-"), HOOP_REPO_DIR: repoDir, HOOP_PORT: "4791" };

const { client, call } = await connectMcp(env);
const waitFor = (id: string) => waitForReview(id, env, { timeout: 120 });

step("Claude submits over MCP; the MCP process serves the review page");
const doc = JSON.parse(readFileSync(join(root, "examples/order-export.json"), "utf8"));
const sub = await call("hoop_submit", { document: doc });
assert.equal(sub.url, `http://localhost:4791/r/${sub.review_id}`);
const waiting = waitFor(sub.review_id);
await waiting.ready;

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
await page.goto(sub.url);
await page.getByText("Export all orders as CSV").first().waitFor();

step("the reviewer comments on selected text, answers and requests changes");
await page.locator('[data-sel-item="FR-3"][data-sel-line="0"]').evaluate((el) => {
  const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!,
    at = node.textContent!.indexOf("created");
  const r = document.createRange();
  r.setStart(node, at);
  r.setEnd(node, at + 7);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(r);
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
});
await page.getByRole("button", { name: "Comment on selection" }).click();
await page.locator("#cbody").fill("Inclusive bounds?");
await page.getByRole("button", { name: "Start a review" }).click();
await page.locator("#q-Q-1-b").check();
await page.locator("#finishBtn").click();
await page.getByRole("button", { name: "Submit review" }).click();

step("hoop wait (in the background) wakes with the feedback");
const first = await waiting;
const c = first.feedback[0].comments[0];
assert.equal(first.feedback[0].verdict, "changes_requested");
assert.deepEqual([c.item, c.line, c.range.quote], ["FR-3", 1, "created"]);
assert.deepEqual(first.feedback[0].answers, [{ item: "Q-1", choice: "b" }]);

step("Claude replies, submits rev 2; the page shows the thread as outdated");
await call("hoop_reply", { thread: c.thread, body: "Both bounds inclusive in rev 2." });
doc.items[2].body = "When from or to are given, the system shall include orders created within both bounds, inclusive.";
// The answer is written in, so revision 2 has no question left (#165).
doc.items = doc.items.filter((i: { type: string }) => i.type !== "question");
await call("hoop_submit", { document: { ...doc, review_id: sub.review_id } });
const approving = waitFor(sub.review_id);
await approving.ready;
await page.goto(sub.url);
await page.locator("#item-FR-3 .thread.outdated").waitFor();

step("the reviewer resolves the conversation and approves; nothing is written into the repository");
// Every conversation is resolved before an approval (#165).
const resolve = page.getByRole("button", { name: "Resolve conversation" });
while (await resolve.count()) await resolve.first().click();
await page.locator("#finishBtn").click();
await page.getByRole("button", { name: "Submit review" }).click();
const approved = await approving;
assert.equal(approved.approved, true);
assert.equal(approved.revision, 2);
assert.equal(existsSync(join(repoDir, "decisions")), false);
assert.equal((await call("hoop_feedback", { review_id: sub.review_id })).approved, true);

await client.close();

// Part two: the newer flows.
const repo2 = mkdtempSync(join(tmpdir(), "hoop-e2e-repo2-"));
const env2 = {
  ...(process.env as Record<string, string>),
  HOOP_HOME: runHome("hoop-e2e-home2-"),
  HOOP_REPO_DIR: repo2,
  HOOP_PORT: "4793",
};
const two = await connectMcp(env2);
const base2 = "http://localhost:4793";

step("hoop lists eighteen tools");
assert.equal((await two.client.listTools()).tools.length, 18);

step("Claude submits markdown, and the result states its outcome and a cursor");
const md =
  "# Export plan\n\nShip the CSV export.\n\n## Flow\n\n```mermaid\nflowchart LR\n  a[Request] --> b[CSV]\n```\n\n| Field | Kind |\n|---|---|\n| id | number |\n\n## Steps\n\n- Stream rows as they are read.\n- Keep the header row first.\n";
const plan = await two.call("hoop_submit", { markdown: md });
assert.deepEqual([plan.outcome, plan.cursor], ["created", "1.0"]);

step("an agent comments by quoting words, and hoop_wait returns it from the cursor");
const posted = await fetch(`${base2}/api/reviews/${plan.review_id}/feedback`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    verdict: "changes_requested",
    reviewer: "reviewer (agent)",
    comments: [{ words: "Keep the header row first.", body: "Name the columns." }],
  }),
}).then((r) => r.json());
assert.equal(posted.comments[0].line, 2);
const waited = await two.call("hoop_wait", { review_id: plan.review_id, after: plan.cursor, seconds: 5 });
assert.equal(waited.status, "reviewed");
assert.equal(waited.feedback.at(-1).comments[0].scope.kind, "line");

step("the page draws the diagram and the table");
await page.goto(`${base2}/r/${plan.review_id}`);
await page.locator(".diagram-frame.drawn").waitFor({ timeout: 20000 });
await page.locator(".md-table th", { hasText: "Field" }).waitFor();

step("the reviewer approves with no sign-in; the feedback names the person running hoop");
while (await resolve.count()) await resolve.first().click();
await page.locator("#finishBtn").click();
await page.locator("#summary").fill("Ship it.");
await page.getByRole("button", { name: "Submit review" }).click();
await page.getByText(/Review submitted: Approved/).waitFor();
const approval = await two.call("hoop_feedback", { review_id: plan.review_id });
const last = approval.feedback.at(-1);
assert.deepEqual([approval.approved, last.verdict, last.reviewer, last.summary], [true, "approved", userInfo().username, "Ship it."]);

step("the history lists each event");
await page.locator(".trail summary").click();
assert.match(await page.locator(".trail").innerText(), new RegExp(`${userInfo().username} approval`));

step("the plan hook stops without a verdict, and goes on after the approval");
const hook = (plan: string) =>
  spawnSync(process.execPath, [tsx, cli, "plan-review"], {
    input: JSON.stringify({ session_id: "e2e-session", tool_input: { plan } }),
    encoding: "utf8",
    env: { ...env2, HOOP_PLAN_WAIT_SECONDS: "2" },
  });
const stopped = JSON.parse(hook("# Plan\n\n1. Write the export.\n").stdout);
assert.equal(stopped.hookSpecificOutput.permissionDecision, "deny");
const planUrl = stopped.hookSpecificOutput.permissionDecisionReason.match(/http:\/\/localhost:4793\/r\/rv_[a-z0-9]+/)[0];
await page.goto(planUrl);
await page.locator("#finishBtn").click();
await page.getByRole("button", { name: "Submit review" }).click();
await page.getByText(/Review submitted: Approved/).waitFor();
assert.equal(JSON.parse(hook("# Plan\n\n1. Write the export.\n").stdout).hookSpecificOutput.permissionDecision, "allow");

step("Claude asks a quick question; the person answers with one key on its page, and hoop_wait returns the answer");
const ask = await two.call("hoop_ask", {
  questions: [{ question: "Keep the old endpoint?", options: [{ label: "Keep it as an alias", recommended: true }, { label: "Remove it" }] }],
});
const answered = two.call("hoop_wait", { review_id: ask.review_id, after: ask.cursor, seconds: 30 });
await page.goto(ask.url);
await page.locator('[data-q="Q1"][data-choice="A"]').focus();
await page.keyboard.press("2");
const got = await answered;
assert.equal(got.status, "closed");
assert.equal(got.questions[0].answer.label, "Remove it");
await page.reload();
await page.locator(".ask-q .receipt", { hasText: "read this at" }).waitFor();

await browser.close();
await two.client.close();
process.stdout.write("All local steps passed.\n");
