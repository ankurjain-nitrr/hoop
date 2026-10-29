import { test } from "node:test";
import assert from "node:assert/strict";
import { childId, childPattern, idPattern, isReviewId, newId, nextSeq, reviewOfChild } from "../src/ids.js";

test("isReviewId takes only rv_ and lowercase letters and digits", () => {
  for (const id of ["rv_abc123", "rv_0"]) assert.equal(isReviewId(id), true, id);
  for (const id of ["rv_", "rv_ABC", "rv_a-b", "xrv_a", "rv_a\n", "th_a_1", 7, undefined]) assert.equal(isReviewId(id), false, String(id));
});

test("newId keeps the format of the IDs it replaces", () => {
  assert.match(newId("rv"), /^rv_[a-z0-9]+[0-9a-f]{6}$/);
  assert.equal(isReviewId(newId("rv")), true);
  assert.notEqual(newId("ch"), newId("ch"));
});

test("a child ID embeds its review's ID, and gives it back for the kinds asked", () => {
  assert.equal(childId("th", "rv_abc", 3), "th_abc_3");
  assert.equal(childId("ed", "rv_abc", 1), "ed_abc_1");
  assert.equal(reviewOfChild("th_abc_3", ["th"]), "rv_abc");
  assert.equal(reviewOfChild("bt_abc_2", ["th", "bt"]), "rv_abc");
  assert.equal(reviewOfChild("bt_abc_2", ["th"]), undefined);
  assert.equal(reviewOfChild("th_abc", ["th"]), undefined);
  assert.equal(reviewOfChild("th_ABC_1", ["th"]), undefined);
  assert.throws(() => childId("th", "abc", 1), /invalid review id/);
  assert.throws(() => childId("bt", "th_x_1", 2), /invalid review id/);
});

test("the ID patterns match what newId and childId make, and nothing looser", () => {
  const edit = new RegExp(`^${childPattern("ed")}$`);
  assert.equal(edit.test(childId("ed", newId("rv"), 12)), true);
  for (const bad of ["ed___", "ed_a_b_c", "ed_a", "th_a_1"]) assert.equal(edit.test(bad), false, bad);
  assert.equal(new RegExp(`^${idPattern("st")}$`).test(newId("st")), true);
});

test("nextSeq is one more than the largest trailing number", () => {
  assert.equal(nextSeq([]), 1);
  assert.equal(nextSeq(["bt_a_1", "bt_a_7", "bt_a_3"]), 8);
  assert.equal(nextSeq(["g2", "g10"]), 11);
  assert.equal(nextSeq(["odd"]), 1);
});
