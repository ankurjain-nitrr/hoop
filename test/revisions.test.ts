import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { reviewView } from "../src/web.js";
import { example, tempHome } from "./helpers.js";

test("a new revision keeps earlier threads with the line text they were left on", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  hoop.review(review_id, { verdict: "changes_requested", comments: [{ item: "FR-3", line: 1, body: "use created_at" }] });
  const rev2 = example();
  rev2.items[2].body = "When from or to are given, the system shall include only orders created at or after from and before to.";
  hoop.submit({ ...rev2, review_id });
  const view = reviewView(hoop, review_id);
  assert.equal(view.meta.revisions, 2);
  assert.match(view.history[1]!["FR-3"]![0]!, /created in that range/);
  assert.notEqual(view.history[1]!["FR-3"]![0], view.doc.items[2]!.lines[0]);
  const thread = view.feedback[0]!.comments[0]!.thread!;
  // A reply on the old thread is accepted even though its anchor changed.
  hoop.review(review_id, { verdict: "comment", comments: [{ thread, item: "FR-3", line: 1, body: "thanks" }] });
  assert.equal(hoop.store.feedback(review_id, 2).length, 1);
});

test("approval freezes the review and writes decisions/<slug>.json and .md to the repo", () => {
  const repo = tempHome();
  process.env.HOOP_REPO_DIR = repo;
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  hoop.review(review_id, { verdict: "approved", summary: "go", reviewer: "ankur" });
  const fb = hoop.feedback(review_id);
  assert.equal(fb.status === "reviewed" && fb.approved, true);
  const json = join(repo, "decisions", "order-export-requirements.json");
  const md = join(repo, "decisions", "order-export-requirements.md");
  assert.deepEqual(fb.status === "reviewed" && fb.decision_files, [json, md]);
  const decision = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(decision.approved.by, "ankur");
  assert.equal(decision.revision, 1);
  assert.ok(existsSync(md) && readFileSync(md, "utf8").includes("FR-1 · When a client calls GET /orders/export"));
  assert.throws(() => hoop.review(review_id, { verdict: "comment" }), /approved and frozen/);
});

test("submitting against an approved review starts a new review that supersedes it", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const first = hoop.submit(example());
  hoop.review(first.review_id, { verdict: "approved" });
  const next = hoop.submit({ ...example(), review_id: first.review_id, title: "Order export: requirements v2" });
  assert.notEqual(next.review_id, first.review_id);
  assert.equal(next.revision, 1);
  assert.equal(next.supersedes, first.review_id);
  assert.equal(hoop.store.meta(first.review_id).revisions, 1);
});
