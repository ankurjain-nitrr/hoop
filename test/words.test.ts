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

// Times: one shared formatter writes every time a page shows (`readAt`) and one every duration
// (`span`), both in web/activity.js, so no other page formats a time or a duration itself: no
// locale date formatting, and no milliseconds turned into seconds or minutes.
test("no page formats a time or a duration itself, outside the shared formatters", () => {
  const own =
    /\btoLocale(?:Time|Date)?String\b|\bIntl\.(?:DateTimeFormat|RelativeTimeFormat)\b|\/\s*(?:1000|60_?000|3_?600_?000|1e3|6e4|3\.6e6)\b|\.get(?:Hours|Minutes|Seconds)\(/;
  assert.deepEqual(
    webSourceLines(own).filter((line) => !line.startsWith("web/activity.js:")),
    [],
  );
});
