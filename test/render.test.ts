import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateReview, type ReviewDoc } from "../src/contract.js";
import { readCheckboxAnswers, renderMarkdown, renderPrBody } from "../src/render.js";

const doc = (validateReview(JSON.parse(readFileSync(new URL("../examples/order-export.json", import.meta.url), "utf8"))) as { ok: true; value: ReviewDoc }).value;

test("rendering is deterministic", () => {
  assert.equal(renderMarkdown(doc, 2).markdown, renderMarkdown(structuredClone(doc), 2).markdown);
});

test("every item line starts with its id and maps back through lineMap", () => {
  const { markdown, lineMap } = renderMarkdown(doc, 1);
  const lines = markdown.split("\n");
  const refs = Object.entries(lineMap);
  assert.equal(refs.length, 3 + 2 + 2 + 3);
  for (const [n, ref] of refs) assert.ok(lines[Number(n) - 1]!.startsWith(`${ref.item} · `), lines[Number(n) - 1]);
  const fr3 = refs.find(([, r]) => r.item === "FR-3" && r.line === 1)!;
  assert.match(lines[Number(fr3[0]) - 1]!, /created in that range/);
});

test("the PR body has a checkbox per choice and round-trips ticked answers", () => {
  const body = renderPrBody(doc, 1, { "Q-1": "b" });
  assert.match(body, /- \[ \] `Q-1:a` The existing in-memory list/);
  assert.match(body, /- \[x\] `Q-1:b` A new Postgres orders table/);
  assert.deepEqual(readCheckboxAnswers(body), { "Q-1": "b" });
  assert.deepEqual(readCheckboxAnswers(renderPrBody(doc, 1)), {});
});
