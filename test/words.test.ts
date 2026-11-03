import { test } from "node:test";
import assert from "node:assert/strict";
import { webSourceLines } from "./helpers.js";

// The design language's voice rule (docs/DESIGN-LANGUAGE.md, Words) over the pages' own source: a
// string a page shows only for a moment (a toast, an announcement, an error) never says "the agent".
// Comments may: they are for people reading the code. test/pages.test.ts checks what pages render.
test('no page\'s source says "the agent" outside its comments', () => {
  assert.deepEqual(webSourceLines(/\b(?:the|an)\s+agents?\b/i), []);
});
