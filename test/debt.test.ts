import { test } from "node:test";
import assert from "node:assert/strict";
import { compare } from "../scripts/debt.js";

test("the debt ratchet fails a count that grew, and one new to the baseline", () => {
  assert.deepEqual(compare({ importCycles: 3, unusedExports: 5 }, { importCycles: 4, unusedExports: 5, nestedTernaries: 1 }), {
    worse: ["importCycles: 3 → 4", "nestedTernaries: none → 1"],
    better: [],
  });
});

test("the debt ratchet reports a count that fell, so the baseline records it", () => {
  assert.deepEqual(compare({ importCycles: 3, unusedExports: 5 }, { importCycles: 2, unusedExports: 5 }), { worse: [], better: ["importCycles: 3 → 2"] });
});
