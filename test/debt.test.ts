import { test } from "node:test";
import assert from "node:assert/strict";
import { ceiling, checkCounts, compare, cruiseCounts, jscpdCounts, knipCounts, lintCounts, raised, suppressionCount, typeCounts } from "../scripts/debt.js";

test("the debt ratchet fails a count that grew, and one new to the baseline", () => {
  assert.deepEqual(compare({ cyclicImports: 3, unusedExports: 5 }, { cyclicImports: 4, unusedExports: 5, nestedTernaries: 1 }), {
    worse: ["cyclicImports: 3 → 4", "nestedTernaries: none → 1"],
    better: [],
  });
});

test("the debt ratchet reports a count that fell, so the baseline records it", () => {
  assert.deepEqual(compare({ cyclicImports: 3, unusedExports: 5 }, { cyclicImports: 2, unusedExports: 5 }), { worse: [], better: ["cyclicImports: 3 → 2"] });
});

test("the debt ratchet fails a count the baseline has but the tools no longer report", () => {
  assert.equal(compare({ looselyTyped: 10, duplicatedLines: 2 }, { looselyTyped: 10 }).worse.length, 1);
});

test("the debt ratchet fails a count it couldn't read, rather than passing it", () => {
  assert.throws(() => checkCounts({ looselyTyped: Number.NaN }), /looselyTyped/);
  assert.throws(() => checkCounts({ duplicatedLines: undefined as unknown as number }), /duplicatedLines/);
  assert.deepEqual(checkCounts({ cyclicImports: 0 }), { cyclicImports: 0 });
});

test("a pull request can't raise the baseline it started from", () => {
  assert.deepEqual(raised({ cyclicImports: 3, unusedExports: 5 }, { cyclicImports: 4, unusedExports: 4, duplicatedLines: 9 }), ["cyclicImports: 3 → 4"]);
});

test("knip's issue lists are grouped into the baseline's counts, and an unknown list fails", () => {
  const issue = {
    file: "src/a.ts",
    owners: [],
    files: [],
    exports: { x: {}, y: {} },
    types: { T: {} },
    namespaceMembers: { n: {} },
    devDependencies: { d: {} },
    unresolved: [{}],
  };
  assert.deepEqual(knipCounts({ issues: [issue, { file: "src/b.ts", files: [{}] }] }), { unusedFiles: 1, unusedExports: 4, dependencyIssues: 2 });
  assert.throws(() => knipCounts({ issues: [{ file: "src/a.ts", newKind: [{}] }] }), /newKind/);
});

test("the other tools' output is read into counts", () => {
  assert.deepEqual(cruiseCounts({ summary: { violations: [{ rule: { name: "no-circular" } }, { rule: { name: "other" } }] } }), { cyclicImports: 1 });
  const lint = {
    diagnostics: [{ category: "lint/style/noNestedTernary" }, { category: "lint/complexity/noExcessiveCognitiveComplexity" }],
  };
  assert.deepEqual(lintCounts(lint), { complexFunctions: 1, nestedTernaries: 1 });
  assert.deepEqual(typeCounts({ totalCount: 10, correctCount: 7 }), { looselyTyped: 3 });
  assert.deepEqual(jscpdCounts({ statistics: { total: { duplicatedLines: 21 } } }), { duplicatedLines: 21 });
});

test("a comment that hides code from the counting tools counts as debt itself", () => {
  const text = [
    "// biome-ignore lint/style/noNestedTernary: x",
    "// type-coverage:ignore-next-line",
    "/* jscpd:ignore-start */",
    "/** @public */",
    "// @ts-expect-error",
    "// nosemgrep: rule",
    "const publicKey = 1; // not a tag",
  ].join("\n");
  assert.equal(suppressionCount(text), 6);
});

test("biome output that isn't a counted rule, such as an unreadable path, fails", () => {
  assert.throws(() => lintCounts({ diagnostics: [{ category: "internalError/io" }] }), /internalError\/io/);
});

test("a pull request may raise the baseline only as far as the base branch measures", () => {
  const top = ceiling({ complexFunctions: 90, looselyTyped: 287 }, { complexFunctions: 92, looselyTyped: 280 });
  assert.deepEqual(top, { complexFunctions: 92, looselyTyped: 287 });
  assert.deepEqual(raised(top, { complexFunctions: 92, looselyTyped: 288 }), ["looselyTyped: 287 → 288"]);
});
