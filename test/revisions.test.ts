import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decisionNames, Hoop } from "../src/hoop.js";
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
  // FR-65: the files are named in the repository, never by folder path.
  assert.deepEqual(fb.status === "reviewed" && fb.decision_files, ["decisions/order-export-requirements.json", "decisions/order-export-requirements.md"]);
  assert.ok(existsSync(md));
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

test("FR-63, FR-64: each submit states its outcome and the review to use next, and a superseded review points ahead", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const first = hoop.submit(example());
  assert.deepEqual([first.outcome, first.next_review_id], ["created", first.review_id]);
  const revised = hoop.submit({ ...example(), review_id: first.review_id });
  assert.deepEqual([revised.outcome, revised.next_review_id, revised.revision], ["revised", first.review_id, 2]);
  hoop.review(first.review_id, { verdict: "approved" });
  const next = hoop.submit({ ...example(), review_id: first.review_id });
  assert.deepEqual([next.outcome, next.next_review_id], ["superseded", next.review_id]);
  assert.notEqual(next.review_id, first.review_id);
  assert.equal(hoop.feedback(first.review_id).superseded_by, next.review_id);
  assert.equal(hoop.feedback(next.review_id).superseded_by, undefined);
});

test("FR-65: an older review's absolute decision paths read as names in the repository", () => {
  assert.deepEqual(decisionNames({ repo_dir: "/work/repo", decision_files: ["/work/repo/decisions/a.json", "decisions/b.md", "/elsewhere/c.md"] }), [
    "decisions/a.json",
    "decisions/b.md",
    "decisions/c.md",
  ]);
});

test("applying a suggestion makes a new revision with only that span changed, and marks the thread", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const line = "When from or to are given, the system shall include only orders created in that range.";
  const start = line.indexOf("created");
  const fb = hoop.review(review_id, {
    verdict: "comment",
    comments: [
      { item: "FR-3", line: 1, range: { start, end: start + 7, quote: "created" }, suggestion: "placed" },
      { item: "FR-1", line: 2, suggestion: "Rows shall stream to the client as they are read." },
    ],
  });
  const [t1, t2] = fb.comments.map((c) => c.thread!);
  const r1 = hoop.applySuggestion(review_id, t1!, "ankur");
  assert.equal(r1.revision, 2);
  assert.deepEqual(r1.words, { removed: 1, added: 1, line_words: 16, large: false });
  assert.equal(hoop.store.revision(review_id).items[2]!.body, line.replace("created", "placed"));
  const r2 = hoop.applySuggestion(review_id, t2!);
  assert.equal(r2.applied.find, "read, never buffered in full.");
  assert.equal(r2.applied.replace, "read.");
  const after = hoop.store.revision(review_id);
  assert.equal(after.items[0]!.body!.split("\n")[1], "Rows shall stream to the client as they are read.");
  assert.equal(after.items[1]!.body, example().items[1].body);
  assert.deepEqual(
    hoop.store.applied(review_id).map((a) => [a.thread, a.revision]),
    [
      [t1, 2],
      [t2, 3],
    ],
  );
  assert.throws(() => hoop.applySuggestion(review_id, t1!), /already applied/);
  const res = hoop.feedback(review_id);
  assert.equal(res.status, "pending"); // rev 3 has no review yet, but Claude still sees what was applied
  assert.equal(res.applied?.length, 2);
});

test("a suggestion on text that has changed since is refused", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const t = hoop.review(review_id, { verdict: "comment", comments: [{ item: "FR-2", line: 1, suggestion: "x" }] }).comments[0]!.thread!;
  const rev2 = example();
  rev2.items[1].body = "Each row shall contain the order fields.";
  hoop.submit({ ...rev2, review_id });
  assert.throws(() => hoop.applySuggestion(review_id, t), /has changed/);
});

test("a suggestion identical to the current text is refused", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  const t = hoop.review(review_id, { verdict: "comment", comments: [{ item: "FR-2", line: 1, suggestion: example().items[1].body }] }).comments[0]!.thread!;
  assert.throws(() => hoop.applySuggestion(review_id, t), /matches the current text/);
  assert.equal(hoop.store.meta(review_id).revisions, 1);
});
