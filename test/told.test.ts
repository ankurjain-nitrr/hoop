import { test } from "node:test";
import assert from "node:assert/strict";
import { tell, TOLD_MAX, toldIn, withTold } from "../src/told.js";

test("the ledger adds told keys at the end and keeps the latest", () => {
  assert.deepEqual(withTold(["a"], ["b", "c"]), ["a", "b", "c"]);
  const many = Array.from({ length: TOLD_MAX }, (_, i) => `k${i}`);
  assert.deepEqual(withTold(many, ["new"]), [...many.slice(1), "new"], "the oldest key goes");
  assert.deepEqual(withTold(["a", "b"], ["a"]), ["a", "b", "a"], "a key told again stays where it was too");
  assert.deepEqual(withTold(["a", "b"], ["a"], true), ["b", "a"], "with move, it counts as told just now");
});

test("a record's told list is read only when it is a list, and telling writes it back", () => {
  const r: Record<string, unknown> = { stop_told: "not a list", done_told: ["x"] };
  assert.deepEqual(toldIn(r, "stop_told"), []);
  assert.deepEqual(toldIn(r, "queue_told"), []);
  tell(r, "stop_told", ["change:c1"]);
  tell(r, "done_told", ["y"]);
  assert.deepEqual(r.stop_told, ["change:c1"]);
  assert.deepEqual(r.done_told, ["x", "y"]);
});
