import { test } from "node:test";
import assert from "node:assert/strict";
import { webSourceLines } from "./helpers.js";

// The design language's voice rule (docs/DESIGN-LANGUAGE.md, Words) over the pages' own source: a
// string a page shows only for a moment (a toast, an announcement, an error) never says "the agent".
// Comments may: they are for people reading the code. test/pages.test.ts checks what pages render.
test('no page\'s source says "the agent" outside its comments', () => {
  assert.deepEqual(webSourceLines(/\b(?:the|an)\s+agents?\b/i), []);
});

// Who's speaking: a review the person opened from a file reads "Opened by you" on every page, never
// with a name filled in (the operating system's account name).
test('no page\'s source fills a name into "Opened by"', () => {
  assert.deepEqual(webSourceLines(/Opened by \$\{/), []);
});

// Who's speaking: the person's own sent comments, replies and answers say "You" on the pages; only
// `sentBy` in web/app.js reads a feedback's `reviewer`, to name a session that commented.
test("no page's source labels the person's feedback with its reviewer name, outside sentBy", () => {
  assert.deepEqual(
    webSourceLines(/\.reviewer\b/).filter((l) => !/^web\/app\.js:\d+: export const sentBy = /.test(l)),
    [],
  );
});
