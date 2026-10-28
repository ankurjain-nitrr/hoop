import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "../src/markdown.js";
import { BROWSER_SKIP, withBrowser } from "./helpers.js";

const DOC = `# Ledger plan

Which ledger work is done.

## Backlog

| ID | Title | Status |
|---|---|---|
| B-1 | Materialize comments | todo |

## Done when

- [x] The ledger page shows the tree.
- [ ] Reviews show the tree.
`;

test("#339 #340: task items show read-only checkboxes and a table's delimiter row draws no dashes; the markdown is unchanged", {
  skip: BROWSER_SKIP,
}, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    await page.goto(`${base}/r/${review_id}`);
    const boxes = page.locator("input.ln-check");
    await boxes.first().waitFor();
    assert.deepEqual(
      await boxes.evaluateAll((els) => els.map((e) => [(e as HTMLInputElement).checked, (e as HTMLInputElement).disabled, e.getAttribute("aria-label")])),
      [
        [true, true, "Done"],
        [false, true, "Not done"],
      ],
    );
    assert.doesNotMatch(await page.locator("#app").innerText(), /\[x\]|\[ \]/, "no literal brackets");
    const delim = page.locator(".md-table tr.tdelim-row");
    assert.equal((await delim.locator(".tdelim").innerText()).trim(), "", "the delimiter draws no dashes");
    assert.match(await delim.locator(".gutter").innerText(), /\d/, "it keeps its line number");
    assert.equal(await delim.locator(".add-btn").count(), 1, "and its comment button");
    assert.equal(hoop.markdownOf(review_id), DOC, "export returns the markdown as written");
  });
});

test("#341: an action the pages don't answer says so in plain words, shows the stopped banner at once and keeps what was typed", {
  skip: BROWSER_SKIP,
}, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown("# Export plan\n\nWhich format ships first.\n"));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator("#finishBtn").waitFor();
    // The pages stop answering: the request never gets a reply.
    await page.route("**/api/reviews/*/feedback", (route) => route.abort("connectionrefused"));
    await page.locator("#finishBtn").click();
    await page.locator("#summary").fill("Ship CSV first.");
    await page.locator("#submitReview").click();
    const error = page.locator("#finishError");
    await error.waitFor();
    assert.equal(await error.innerText(), "hoop's pages aren't answering. Any hoop command or a new session starts them again; then try again.");
    assert.doesNotMatch(await page.locator("body").innerText(), /Failed to fetch/);
    assert.equal(await page.locator("#banner").innerText(), "The pages stopped. Any hoop command or a new session starts them again.");
    assert.equal(await page.locator("#summary").inputValue(), "Ship CSV first.", "what was typed is kept");
  });
});
