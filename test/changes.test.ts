import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { parseMarkdown } from "../src/markdown.js";
import { reviewView } from "../src/web.js";
import { BROWSER_SKIP, example, tempHome, withBrowser } from "./helpers.js";

const md = (sections: string[]) => ["# Billing migration", "", "We move billing to the new ledger.", "", ...sections].join("\n");
const PLAN = "## Plan\n\nMove accounts in batches.\n\n- Small accounts first\n- Large accounts last\n";
const RISKS = "## Risks\n\nDouble charges.\n";
const ROLLOUT = "## Rollout\n\nOne region at a time.\n";

const start = () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(parseMarkdown(md([PLAN, RISKS, ROLLOUT])));
  return { hoop, review_id };
};

test("a revision's result lists the sections hoop found modified, added and removed, with lines in each", () => {
  const { hoop, review_id } = start();
  const plan = "## Plan\n\nMove accounts in batches of 500.\n\n- Small accounts first\n- Large accounts last\n";
  const result = hoop.submit({ ...parseMarkdown(md([plan, ROLLOUT, "## Support\n\nA rota for the first week.\n\n- Two people a day\n"])), review_id }, 1);
  const c = result.changes!;
  assert.equal(c.since_revision, 1);
  assert.deepEqual(c.modified, [{ section: "S-1", title: "Plan", lines_added: 1, lines_removed: 1 }]);
  assert.deepEqual(c.added, [{ section: "S-4", title: "Support", lines_added: 2, lines_removed: 0 }]);
  // A section dropped from a full resend shows, though the agent never said it removed it.
  assert.deepEqual(c.removed, [{ section: "S-2", title: "Risks", lines_added: 0, lines_removed: 1 }]);
  assert.equal(c.unchanged, 2);
  assert.equal(c.document, undefined);
  assert.equal(
    c.summary,
    'Since revision 1: 1 section modified: S-1 "Plan" (+1 −1); 1 section added: S-4 "Support" (+2 −0); 1 section removed: S-2 "Risks" (+0 −1).',
  );
});

test("a renamed section and a changed title show, and a resend of the same text reports nothing changed", () => {
  const { hoop, review_id } = start();
  const same = hoop.submit({ ...parseMarkdown(md([PLAN, RISKS, ROLLOUT])), review_id }, 1);
  assert.deepEqual([same.changes!.modified, same.changes!.added, same.changes!.removed, same.changes!.unchanged], [[], [], [], 4]);
  assert.equal(same.changes!.summary, "Nothing changed since revision 1.");
  const renamed = md([PLAN, "## Risks and mitigations\n\nDouble charges.\n", ROLLOUT]).replace("# Billing migration", "# Ledger migration");
  const c = hoop.submit({ ...parseMarkdown(renamed), review_id }, 2).changes!;
  assert.equal(c.since_revision, 2);
  assert.deepEqual(c.modified, [{ section: "S-2", title: "Risks and mitigations", lines_added: 0, lines_removed: 0, renamed_from: "Risks" }]);
  assert.deepEqual(c.document, ["title"]);
});

test("a decision document's revision reports its changed items too", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const rev2 = example();
  rev2.items[2]!.body = "When from or to are given, the system shall include only orders created at or after from.";
  hoop.receive(review_id);
  const c = hoop.submit({ ...rev2, review_id }, 1).changes!;
  assert.deepEqual(
    c.modified.map((m) => m.section),
    ["FR-3"],
  );
});

test("the Changes tab compares with the last revision a person reviewed, not just the one before", () => {
  const { hoop, review_id } = start();
  assert.equal(reviewView(hoop, review_id).previous, undefined);
  hoop.submit({ ...parseMarkdown(md([PLAN, RISKS])), review_id }, 1);
  // With no review yet, it compares with the revision before.
  assert.deepEqual([reviewView(hoop, review_id).previous?.revision, reviewView(hoop, review_id).previous?.reviewed], [1, undefined]);
  hoop.review(review_id, { verdict: "changes_requested", summary: "Keep going", reviewer: "ankur" });
  hoop.receive(review_id);
  hoop.submit({ ...parseMarkdown(md([PLAN])), review_id }, 2);
  hoop.submit({ ...parseMarkdown(md([PLAN, ROLLOUT])), review_id }, 3);
  const view = reviewView(hoop, review_id);
  assert.deepEqual([view.previous?.revision, view.previous?.reviewed], [2, true]);
  assert.deepEqual(
    view.previous?.items.map((i) => i.title),
    ["Introduction", "Plan", "Risks"],
  );
});

test("the Changes tab names the reviewed revision and lists the sections removed since", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(md([PLAN, RISKS, ROLLOUT])));
    hoop.review(review_id, { verdict: "changes_requested", summary: "Keep going", reviewer: "ankur" });
    hoop.receive(review_id);
    hoop.submit({ ...parseMarkdown(md([PLAN, RISKS])), review_id }, 1);
    hoop.submit({ ...parseMarkdown(md([PLAN.replace("batches", "batches of 500"), RISKS])), review_id }, 2);
    await page.goto(`${base}/r/${review_id}`);
    await page.getByRole("tab", { name: "Changes since your review of rev 1 (2)" }).click();
    assert.equal(await page.locator(".removed-sections").innerText(), "Removed: Rollout");
    assert.equal(await page.locator(".items .item").count(), 1);
  });
});
