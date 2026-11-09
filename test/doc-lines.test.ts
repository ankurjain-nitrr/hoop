import { test } from "node:test";
import assert from "node:assert/strict";
import { choiceLine, DOC_LINES, docLineName, docLineText, RECOMMENDED } from "../web/doc-lines.js";
import { anchorText, itemLines } from "../src/contract.js";

const doc = { title: "Ship the export", tldr: "Whether to ship it this week.", subtitle: "Q4 plan" };

test("the document's own lines are its title, TL;DR and subtitle, from line 1", () => {
  assert.deepEqual(
    DOC_LINES.map((l) => l.field),
    ["title", "tldr", "subtitle"],
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((n) => docLineText(doc, n)),
    [undefined, doc.title, doc.tldr, doc.subtitle, undefined],
  );
  assert.deepEqual([1, 2, 3].map(docLineName), ["the title", "the TL;DR", "the subtitle"]);
});

test("a choice reads as its line, with the recommended one marked", () => {
  assert.equal(choiceLine({ id: "A", label: "Keep it" }), "A) Keep it");
  assert.equal(choiceLine({ id: "B", label: "Drop it", recommended: true }), `B) Drop it${RECOMMENDED}`);
  assert.equal(RECOMMENDED, " (recommended)");
});

test("the contract reads DOC lines and choice lines from the same table", () => {
  const review = { ...doc, kind: "doc", items: [] } as unknown as Parameters<typeof anchorText>[0];
  assert.equal(anchorText(review, "DOC", 2), doc.tldr);
  const q = {
    id: "Q1",
    type: "question",
    title: "Which?",
    choices: [
      { id: "A", label: "One", recommended: true },
      { id: "B", label: "Two" },
    ],
  };
  assert.deepEqual(itemLines(q as Parameters<typeof itemLines>[0]), ["Which?", "A) One (recommended)", "B) Two"]);
});
