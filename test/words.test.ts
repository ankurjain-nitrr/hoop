import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// The design language's voice rule (docs/DESIGN-LANGUAGE.md, Words) over the pages' own source: a
// string a page shows only for a moment (a toast, an announcement, an error) never says "the agent".
// Comments may: they are for people reading the code. test/pages.test.ts checks what pages render.
const WEB = new URL("../web/", import.meta.url);

/** The source with its comments blanked out. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test('no page\'s source says "the agent" outside its comments', () => {
  const found: string[] = [];
  for (const name of readdirSync(WEB).filter((n) => n.endsWith(".js"))) {
    code(readFileSync(new URL(name, WEB), "utf8"))
      .split("\n")
      .forEach((line, i) => {
        if (/\b(?:the|an)\s+agents?\b/i.test(line)) found.push(`web/${name}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
  }
  assert.deepEqual(found, []);
});
