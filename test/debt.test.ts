import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCounts, compare, cruiseCounts, dependenciesChanged, jscpdCounts, knipCounts, lintCounts, suppressionCount, typeCounts } from "../scripts/debt.js";

test("the debt check fails a count higher than the base's, and reports one lower", () => {
  assert.deepEqual(compare({ cyclicImports: 3, unusedExports: 5, looselyTyped: 9 }, { cyclicImports: 4, unusedExports: 5, looselyTyped: 7 }), {
    worse: ["cyclicImports: 3 → 4"],
    better: ["looselyTyped: 9 → 7"],
  });
});

test("the debt ratchet fails a count it couldn't read, rather than passing it", () => {
  assert.throws(() => checkCounts({ looselyTyped: Number.NaN }), /looselyTyped/);
  assert.throws(() => checkCounts({ duplicatedLines: undefined as unknown as number }), /duplicatedLines/);
  assert.deepEqual(checkCounts({ cyclicImports: 0 }), { cyclicImports: 0 });
});

test("knip's issue lists are grouped into the counts, and an unknown list fails", () => {
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

test("the base gets its own node_modules when the change touches the dependencies", () => {
  assert.equal(dependenciesChanged(["src/work.ts"]), false);
  assert.equal(dependenciesChanged(["package-lock.json"]), true);
  assert.equal(dependenciesChanged(["package.json"]), true);
});
