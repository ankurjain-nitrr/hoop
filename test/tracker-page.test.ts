import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMarkdown } from "../src/markdown.js";
import { tempHome, BROWSER_SKIP, withBrowser } from "./helpers.js";
import { withServer } from "./web.test.js";

const TRACKER = `# Tracker

Work items.

| ID | Parent | Type | Title | Status | Phase |
|---|---|---|---|---|---|
| E-9 | | epic | An epic | in progress | build |
| ST-1 | E-9 | story | A story | todo | |
| T-1 | ST-1 | task | Write the \`parser\` | todo | |
| S-1 | T-1 | sub-task | A sub-task | done | |
| B-1 | E-9 | bug | A bug | done | |
`;

function repo() {
  const dir = tempHome();
  mkdirSync(join(dir, "docs", "changes", "CR-9-x"), { recursive: true });
  writeFileSync(join(dir, "docs", "TRACKER.md"), TRACKER);
  writeFileSync(join(dir, "docs", "changes", "CR-9-x", "TRACKER.md"), TRACKER);
  process.env.HOOP_REPO_DIR = dir;
  return dir;
}

test("review fixes: the tracker page picks an existing tracker and keeps its file picker on errors", { skip: BROWSER_SKIP }, async () => {
  const dir = tempHome();
  mkdirSync(join(dir, "docs", "changes", "CR-1-x"), { recursive: true });
  writeFileSync(join(dir, "docs", "changes", "CR-1-x", "TRACKER.md"), TRACKER);
  process.env.HOOP_REPO_DIR = dir;
  await withBrowser(async ({ base, page }) => {
    await page.goto(`${base}/tracker`);
    await page.locator("tr.trow").first().waitFor();
    assert.equal(await page.locator("#tracker-file").inputValue(), "docs/changes/CR-1-x/TRACKER.md");
    await page.goto(`${base}/tracker?file=docs/none.md`);
    await page.getByText("no tracker at docs/none.md").waitFor();
    assert.equal(await page.locator("#tracker-file").count(), 1);
  });
});

test("FR-9: the tracker API lists trackers and reads one as a tree; paths stay inside the repository", () =>
  withServer(async (base) => {
    const dir = repo();
    assert.deepEqual(await (await fetch(`${base}/api/trackers`)).json(), ["docs/TRACKER.md", "docs/changes/CR-9-x/TRACKER.md"]);
    const t = await (await fetch(`${base}/api/tracker`)).json();
    assert.deepEqual(
      t.tree.map((n: any) => [n.item.id, n.children.map((c: any) => c.item.id)]),
      [["E-9", ["ST-1", "B-1"]]],
    );
    assert.equal((await (await fetch(`${base}/api/tracker?file=docs/changes/CR-9-x/TRACKER.md`)).json()).items.length, 5);
    const outside = join(tempHome(), "secret.md");
    writeFileSync(outside, "| ID | Parent |\n|---|---|\n");
    symlinkSync(outside, join(dir, "docs", "link.md"));
    for (const [file, why] of [
      ["../../etc/passwd", "not a markdown file"],
      ["../x.md", "no tracker at"],
      ["docs/link.md", "outside the repository"],
      ["docs/none.md", "no tracker at"],
    ]) {
      const res = await fetch(`${base}/api/tracker?file=${encodeURIComponent(file!)}`);
      assert.equal(res.status, 400, file);
      assert.match((await res.json()).error, new RegExp(why!), file);
    }
    assert.equal((await fetch(`${base}/tracker`)).headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal((await fetch(`${base}/tree.js`)).status, 200);
  }));

test("FR-9, FR-10: the tracker page collapses and filters; a tracker review shows the tree with commentable rows", { skip: BROWSER_SKIP }, async () => {
  repo();
  await withBrowser(async ({ hoop, base, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/tracker`);
    const ids = () => page.locator("tr.trow").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.treeId));
    await page.locator("tr.trow").first().waitFor();
    assert.deepEqual(await ids(), ["E-9", "ST-1", "T-1", "S-1", "B-1"]);
    assert.equal(await page.locator('tr[data-tree-id="T-1"] code').textContent(), "parser");
    await page.getByRole("button", { name: "Collapse ST-1" }).click();
    assert.deepEqual(await ids(), ["E-9", "ST-1", "B-1"]);
    await page.getByRole("button", { name: "Expand ST-1" }).click();
    await page.getByLabel("Status").selectOption("done");
    assert.deepEqual(await ids(), ["E-9", "ST-1", "T-1", "S-1", "B-1"], "ancestors of matches stay");
    await page.getByLabel("Type").selectOption("bug");
    assert.deepEqual(await ids(), ["E-9", "B-1"]);

    // A review of the tracker: rows render as the tree and each keeps its line anchor.
    const { review_id } = await hoop.submitAny(parseMarkdown(TRACKER));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator("tr.trow").first().waitFor();
    assert.equal(await page.locator("tr.trow").count(), 5);
    await page.locator('tr[data-tree-id="T-1"]').hover();
    await page.getByRole("button", { name: /Comment on .* line 6/ }).click();
    await page.locator("#cbody").fill("Split this task.");
    await page.getByRole("button", { name: "Start a review" }).click();
    await page.getByRole("button", { name: "Collapse E-9" }).click();
    await page.getByRole("button", { name: "Expand E-9" }).click();
    assert.match(await page.locator("tr.tafter").innerText(), /Split this task/);
    await page.getByRole("button", { name: /Finish your review/ }).click();
    await page.locator("#v-comment").check();
    await page.getByRole("button", { name: "Submit review" }).click();
    await page
      .getByText(/Review submitted|commented/)
      .first()
      .waitFor();
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
  });
});

test("FR-4: the tracker page formats item text through the line renderer", { skip: BROWSER_SKIP }, async () => {
  const dir = tempHome();
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(
    join(dir, "docs", "TRACKER.md"),
    "# Tracker\n\n| ID | Parent | Type | Title | Status |\n|---|---|---|---|---|\n| T-1 | | task | Fix **the parser** and read [the notes](https://example.com) \\| now. | todo |\n\n## Items\n\n### T-1: Fix the parser.\n\nA description block with **its own** words.\n",
  );
  process.env.HOOP_REPO_DIR = dir;
  await withBrowser(async ({ base, page }) => {
    await page.goto(`${base}/tracker`);
    const row = page.locator('tr[data-tree-id="T-1"]');
    await row.waitFor();
    assert.equal(await row.locator("strong").innerText(), "the parser");
    assert.equal(await row.locator('a[href="https://example.com"]').innerText(), "the notes");
    assert.match(await row.innerText(), /Fix the parser and read the notes \| now\./);
    // The tracker page shows no description block.
    assert.doesNotMatch(await page.locator("#app").innerText(), /description block/);
  });
});
