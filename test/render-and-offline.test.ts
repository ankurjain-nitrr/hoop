import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "../src/markdown.js";
import type { Route } from "playwright-core";
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
    const header = (await page.locator(".md-table tr.tline").first().boundingBox())!.height;
    assert.ok((await delim.boundingBox())!.height < header / 2, "the delimiter is a thin rule, not a row");
    assert.equal(hoop.markdownOf(review_id), DOC, "export returns the markdown as written");
  });
});

test("#341: an action the pages don't answer says so in plain words, the banner shows once the pages are found stopped and clears when they answer, and what was typed stays", {
  skip: BROWSER_SKIP,
}, async () => {
  await withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown("# Export plan\n\nWhich format ships first.\n"));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator("#finishBtn").waitFor();
    // The pages stop answering: neither the action nor the check gets a reply.
    const down = (route: Route) => route.abort("connectionrefused");
    await page.route("**/api/reviews/*/feedback", down);
    await page.route("**/api/info", down);
    await page.locator("#finishBtn").click();
    await page.locator("#summary").fill("Ship CSV first.");
    await page.locator("#submitReview").click();
    const error = page.locator("#finishError");
    await error.waitFor();
    assert.equal(
      await error.innerText(),
      "hoop's pages didn't answer. If they stopped, any hoop command or a new session starts them again; check whether it went through before trying again.",
    );
    assert.doesNotMatch(await page.locator("body").innerText(), /Failed to fetch/);
    const banner = page.locator("#banner");
    await page.waitForFunction(() => document.getElementById("banner")?.textContent?.startsWith("The pages stopped."));
    assert.equal(await page.locator("#summary").inputValue(), "Ship CSV first.", "what was typed is kept");
    // The pages answer again: the next request clears the banner.
    await page.unroute("**/api/reviews/*/feedback", down);
    await page.unroute("**/api/info", down);
    await page.locator("#submitReview").click();
    await page.waitForFunction(() => document.getElementById("banner")?.textContent === "");
    assert.equal(await banner.innerText(), "");
  });
});

test("#341: a background request that fails while the pages still answer shows no banner and no error", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(async ({ base, page }) => {
    await page.addInitScript(() => ((window as unknown as { HOOP_WORK_MS: number }).HOOP_WORK_MS = 200));
    await page.goto(`${base}/work`);
    await page.locator(".list.work").waitFor();
    // The Work polls fail while the pages themselves answer, as when a request is lost.
    let failed = 0;
    await page.route("**/api/work", (route) => {
      failed++;
      return route.abort("connectionrefused");
    });
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(failed >= 2, "the polls failed");
    assert.equal(await page.locator("#banner").innerText(), "");
    assert.doesNotMatch(await page.locator("#app").innerText(), /Couldn't read the work|didn't answer/);
  });
});
