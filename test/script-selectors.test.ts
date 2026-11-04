import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Disclosures (docs/DESIGN-LANGUAGE.md): every page folds with the shared fold button and draws no
// summary or details element (test/words.test.ts checks web/), so a script that selects one waits for
// ever. The acceptance runs in scripts/ run only before a release, so their selectors are checked here.
test("no acceptance script selects a summary or details element, which no page draws", () => {
  const scripts = new URL("../scripts/", import.meta.url);
  // The element, not an ID or class with the word in it, such as the review page's #summary box.
  const selects = /(?:locator|querySelector(?:All)?|\$\$?)\(\s*["'`][^"'`]*(?<![#.\w-])(?:summary|details)(?![\w-])/;
  const found = readdirSync(scripts, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) =>
      readFileSync(new URL(f, scripts), "utf8")
        .split("\n")
        .flatMap((line, i) => (selects.test(line) ? [`scripts/${f}:${i + 1}: ${line.trim()}`] : [])),
    );
  assert.deepEqual(found, []);
});
