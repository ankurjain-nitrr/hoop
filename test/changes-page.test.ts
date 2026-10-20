import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Changes } from "../src/changes.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { readTracker } from "../src/tracker.js";
import { changeList, createWebServer } from "../src/web.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

const TRACKER = `# Tracker

| ID | Parent | Type | Title | Status | Project |
|---|---|---|---|---|---|
| E-1 | | epic | Ship export. | in progress | |
| T-1 | E-1 | task | Add the route. | todo | api |
| T-2 | E-1 | task | Add the page. | todo | |
| CR-4 | | epic | An old change row. | done | |

## Items

### E-1: Ship export.

Users export orders as CSV.

Definition of done:
- [x] The route works.
- [ ] The page works.

### T-1: Add the route.

What is expected:
- A route.
`;

function repoWith(changes = true) {
  const repo = tempHome();
  mkdirSync(join(repo, "docs", "changes"), { recursive: true });
  writeFileSync(join(repo, "docs", "TRACKER.md"), TRACKER);
  if (changes) {
    const c = new Changes(repo);
    const a = c.create("Export orders.\n", { type: "story", reason: "one capability", project: "api" });
    c.create("Fix the footer.\n", { type: "bug", reason: "small", kind: "non-functional" });
    mkdirSync(join(repo, "docs", "changes", "CR-1-export-orders"), { recursive: true });
    writeFileSync(
      join(repo, "docs", "changes", "CR-1-export-orders", "TRACKER.md"),
      "| ID | Parent | Type | Title | Size |\n|---|---|---|---|---|\n| CR-1 | | epic | Export. | |\n| T-1 | CR-1 | task | A. | 40 files, 2000 lines |\n| T-2 | CR-1 | task | B. | ~12 files, ~600 lines |\n| T-3 | CR-1 | task | C. | 3 PRs |\n",
    );
    assert.equal(a.id, "CR-1");
  }
  return repo;
}

test("FR-88, FR-89, FR-96: tracker items carry their blocks, counts, flags and projects, and change rows read as legacy", () => {
  const repo = repoWith(false);
  const t = readTracker(join(repo, "docs", "TRACKER.md"));
  assert.deepEqual(t.blocks["E-1"] && [t.blocks["E-1"].has_description, t.blocks["E-1"].has_dod, t.blocks["E-1"].met, t.blocks["E-1"].points], [
    true,
    true,
    1,
    2,
  ]);
  assert.deepEqual(t.blocks["T-1"] && [t.blocks["T-1"].has_description, t.blocks["T-1"].has_dod], [false, false]);
  assert.equal(t.blocks["T-2"], undefined);
  const name = repo.split("/").pop();
  assert.deepEqual(
    t.items.map((i) => [i.id, i.project, Boolean(i.legacy_change)]),
    [
      ["E-1", name, false],
      ["T-1", "api", false],
      ["T-2", name, false],
      ["CR-4", name, true],
    ],
  );
});

test("FR-94, FR-95, FR-96, FR-98: a change's history, size, kind and project, and a project move only while queued", async () => {
  const repo = repoWith();
  const c = new Changes(repo);
  const name = repo.split("/").pop();
  assert.deepEqual([c.get("CR-1").kind, c.get("CR-1").project, c.get("CR-2").kind, c.get("CR-2").project], ["functional", "api", "non-functional", name]);
  // A record from before kinds and projects reads with defaults.
  const dir = join(repo, "docs", "changes", "CR-3-old");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "change.json"),
    JSON.stringify({ id: "CR-3", slug: "old", title: "old", type: "task", reason: "r", created: "", steps: [], reviews: {}, prs: [] }),
  );
  assert.deepEqual([c.get("CR-3").kind, c.get("CR-3").project, c.get("CR-3").history], ["functional", name, []]);

  c.record("CR-1", { event: "pickup", verdict: "proceed", note: "Nothing merged since capture overlaps it.", by: "claude" });
  assert.deepEqual(
    c.get("CR-1").history.map((h) => [h.event, h.verdict, h.note]),
    [["pickup", "proceed", "Nothing merged since capture overlaps it."]],
  );
  assert.throws(() => c.record("CR-1", { event: "lunch" }), /unknown event lunch/);

  const size = c.size("CR-1");
  assert.deepEqual([size.files, size.lines, size.flagged, size.unknown, size.kept], [52, 2600, true, ["T-3"], false]);
  c.record("CR-1", { event: "size", verdict: "keep", note: "One pull request, at the requester's choice." });
  assert.equal(c.size("CR-1").kept, true);

  c.classify("CR-2", "bug", "small", { project: "web" });
  assert.equal(c.get("CR-2").project, "web");
  await c.moveStep("CR-2", "prd");
  assert.throws(
    () => c.classify("CR-2", "bug", "small", { project: "api" }),
    /CR-2 is at prd, so it can't move to another project; only a queued change moves/,
  );
});

