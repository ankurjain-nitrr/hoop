import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { reviewView } from "../src/web.js";
import { parseMarkdown } from "../src/markdown.js";
import { example, tempHome } from "./helpers.js";

test("a new revision keeps earlier threads with the line text they were left on", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  hoop.review(review_id, { verdict: "changes_requested", comments: [{ item: "FR-3", line: 1, body: "use created_at" }] });
  hoop.receive(review_id);
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

test("approval freezes the review and writes nothing into the repository", () => {
  const repo = tempHome();
  process.env.HOOP_REPO_DIR = repo;
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(example());
  hoop.review(review_id, { verdict: "approved", summary: "go", reviewer: "ankur" });
  const fb = hoop.feedback(review_id);
  assert.equal(fb.status === "reviewed" && fb.approved, true);
  assert.equal(existsSync(join(repo, "decisions")), false);
  assert.equal("decision_files" in fb, false);
  assert.throws(() => hoop.review(review_id, { verdict: "comment" }), /approved and frozen/);
});

test("submitting against an approved review starts a new review that supersedes it", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const first = hoop.submit(example());
  hoop.review(first.review_id, { verdict: "approved" });
  hoop.receive(first.review_id);
  const next = hoop.submit({ ...example(), review_id: first.review_id, title: "Order export: requirements v2" });
  assert.notEqual(next.review_id, first.review_id);
  assert.equal(next.revision, 1);
  assert.equal(next.supersedes, first.review_id);
  assert.equal(hoop.store.meta(first.review_id).revisions, 1);
});

test("each submit states its outcome and the review to use next, and a superseded review points ahead", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const first = hoop.submit(example());
  assert.deepEqual([first.outcome, first.next_review_id], ["created", first.review_id]);
  const revised = hoop.submit({ ...example(), review_id: first.review_id });
  assert.deepEqual([revised.outcome, revised.next_review_id, revised.revision], ["revised", first.review_id, 2]);
  hoop.review(first.review_id, { verdict: "approved" });
  hoop.receive(first.review_id);
  const next = hoop.submit({ ...example(), review_id: first.review_id });
  assert.deepEqual([next.outcome, next.next_review_id], ["superseded", next.review_id]);
  assert.notEqual(next.review_id, first.review_id);
  assert.equal(hoop.feedback(first.review_id).superseded_by, next.review_id);
  assert.equal(hoop.feedback(next.review_id).superseded_by, undefined);
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
  hoop.receive(review_id);
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

test("a revision's view carries earlier answers only to questions that are unchanged", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const md = (q2: string) =>
    `# Plan\n\n## Question: Which store?\n\n- A. Files (recommended)\n- B. SQLite\n\n## Question: ${q2}\n\n- A. Now\n- B. Later (recommended)\n`;
  const { review_id } = hoop.submit(parseMarkdown(md("When do we ship?")));
  hoop.review(review_id, {
    verdict: "changes_requested",
    answers: [
      { item: "S-1", choice: "b" },
      { item: "S-2", choice: "a" },
    ],
  });
  hoop.receive(review_id);
  hoop.submit({ ...parseMarkdown(md("Who ships it?")), review_id });
  assert.equal(hoop.store.revision(review_id).items[1]!.id, "S-2");
  assert.deepEqual(reviewView(hoop, review_id).carried, [{ item: "S-1", choice: "b" }]);
  // An answer on the revision itself takes the place of the carried one.
  hoop.review(review_id, {
    verdict: "comment",
    answers: [
      { item: "S-1", choice: "a" },
      { item: "S-2", choice: "b" },
    ],
  });
  assert.deepEqual(reviewView(hoop, review_id).carried, []);
});
