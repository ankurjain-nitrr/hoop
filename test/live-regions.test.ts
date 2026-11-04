import { test } from "node:test";
import assert from "node:assert/strict";
import { BROWSER_SKIP, webSources, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";

// docs/DESIGN-LANGUAGE.md, Live region: one hidden status region per page, written through
// `announce()` (web/frame.js), for a change with no visible message. A toast announces itself, and an
// error line is an alert. No other element is a live region.

/**
 * Each live region the pages' source makes, as "web/file.js:line: what": an element with a status,
 * alert or log role, a role set to one of them, or aria-live.
 */
function liveRegions(): string[] {
  const live =
    /<[a-z]+\b[^<>]*?\brole=\\?["'](?:status|alert|log)\\?["'][^<>]*?>|setAttribute\(\s*["']role["']\s*,\s*["'](?:status|alert|log)["']\)|aria-live[^>]*?>?/g;
  return webSources().flatMap(({ name, text }) => [...text.matchAll(live)].map((m) => `${name}:${text.slice(0, m.index).split("\n").length}: ${m[0]}`));
}

/** The live regions a page may make, by what they are. */
const ALLOWED: [RegExp, string][] = [
  [/^web\/frame\.js:\d+: setAttribute\("role", "status"\)$/, "the one status region, which announce() makes"],
  [/^web\/review\.js:\d+: <div class="toast" role="status">$/, "the review page's toast, which says something succeeded out of view"],
  [/^web\/index\.html:\d+: setAttribute\("role", "alert"\)$/, "the error a page that couldn't start shows"],
  // Error lines: red text under the control that failed (Errors), each styled as one.
  [/^web\/[a-z-]+\.js:\d+: <(?:p|span|ul) [^>]*class="[^"]*\b(?:error|berr|steer-error|rename-error|warn|empty)\b[^"]*"[^>]*role="alert"/, "an error line"],
];

test("no page makes a live region of its own: the one status region is announce()'s, besides the toast and error lines", () => {
  const found = liveRegions();
  assert.ok(found.length > 10, "the scan finds the error lines");
  assert.deepEqual(
    found.filter((r) => !ALLOWED.some(([ok]) => ok.test(r))),
    [],
  );
});

test(
  "the review page has one status region besides its toast, and a new revision, a part hint and a verdict change are said in it",
  { skip: BROWSER_SKIP },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const { review_id } = hoop.submit(parseMarkdown("# Plan\n\nWhy we move.\n\n## Steps\n\n- Copy.\n\n- Check.\n"));
      await page.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 200 }));
      await page.goto(`${base}/r/${review_id}`);
      await page.locator(".top h1").waitFor();
      const said = (text: string) =>
        page
          .waitForFunction((t) => document.querySelector("#page-live")?.textContent === t, text, { timeout: 5000 })
          .then(
            () => true,
            () => false,
          );
      // Adding a comment swaps the verdict, and the live region says so.
      await page.getByRole("button", { name: 'Comment on "Steps" line 1' }).click();
      await page.locator("#cpart").fill("Copy");
      assert.ok(await said("Found in this line."), "the part hint is said");
      await page.locator("#cbody").fill("Which bucket?");
      await page.locator("#addComment").click();
      assert.ok(await said("Now Request changes: 1 new comment"), "the verdict change is said");
      // Claude submits a revision while the page is open.
      hoop.receive(review_id);
      hoop.submit({ ...parseMarkdown("# Plan\n\nWhy we move.\n\n## Steps\n\n- Copy all.\n"), review_id });
      assert.ok(await said("Revision 2 is ready. Show it is in the header."), "the new revision is said");
      const regions = await page.evaluate(() => [...document.querySelectorAll('[role="status"], [aria-live]')].map((el) => el.id || el.className));
      assert.deepEqual(regions, ["page-live"]);
    }),
);
