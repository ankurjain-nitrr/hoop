import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { BROWSER_SKIP, hasFocus, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";

// #336, Keyboard: the review page's keys, which never act inside a text box.

const DOC =
  "# Launch\n\nWhy this matters.\n\n## Steps\n\nShip on Monday.\n\nThen tell the clients.\n\n## Question: Which day?\n\n- A. Monday (recommended)\n- B. Friday\n";

/** The line the focused control belongs to, as its + names it. */
const focusedLine = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "");

test("on a review page, j and k move between lines, c comments, s suggests and v marks the section viewed", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".top h1").waitFor();
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("j");
    assert.match(await focusedLine(page), /^Comment on the title/, "j from nowhere goes to the first line");
    await page.keyboard.press("j");
    const second = await focusedLine(page);
    assert.notEqual(second, "", "j goes on to the next line");
    await page.keyboard.press("k");
    assert.match(await focusedLine(page), /^Comment on the title/, "k goes back");
    // To the first line of Steps, then comment and suggest there.
    while (!/"Steps" line 1$/.test(await focusedLine(page))) await page.keyboard.press("j");
    await page.keyboard.press("c");
    await page.locator("#cbody").waitFor();
    assert.ok(await hasFocus(page.locator("#cbody"), 2000), "c opens the comment box on the line");
    // Typing in the box types; no key acts there.
    await page.keyboard.type("jk cv");
    assert.equal(await page.locator("#cbody").inputValue(), "jk cv");
    await page.keyboard.press("Escape");
    await page.keyboard.press("s");
    await page.locator("#csugg").waitFor();
    assert.match(await page.locator("#csugg").inputValue(), /Ship on Monday\./, "s opens the line's text to suggest a change");
    await page.keyboard.press("Escape");
    await page.keyboard.press("v");
    assert.equal(await page.locator("#viewed-S-1").isChecked(), true, "v marks the line's section viewed");
  }),
);

test("on a review page, 1 to 4 and g answer the Question section focus is in", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".top h1").waitFor();
    await page.getByRole("button", { name: /^Comment on "Question: Which day\?" line 2/ }).focus();
    await page.keyboard.press("2");
    assert.equal(await page.locator('input[data-q="S-2"][value="b"]').isChecked(), true, "2 picks the second option");
    await page.keyboard.press("g");
    assert.equal(await page.locator('input[data-q="S-2"][value="a"]').isChecked(), true, "g picks the recommended one");
    // Approve has no key.
    await page.keyboard.press("A");
    assert.equal(await page.locator("#finishPop").isVisible(), false, "no key opens the verdict");
  }),
);

test("on a review page, n and p move between open conversations, and a and x accept or reject Claude's change on the line", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    const [first, second] = hoop.review(review_id, {
      verdict: "changes_requested",
      reviewer: "ana",
      comments: [
        { item: "S-1", line: 1, body: "Which Monday?" },
        { item: "S-1", line: 2, body: "Shorter." },
      ],
    }).comments;
    hoop.receive(review_id);
    hoop.proposeEdits(review_id, second!.thread!, [{ item: "S-1", line: 2, find: "Then tell", replace: "Tell" }]);
    void first;
    await page.goto(`${base}/r/${review_id}`);
    await page.locator("[data-accept]").waitFor();
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("n");
    const one = await page.evaluate(() => document.activeElement?.closest(".thread")?.textContent ?? "");
    assert.match(one, /Which Monday\?/, "n goes to the first open conversation");
    await page.keyboard.press("n");
    assert.match(await page.evaluate(() => document.activeElement?.closest(".thread")?.textContent ?? ""), /Shorter\./, "n goes to the next");
    await page.keyboard.press("p");
    assert.match(await page.evaluate(() => document.activeElement?.closest(".thread")?.textContent ?? ""), /Which Monday\?/, "p goes back");
    // On the line Claude changed, x rejects its change.
    await page.getByRole("button", { name: /^Comment on "Steps" line 2$/ }).focus();
    const rejected = page.waitForRequest((r) => r.method() === "POST" && /\/edits\//.test(r.url()));
    await page.keyboard.press("x");
    assert.match((await rejected).postData() ?? "", /"reject"/, "x rejects Claude's change on the line");
  }),
);
