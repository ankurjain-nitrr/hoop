import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { editable, existing, thread, threadIds } from "../src/rules.js";
import { slugify } from "../src/util.js";
import { example, tempHome } from "./helpers.js";

test("editable refuses an approved review", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.submit(example());
  assert.throws(() => existing(hoop.store, "rv_nope"), /no review rv_nope/);
  assert.equal(editable(hoop.store, id).id, id);
  hoop.store.update(id, { status: "approved" });
  assert.throws(() => editable(hoop.store, id), new RegExp(`review ${id} is approved and frozen$`));
});

test("thread finds a thread's first comment, its revision and every entry in order", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.submit(example());
  const first = hoop.review(id, {
    verdict: "comment",
    comments: [
      { item: "FR-1", line: 1, body: "Why?" },
      { item: "FR-2", line: 1, body: "Other" },
    ],
  });
  const t = first.comments[0]!.thread!;
  hoop.submit({ ...example(), review_id: id });
  hoop.review(id, { verdict: "comment", comments: [{ thread: t, item: "FR-1", line: 1, body: "Still?", suggestion: "x" }] });
  const found = thread(hoop.store, id, t)!;
  assert.equal(found.root.body, "Why?");
  assert.equal(found.revision, 1);
  assert.deepEqual(
    found.entries.map((e) => [e.comment.body, e.revision]),
    [
      ["Why?", 1],
      ["Still?", 2],
    ],
  );
  assert.equal(thread(hoop.store, id, "th_none_1"), undefined);
  assert.equal(threadIds(hoop.store, id).size, 2);
});

test("slugify keeps each caller's limits, so no slug changes", () => {
  const long = "A very long title that keeps going past the limit of forty characters here";
  assert.equal(slugify(long, { max: 40, fallback: "change", trimEnd: true }), "a-very-long-title-that-keeps-going-past");
  assert.equal(slugify(long, { max: 60, fallback: "document" }), "a-very-long-title-that-keeps-going-past-the-limit-of-forty-c");
  assert.equal(slugify("Cut here at-", { max: 11, fallback: "d" }), "cut-here-at");
  assert.equal(slugify("ab cd", { max: 3, fallback: "d" }), "ab-", "without trimEnd a hyphen at the cut stays, as before");
  assert.equal(slugify("!!!", { max: 40, fallback: "change" }), "change");
});

test("a suggestion on a reply applies at the thread's anchor, with the reply's text range and revision", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.submit(example());
  const fb = hoop.review(id, { verdict: "comment", comments: [{ item: "FR-3", line: 1, range: { start: 0, end: 4, quote: "When" }, body: "Wording?" }] });
  const t = fb.comments[0]!.thread!;
  hoop.submit({ ...example(), review_id: id });
  // The reply names another item and line; the thread's root anchor must win.
  hoop.review(id, {
    verdict: "comment",
    comments: [{ thread: t, item: "FR-1", line: 2, range: { start: 64, end: 71, quote: "created" }, suggestion: "placed" }],
  });
  hoop.applySuggestion(id, t);
  assert.equal(hoop.store.revision(id).items[2]!.body, "When from or to are given, the system shall include only orders placed in that range.");
});

test("review, apply and propose refuse an approved review", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.submit(example());
  const t = hoop.review(id, { verdict: "comment", comments: [{ item: "FR-3", line: 1, body: "x", suggestion: "y" }] }).comments[0]!.thread!;
  hoop.store.update(id, { status: "approved" });
  assert.throws(() => hoop.applySuggestion(id, t), /is approved and frozen/);
  assert.throws(() => hoop.proposeEdits(id, t, []), /is approved and frozen/);
  assert.throws(() => hoop.review(id, { verdict: "comment" }), /is approved and frozen/);
});
