import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { editable, existing, thread, threadIds } from "../src/rules.js";
import { slugify } from "../src/util.js";
import { example, tempHome } from "./helpers.js";

test("editable refuses closed, approved and GitHub reviews with each caller's wording", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.submit(example());
  assert.throws(() => existing(hoop.store, "rv_nope"), /no review rv_nope/);
  assert.equal(editable(hoop.store, id, { open: true }).id, id);
  hoop.store.update(id, { github: { repo: "a/b", pr: 1, branch: "x", url: "https://x/1" } });
  assert.throws(() => editable(hoop.store, id, { open: true, github: (m) => `review ${m.id} is on GitHub at ${m.github!.url}` }), /is on GitHub at https:\/\/x\/1/);
  hoop.store.update(id, { github: undefined, status: "approved" });
  assert.throws(() => editable(hoop.store, id, { open: true }), new RegExp(`review ${id} is approved$`));
  assert.throws(() => editable(hoop.store, id, { frozen: true }), /is approved and frozen/);
  hoop.store.update(id, { status: "closed" });
  assert.equal(editable(hoop.store, id, { frozen: true }).status, "closed", "frozen refuses only approved reviews");
});

test("thread finds a thread's first comment, its revision and every entry in order", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.submit(example());
  const first = hoop.review(id, { verdict: "comment", comments: [{ item: "FR-1", line: 1, body: "Why?" }, { item: "FR-2", line: 1, body: "Other" }] });
  const t = first.comments[0]!.thread!;
  hoop.submit({ ...example(), review_id: id });
  hoop.review(id, { verdict: "comment", comments: [{ thread: t, item: "FR-1", line: 1, body: "Still?", suggestion: "x" }] });
  const found = thread(hoop.store, id, t)!;
  assert.equal(found.root.body, "Why?");
  assert.equal(found.revision, 1);
  assert.deepEqual(found.entries.map((e) => [e.comment.body, e.revision]), [["Why?", 1], ["Still?", 2]]);
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
