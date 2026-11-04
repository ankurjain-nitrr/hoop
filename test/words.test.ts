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
    /\btoLocale(?:Time|Date)?String\b|\bIntl\.(?:DateTimeFormat|RelativeTimeFormat)\b|\/\s*(?:1000|60_?000|3_?600_?000|1e3|6e4|3\.6e6)\b|\.get(?:UTC)?(?:Hours|Minutes|Seconds)\(/;
  assert.deepEqual(
    webSourceLines(own).filter((line) => !line.startsWith("web/activity.js:")),
    [],
  );
});

// Who's speaking: the person's own sent comments, replies and answers say "You" on the pages; only
// `sentBy` in web/app.js reads a feedback's `reviewer`, to name a session that commented.
test("no page's source labels the person's feedback with its reviewer name, outside sentBy", () => {
  assert.deepEqual(
    webSourceLines(/\.reviewer\b/).filter((l) => !/^web\/app\.js:\d+: export const sentBy = /.test(l)),
    [],
  );
});

// Disclosures (docs/DESIGN-LANGUAGE.md): every fold is the chevron button web/fold.js draws, so no
// page writes a native details element or a chevron of its own, and a fold's count is written by
// `foldCount` ("History 3"), never in parentheses after a name.
test("no page's source draws a disclosure or writes a fold's count outside web/fold.js", () => {
  assert.deepEqual(webSourceLines(/<details\b|<summary\b|[▸▾▶▼►]/), []);
  assert.deepEqual(
    webSourceLines(/class="count"/).filter((l) => !l.startsWith("web/fold.js:")),
    [],
  );
  // Any count in parentheses: a length, a count, `n`. A tab's count ("Changes since rev 2 (3)") and the
  // tab title's ("(2) hoop") aren't folds, and keep theirs.
  const counts = /\(\$\{[^}]*(?:\.length|\bcount\b|Count\(\)|\bn\b|\.size)[^}]*\}\)/;
  const notFolds = [/^web\/app\.js:\d+: <button class="tab" role="tab" id="tab-changes"/, /^web\/pending\.js:\d+: return n > 0 \? `\(\$\{n\}\) \$\{bare\}`/];
  assert.deepEqual(
    webSourceLines(counts).filter((l) => !notFolds.some((re) => re.test(l))),
    [],
  );
});