test("FR-92, FR-97: the change list links each change by names in the repository, and reviews carry their project", async () => {
  const repo = repoWith();
  const home = tempHome();
  process.env.HOOP_REPO_DIR = repo;
  const hoop = new Hoop(new Store(home));
  await hoop.submitAny({ ...(await import("../src/markdown.js")).parseMarkdown("# PRD\n\nThe problem.\n", {}) }, { change: { cr: "CR-1", doc: "prd" } });
  const list = changeList(hoop, repo);
  const cr1 = list.find((c) => c.id === "CR-1")!;
  assert.equal(cr1.request, "docs/changes/CR-1-export-orders/REQUEST.md");
  assert.equal(cr1.group, "in progress");
  assert.match(cr1.documents[0]!.review_id!, /^rv_/);
  assert.equal(list.find((c) => c.id === "CR-2")!.group, "queued");
  assert.equal(JSON.stringify(list).includes(repo), false, "no folder path reaches the page");
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const reviews = await (await fetch(`${base}/api/reviews`)).json();
    assert.deepEqual(
      reviews.map((r: { project: string }) => r.project),
      ["api"],
    );
  } finally {
    server.close();
  }
});

test("FR-92, FR-95, FR-97, FR-132: the change request page groups changes, shows the size flag, filters by project, and has an empty state", {
  skip: BROWSER_SKIP,
}, async () => {
  const repo = repoWith();
  process.env.HOOP_REPO_DIR = repo;
  new Changes(repo).record("CR-1", { event: "size", verdict: "keep", note: "One pull request." });
  await withBrowser(async ({ base, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/changes`);
    await page.locator("#cr-CR-1").waitFor();
    assert.deepEqual(await page.locator(".group h2").evaluateAll((hs) => hs.map((h) => h.textContent)), ["Queued 2"]);
    assert.match(await page.locator("#cr-CR-1").innerText(), /Over devloop's limit[\s\S]*The requester chose to keep it whole/);
    assert.match(await page.locator("#cr-CR-1").innerText(), /docs\/changes\/CR-1-export-orders\/REQUEST\.md/);
    await page.getByLabel("Project").selectOption("api");
    assert.equal(await page.locator(".cr").count(), 1);
    assert.deepEqual(errors, []);
  });
  process.env.HOOP_REPO_DIR = tempHome();
  await withBrowser(async ({ base, page }) => {
    await page.goto(`${base}/changes`);
    await page.getByText(/No change requests in this repository yet/).waitFor();
  });
});

test("FR-88, FR-89, FR-97, FR-135: the tracker page opens a block with its count, flags items without one, and filters by project", {
  skip: BROWSER_SKIP,
}, async () => {
  process.env.HOOP_REPO_DIR = repoWith(false);
  await withBrowser(async ({ base, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/tracker`);
    await page.locator('tr[data-tree-id="E-1"]').waitFor();
    assert.match(await page.locator('tr[data-tree-id="E-1"]').innerText(), /1 of 2/);
    assert.match(await page.locator('tr[data-tree-id="T-1"]').innerText(), /No description[\s\S]*No definition of done/);
    assert.match(await page.locator('tr[data-tree-id="T-2"]').innerText(), /No block/);
    await page.getByRole("button", { name: "Show the block of E-1" }).click();
    assert.match(await page.locator(".tblock").first().innerText(), /Users export orders as CSV/);
    await page.getByRole("button", { name: "Show the block of T-2" }).click();
    await page.getByText("No definition of done yet.").first().waitFor();
    // The old change row shows apart.
    assert.equal(await page.locator('.legacy tr[data-tree-id="CR-4"]').count(), 1);
    await page.getByLabel("Project").selectOption("api");
    assert.deepEqual(
      await page
        .locator(".tree")
        .first()
        .locator("tr.trow")
        .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.treeId)),
      ["T-1"],
    );
    assert.deepEqual(errors, []);
  });
});

test("FR-91: this repository's own tracker flags nothing: every item has a block with a description and a definition of done", () => {
  const t = readTracker(new URL("../docs/TRACKER.md", import.meta.url).pathname);
  const flagged = t.items.filter((i) => {
    const b = t.blocks[i.id];
    return !b?.has_description || !b.has_dod || i.legacy_change;
  });
  assert.deepEqual(
    flagged.map((i) => i.id),
    [],
  );
});
