import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { parseMarkdown } from "../src/markdown.js";
import { createWebServer } from "../src/web.js";
import { tempHome } from "./helpers.js";
import { withServer } from "./web.test.js";

const CHROME = process.env.HOOP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SKIP = Number(process.versions.node.split(".")[0]) < 20 ? "browser test needs Node 20+" : !existsSync(CHROME) ? "Chrome not found (set HOOP_CHROME)" : false;

const TRACKER = `# Tracker

Work items.

| ID | Parent | Type | Title | Status | Phase |
|---|---|---|---|---|---|
| CR-9 | | epic | An epic | in progress | build |
| ST-1 | CR-9 | story | A story | todo | |
| T-1 | ST-1 | task | Write the \`parser\` | todo | |
| S-1 | T-1 | sub-task | A sub-task | done | |
| B-1 | CR-9 | bug | A bug | done | |
`;

function repo() {
  const dir = tempHome();
  mkdirSync(join(dir, "docs", "changes", "CR-9-x"), { recursive: true });
  writeFileSync(join(dir, "docs", "TRACKER.md"), TRACKER);
  writeFileSync(join(dir, "docs", "changes", "CR-9-x", "TRACKER.md"), TRACKER);
  process.env.HOOP_REPO_DIR = dir;
  return dir;
}

test("review fixes: the tracker page picks an existing tracker and keeps its file picker on errors", { skip: SKIP }, async () => {
  const dir = tempHome();
  mkdirSync(join(dir, "docs", "changes", "CR-1-x"), { recursive: true });
  writeFileSync(join(dir, "docs", "changes", "CR-1-x", "TRACKER.md"), TRACKER);
  process.env.HOOP_REPO_DIR = dir;
  const server = createWebServer(new Hoop(new Store(tempHome())));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/tracker`);
    await page.locator("tr.trow").first().waitFor();
    assert.equal(await page.locator("#tracker-file").inputValue(), "docs/changes/CR-1-x/TRACKER.md");
    await page.goto(`${base}/tracker?file=docs/none.md`);
    await page.getByText("no tracker at docs/none.md").waitFor();
    assert.equal(await page.locator("#tracker-file").count(), 1);
  } finally {
    await browser.close();
    server.close();
  }
});

test("FR-9: the tracker API lists trackers and reads one as a tree; paths stay inside the repository", () =>
  withServer(async (base) => {
    const dir = repo();
    assert.deepEqual(await (await fetch(`${base}/api/trackers`)).json(), ["docs/TRACKER.md", "docs/changes/CR-9-x/TRACKER.md"]);
    const t = await (await fetch(`${base}/api/tracker`)).json();
    assert.deepEqual(t.tree.map((n: any) => [n.item.id, n.children.map((c: any) => c.item.id)]), [["CR-9", ["ST-1", "B-1"]]]);
    assert.equal((await (await fetch(`${base}/api/tracker?file=docs/changes/CR-9-x/TRACKER.md`)).json()).items.length, 5);
    const outside = join(tempHome(), "secret.md");
    writeFileSync(outside, "| ID | Parent |\n|---|---|\n");
    symlinkSync(outside, join(dir, "docs", "link.md"));
    for (const [file, why] of [["../../etc/passwd", "not a markdown file"], ["../x.md", "no tracker at"], ["docs/link.md", "outside the repository"], ["docs/none.md", "no tracker at"]]) {
      const res = await fetch(`${base}/api/tracker?file=${encodeURIComponent(file!)}`);
      assert.equal(res.status, 400, file);
      assert.match((await res.json()).error, new RegExp(why!), file);
    }
    assert.equal((await fetch(`${base}/tracker`)).headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal((await fetch(`${base}/tree.js`)).status, 200);
  }));

test("FR-9, FR-10: the tracker page collapses and filters; a tracker review shows the tree with commentable rows", { skip: SKIP }, async () => {
  repo();
  const hoop = new Hoop(new Store(tempHome()));
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/tracker`);
    const ids = () => page.locator("tr.trow").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.treeId));
    await page.locator("tr.trow").first().waitFor();
    assert.deepEqual(await ids(), ["CR-9", "ST-1", "T-1", "S-1", "B-1"]);
    assert.equal(await page.locator('tr[data-tree-id="T-1"] code').textContent(), "parser");
    await page.getByRole("button", { name: "Collapse ST-1" }).click();
    assert.deepEqual(await ids(), ["CR-9", "ST-1", "B-1"]);
    await page.getByRole("button", { name: "Expand ST-1" }).click();
    await page.getByLabel("Status").selectOption("done");
    assert.deepEqual(await ids(), ["CR-9", "ST-1", "T-1", "S-1", "B-1"], "ancestors of matches stay");
    await page.getByLabel("Type").selectOption("bug");
    assert.deepEqual(await ids(), ["CR-9", "B-1"]);

    // A review of the tracker: rows render as the tree and each keeps its line anchor.
    const { review_id } = await hoop.submitAny(parseMarkdown(TRACKER));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator("tr.trow").first().waitFor();
    assert.equal(await page.locator("tr.trow").count(), 5);
    await page.locator('tr[data-tree-id="T-1"]').hover();
    await page.getByRole("button", { name: /Comment on .* line 6/ }).click();
    await page.locator("#cbody").fill("Split this task.");
    await page.getByRole("button", { name: "Start a review" }).click();
    await page.getByRole("button", { name: "Collapse CR-9" }).click();
    await page.getByRole("button", { name: "Expand CR-9" }).click();
    assert.match(await page.locator("tr.tafter").innerText(), /Split this task/);
    await page.getByRole("button", { name: /Finish your review/ }).click();
    await page.locator("#v-comment").check();
    await page.getByRole("button", { name: "Submit review" }).click();
    await page.getByText(/Review submitted|commented/).first().waitFor();
    const fb = hoop.feedback(review_id);
    assert.equal(fb.status, "reviewed");
    const c = fb.status === "reviewed" ? fb.feedback[0]!.comments[0]! : undefined;
    assert.deepEqual([c?.line, c?.body], [6, "Split this task."]);
    // The comment's row stays visible, with its full line, when its parent is collapsed.
    await page.getByRole("button", { name: "Collapse ST-1" }).click();
    assert.equal(await page.locator('tr[data-tree-id="T-1"]').count(), 1);
    assert.equal(await page.locator('tr[data-tree-id="S-1"]').count(), 0);
    assert.match(await page.locator("tr.tafter").innerText(), /Split this task/);

    // A comment on the header line (not a tree row) shows above the tree.
    await page.getByRole("button", { name: "Show as lines" }).click();
    assert.equal(await page.locator("tr.trow").count(), 0);
    await page.locator('[data-sel-item="S-0"][data-sel-line="3"]').hover();
    await page.getByRole("button", { name: /Comment on .* line 4/ }).click();
    await page.locator("#cbody").fill("Add a Due column.");
    await page.getByRole("button", { name: "Start a review" }).click();
    await page.getByRole("button", { name: "Show as tree" }).click();
    assert.match(await page.locator(".item").innerText(), /Add a Due column/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
