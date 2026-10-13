// Live end-to-end run for a non-engineering document with comments materialized in place:
// Claude submits a policy as markdown, the reviewer applies a suggestion and leaves a section-wide
// instruction, Claude answers it with span edits, the reviewer accepts them as tracked changes,
// approves, and the exported markdown differs from the original only where comments asked.
// Needs Node 20+ and Chrome. Usage: npx tsx scripts/e2e-docs.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";

const root = new URL("..", import.meta.url).pathname;
const chrome = process.env.HOOP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const env = { ...(process.env as Record<string, string>), HOOP_HOME: mkdtempSync(join(tmpdir(), "hoop-docs-")), HOOP_REPO_DIR: mkdtempSync(join(tmpdir(), "hoop-docs-repo-")), HOOP_PORT: "4793" };
const step = (s: string) => process.stdout.write(`• ${s}\n`);
const POLICY = `# Remote work policy

Employees may work remotely up to three days a week, with their manager's agreement.

## Eligibility

All permanent staff are eligible after their probation period.

- Contractors follow their contract.
- Interns work on site.

## Equipment

The company provides a laptop and one monitor. Staff must keep company equipment secure at all times.
`;

const client = new Client({ name: "hoop-e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/cli.ts"), "mcp"], env }));
const call = async (name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const value = JSON.parse(res.content[0]!.text);
  if (res.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return value;
};

step("Claude submits a policy document as markdown");
const sub = await call("hoop_submit_markdown", { markdown: POLICY });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
await page.goto(sub.url);
await page.getByText("Remote work policy").first().waitFor();

step("the reviewer suggests 'two' for 'three' and asks the Equipment section to sound less strict");
await page.locator('[data-sel-item="S-0"][data-sel-line="0"]').evaluate((el) => {
  const node = el.firstChild!, at = node.textContent!.indexOf("three");
  const r = document.createRange();
  r.setStart(node, at); r.setEnd(node, at + 5);
  getSelection()!.removeAllRanges(); getSelection()!.addRange(r);
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
});
await page.getByRole("button", { name: "Comment on selection" }).click();
await page.getByRole("button", { name: "Suggest a change" }).click();
await page.locator("#csugg").fill("two");
await page.getByRole("button", { name: "Start a review" }).click();
await page.locator("#item-S-2 .item-head").hover();
await page.getByRole("button", { name: "Comment on S-2 heading (applies to the whole section)" }).click();
await page.locator("#cbody").fill("Sound less strict: no 'must' or 'at all times'.");
await page.getByRole("button", { name: "Add review comment" }).click();
await page.getByRole("button", { name: /Finish your review/ }).click();
await page.getByRole("button", { name: "Submit review" }).click();
await page.getByText(/Review submitted/).waitFor();

step("the reviewer applies the suggestion in place");
await page.getByRole("button", { name: "Apply suggestion" }).click();
await page.getByText("rev 2 · ").first().waitFor();

step("Claude reads the instruction and proposes minimal span edits for that section");
const fb = await call("hoop_feedback", { review_id: sub.review_id });
assert.deepEqual(fb.applied.map((x: { kind: string }) => x.kind), ["suggestion"]);
// The instruction thread is on the S-2 heading (line 0) in rev 1's review.
const view = await (await fetch(`${sub.url.replace("/r/", "/api/reviews/")}`)).json();
const s2 = view.feedback.flatMap((f: any) => f.comments).find((c: any) => c.item === "S-2" && c.line === 0);
const proposed = await call("hoop_propose_edits", {
  review_id: sub.review_id, thread: s2.thread, note: "Softer wording, same meaning",
  edits: [{ item: "S-2", line: 1, find: "Staff must keep company equipment secure at all times.", replace: "Please keep company equipment secure." }],
});
assert.equal(proposed.proposals.length, 1);

step("the reviewer sees a tracked change, accepts it, and approves");
await page.reload();
await page.locator("del.tc-del").first().waitFor();
await page.getByRole("button", { name: "Accept", exact: true }).click();
await page.getByText("rev 3 · ").first().waitFor();
await page.getByRole("button", { name: /Finish your review/ }).click();
await page.locator("#v-approve").check();
await page.getByRole("button", { name: "Submit review" }).click();
await page.getByText(/Review submitted: Approved/).waitFor();

step("the exported document differs from the original only where comments asked");
const out = await call("hoop_export", { review_id: sub.review_id });
const expected = POLICY.replace("three days", "two days").replace("Staff must keep company equipment secure at all times.", "Please keep company equipment secure.");
assert.equal(out.markdown, expected);
assert.equal(out.status, "approved");
const done = await call("hoop_feedback", { review_id: sub.review_id });
assert.deepEqual(done.applied.map((a: any) => a.kind), ["suggestion", "edit"]);

await browser.close();
await client.close();
process.stdout.write("All document steps passed.\n");
