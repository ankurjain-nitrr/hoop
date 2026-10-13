import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorText, DOC, itemLines, validateReview, type ReviewDoc } from "../src/contract.js";
import { applyEdit, locate, narrow, wordStats } from "../src/edit.js";
import { example } from "./helpers.js";

const doc = (validateReview(example()) as { ok: true; value: ReviewDoc }).value;

/** Every anchor in the document with its text. */
function anchors(d: ReviewDoc) {
  const out: [string, number, string][] = [[DOC, 1, d.title], [DOC, 2, d.tldr]];
  for (const i of d.items) {
    out.push([i.id, 0, i.title]);
    itemLines(i).forEach((t, n) => out.push([i.id, n + 1, t]));
  }
  return out;
}

test("random span edits change only their span: every other anchor stays byte-identical", () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let k = 0; k < 200; k++) {
    const all = anchors(doc);
    const [item, line, text] = all[rand(all.length)]!;
    const prefix = item !== DOC && line > 0 && text.startsWith("Check: ") ? 7 : /^[a-z]\) /.test(text) && line > 0 ? 3 : 0;
    const end = text.endsWith(" (recommended)") ? text.length - 14 : text.length;
    if (end - prefix < 2) continue;
    const a = prefix + rand(end - prefix - 1), b = a + 1 + rand(Math.min(12, end - a - 1));
    const find = text.slice(a, b);
    const replace = ["inclusive", "the team", "", "weekly"][rand(4)]!;
    const { doc: next } = applyEdit(doc, { item, line, find, replace, start: a });
    for (const [i, l, t] of anchors(doc)) {
      const now = anchorText(next, i, l);
      if (i === item && l === line) assert.equal(now, text.slice(0, a) + replace + text.slice(b));
      else assert.equal(now, t, `${i}:${l} changed`);
    }
    assert.deepEqual(next.items.map((i) => i.id), doc.items.map((i) => i.id));
  }
});

test("edits land in the right field: title, TL;DR, heading, body line, option label, check", () => {
  const e = (item: string, line: number, find: string, replace: string) => applyEdit(doc, { item, line, find, replace }).doc;
  assert.equal(e(DOC, 1, "requirements", "spec").title, "Order export: spec");
  assert.match(e(DOC, 2, "Main risk", "Biggest risk").tldr, /Biggest risk: streaming/);
  assert.equal(e("FR-3", 0, "Date range", "Date").items[2]!.title, "Date filter");
  assert.match(e("FR-1", 2, "never buffered in full", "not buffered").items[0]!.body!, /as they are read, not buffered\.$/);
  assert.equal(e("Q-1", 2, "in-memory", "cached").items[3]!.choices![0]!.label, "The existing cached list");
  assert.equal(e("FR-2", 2, "escaping", "quoting").items[1]!.check, "unit tests for quoting edge cases");
});

test("edits that are ambiguous, missing, off-label or add lines are refused", () => {
  assert.throws(() => locate(doc, { item: "FR-1", line: 1, find: "orders", replace: "a" }), /more than once/);
  assert.throws(() => locate(doc, { item: "FR-1", line: 1, find: "nope", replace: "a" }), /is not in FR-1 line 1/);
  assert.throws(() => locate(doc, { item: "FR-1", line: 9, find: "x", replace: "a" }), /no line 9/);
  assert.throws(() => applyEdit(doc, { item: "Q-1", line: 2, find: "a) The", replace: "The" }), /option's label/);
  assert.throws(() => applyEdit(doc, { item: "FR-1", line: 1, find: "all orders", replace: "all\norders" }), /add or remove lines/);
  assert.throws(() => locate(doc, { item: "FR-1", line: 1, find: "orders", replace: "x", start: 0 }), /changed since/);
});

test("word stats count changed words and flag rewrites of more than half a line", () => {
  const line = "When from or to are given, the system shall include only orders created in that range.";
  assert.deepEqual(wordStats("created", "updated", line), { removed: 1, added: 1, line_words: 16, large: false });
  assert.equal(wordStats(line, "Filter orders by creation date between the two bounds, both inclusive.", line).large, true);
});

test("narrow shrinks a whole-line suggestion to the words that differ", () => {
  const text = "When from or to are given, the system shall include only orders created in that range.";
  const n = narrow(text, "When from or to are given, the system shall include orders created within both bounds.");
  assert.equal(text.slice(0, n.start) + n.replace + text.slice(n.start + n.find.length),
    "When from or to are given, the system shall include orders created within both bounds.");
  assert.ok(n.find.length < text.length / 2, n.find);
});
