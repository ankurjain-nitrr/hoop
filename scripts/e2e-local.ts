// Live end-to-end run of the local channel: `hoop mcp` (with its review pages), a reviewer in
// Chrome, `hoop wait` in the background, then approval writing decisions/. Needs Node 20+ and Chrome.
// Usage: npx tsx scripts/e2e-local.ts
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";

const root = new URL("..", import.meta.url).pathname;
const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
const cli = join(root, "src/cli.ts");
const chrome = process.env.HOOP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const repoDir = mkdtempSync(join(tmpdir(), "hoop-e2e-repo-"));
const env = { ...(process.env as Record<string, string>), HOOP_HOME: mkdtempSync(join(tmpdir(), "hoop-e2e-home-")), HOOP_REPO_DIR: repoDir, HOOP_PORT: "4791" };
const step = (s: string) => process.stdout.write(`• ${s}\n`);

const client = new Client({ name: "hoop-e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp"], env }));
const call = async (name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const value = JSON.parse(res.content[0]!.text);
  if (res.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return value;
};
const waitFor = (id: string) => {
  const child = spawn(process.execPath, [tsx, cli, "wait", id, "--timeout", "120"], { env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  return new Promise<any>((resolve, reject) => child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`hoop wait exited ${code}`)))));
};

step("Claude submits over MCP; the MCP process serves the review page");
const doc = JSON.parse(readFileSync(join(root, "examples/order-export.json"), "utf8"));
const sub = await call("hoop_submit", { document: doc });
assert.equal(sub.url, `http://localhost:4791/r/${sub.review_id}`);
const waiting = waitFor(sub.review_id);

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
await page.goto(sub.url);
await page.getByText("Export all orders as CSV").first().waitFor();

step("the reviewer comments on selected text, answers and requests changes");
await page.locator('[data-sel-item="FR-3"][data-sel-line="0"]').evaluate((el) => {
  const node = el.firstChild!, at = node.textContent!.indexOf("created");
  const r = document.createRange();
  r.setStart(node, at); r.setEnd(node, at + 7);
  getSelection()!.removeAllRanges(); getSelection()!.addRange(r);
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
});
await page.getByRole("button", { name: "Comment on selection" }).click();
await page.locator("#cbody").fill("Inclusive bounds?");
await page.getByRole("button", { name: "Start a review" }).click();
await page.locator("#q-Q-1-b").check();
await page.getByRole("button", { name: /Finish your review/ }).click();
await page.locator("#v-changes").check();
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
await call("hoop_submit", { document: { ...doc, review_id: sub.review_id } });
const approving = waitFor(sub.review_id);
await page.goto(sub.url);
await page.locator("#item-FR-3 .thread.outdated").waitFor();

step("the reviewer approves; decisions/ is written for Claude to commit");
await page.getByRole("button", { name: /Finish your review/ }).click();
await page.locator("#v-approve").check();
await page.getByRole("button", { name: "Submit review" }).click();
const approved = await approving;
assert.equal(approved.approved, true);
for (const f of approved.decision_files) assert.ok(existsSync(f), f);
assert.equal(JSON.parse(readFileSync(join(repoDir, "decisions/order-export-requirements.json"), "utf8")).revision, 2);
assert.equal((await call("hoop_feedback", { review_id: sub.review_id })).approved, true);

await browser.close();
await client.close();
process.stdout.write("All local channel steps passed.\n");
