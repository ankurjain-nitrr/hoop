import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { itemLines, validateFeedback, validateReview, type ReviewDoc } from "../src/contract.js";

const example = JSON.parse(readFileSync(new URL("../examples/order-export.json", import.meta.url), "utf8"));
const doc = (validateReview(example) as { ok: true; value: ReviewDoc }).value;
const feedback = (over: object = {}) => ({
  schema: "hoop/feedback@0",
  review_id: "rv_1",
  revision: 1,
  verdict: "comment",
  reviewer: "ankur",
  at: "2026-10-13T10:00:00Z",
  ...over,
});

test("the example review document is valid", () => {
  assert.equal(validateReview(example).ok, true);
});

test("invalid documents return errors naming the field", () => {
  const bad = { ...example, slug: "Not A Slug", items: [{ ...example.items[0], type: "wish" }] };
  const r = validateReview(bad);
  assert.equal(r.ok, false);
  const paths = !r.ok ? r.errors.map((e) => e.path) : [];
  assert.ok(paths.includes("slug"), paths.join());
  assert.ok(paths.includes("items.0.type"), paths.join());
});

test("duplicate ids, questions without choices and unknown dependencies are rejected", () => {
  const items = [
    { id: "FR-1", type: "requirement", title: "a" },
    { id: "FR-1", type: "requirement", title: "b", depends_on: ["FR-9"] },
    { id: "Q-1", type: "question", title: "c" },
  ];
  const r = validateReview({ ...example, items });
  assert.equal(r.ok, false);
  const paths = !r.ok ? r.errors.map((e) => e.path) : [];
  assert.deepEqual(paths.sort(), ["items.1.depends_on.0", "items.1.id", "items.2.choices"]);
});

test("item lines are body lines, choices for questions, then the check", () => {
  assert.deepEqual(itemLines(doc.items[0]!).length, 3);
  assert.equal(itemLines(doc.items[0]!)[2], "Check: integration test streams 100k rows with flat memory");
  assert.deepEqual(itemLines(doc.items[3]!), [
    "Where should orders be read from?",
    "a) The existing in-memory list",
    "b) A new Postgres orders table with a migration (recommended)",
  ]);
});

test("feedback with a partial-text comment and an answer is valid", () => {
  const text = itemLines(doc.items[2]!)[0]!;
  const start = text.indexOf("created");
  const r = validateFeedback(
    feedback({
      comments: [{ item: "FR-3", line: 1, range: { start, end: start + 7, quote: "created" }, body: "use updated_at?" }],
      answers: [{ item: "Q-1", choice: "b" }],
    }),
    doc,
  );
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("a comment without a body or suggestion is rejected", () => {
  const r = validateFeedback(feedback({ comments: [{ item: "FR-1", line: 1 }] }), doc);
  assert.deepEqual(!r.ok && r.errors.map((e) => e.path), ["comments.0.body"]);
});

test("feedback pointing at missing items, lines, choices or text is rejected", () => {
  const r = validateFeedback(
    feedback({
      comments: [
        { item: "FR-9", line: 1, body: "x" },
        { item: "FR-1", line: 9, body: "x" },
        { item: "FR-3", line: 1, range: { start: 0, end: 4, quote: "nope" }, body: "x" },
      ],
      answers: [{ item: "Q-1", choice: "z" }],
    }),
    doc,
  );
  assert.deepEqual(!r.ok && r.errors.map((e) => e.path), ["comments.0.item", "comments.1.line", "comments.2.range.quote", "answers.0"]);
});

test("comments can sit on a heading (line 0) or on the title and TL;DR (DOC 1 and 2)", async () => {
  const { anchorText, scopeOf, inScope } = await import("../src/contract.js");
  assert.equal(anchorText(doc, "FR-3", 0), "Date range filter");
  assert.equal(anchorText(doc, "DOC", 1), doc.title);
  assert.equal(anchorText(doc, "DOC", 2), doc.tldr);
  assert.equal(anchorText(doc, "DOC", 3), undefined);
  const start = doc.title.indexOf("requirements");
  const r = validateFeedback(
    feedback({
      comments: [
        { item: "FR-3", line: 0, body: "split this section" },
        { item: "DOC", line: 1, range: { start, end: start + 12, quote: "requirements" }, body: "call it a spec" },
        { item: "DOC", line: 2, body: "shorter" },
      ],
    }),
    doc,
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  const bad = validateFeedback(feedback({ comments: [{ item: "DOC", line: 3, body: "x" }] }), doc);
  assert.deepEqual(!bad.ok && bad.errors.map((e) => e.path), ["comments.0.line"]);
  assert.deepEqual(scopeOf({ item: "DOC", line: 2 }), { kind: "document" });
  assert.deepEqual(scopeOf({ item: "FR-3", line: 0 }), { kind: "section", item: "FR-3" });
  assert.equal(inScope(scopeOf({ item: "FR-3", line: 0 }), { item: "FR-3", line: 2 }), true);
  assert.equal(inScope(scopeOf({ item: "FR-3", line: 0 }), { item: "FR-1", line: 1 }), false);
  assert.equal(inScope(scopeOf({ item: "FR-3", line: 1 }), { item: "FR-3", line: 2 }), false);
  assert.equal(inScope(scopeOf({ item: "DOC", line: 1 }), { item: "FR-1", line: 2 }), true);
});

test("DOC is reserved and can't be an item id", () => {
  const r = validateReview({ ...example, items: [{ id: "DOC", type: "note", title: "x" }] });
  assert.deepEqual(!r.ok && r.errors.map((e) => e.path), ["items.0.id"]);
});
