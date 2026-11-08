import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { BROWSER_SKIP, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";

// docs/DESIGN-LANGUAGE.md, Tips: one quiet line beside the control a feature uses, at the moment it
// applies, linking its page; it goes for good once the feature is used, and the Tips switch on Home
// turns every tip off (decided in rv_mw7ips3wabf46f).

const PLAN = "# Plan\n\nWhy we store it this way.\n\n## Storage\n\nUse Cassandra for the event log.\n";

/** Selects `words` in the Storage line, as a drag does, so the selection bar shows. */
async function select(page: Page, words: string) {
  await page.locator('[data-sel-line="0"]', { hasText: "Use Cassandra" }).evaluate((el, w) => {
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;
    const at = node.textContent!.indexOf(w);
    const r = document.createRange();
    r.setStart(node, at);
    r.setEnd(node, at + w.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, words);
  await page.locator("#selBtn").waitFor();
}

/** A tip's words and link, and the control it describes. */
async function tipOf(page: Page, id: string, control: string) {
  const tip = page.locator(`#${id}`);
  return {
    text: (await tip.textContent())?.trim(),
    href: await tip.locator("a").getAttribute("href"),
    describes: (await page.locator(control).getAttribute("aria-describedby")) === id,
    live: await tip.evaluate((el) => el.closest('[aria-live], [role="status"], [role="alert"]') !== null),
  };
}

test("the review page's tips show at their moment, link their page, and go for good once their feature is used", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(PLAN));
    await page.goto(`${base}/r/${review_id}`);

    // The first selection: the bar's Comment on selection carries "Comment on just these words".
    await select(page, "Cassandra");
    assert.deepEqual(await tipOf(page, "tipSelect", "#selBtn"), {
      text: "Comment on just these words. How comments work",
      href: "https://github.com/ankurjain-nitrr/hoop/blob/main/docs/using/reviewing.md",
      describes: true,
      live: false,
    });

    // A comment on selected words: "Suggest the wording instead" beside Suggest a change, and one tip at a time.
    await page.locator("#selBtn").click();
    await page.locator("#cbody").waitFor();
    assert.deepEqual(await tipOf(page, "tipSuggest", "#toggleSuggest"), {
      text: "Suggest the wording instead. How suggestions work",
      href: "https://github.com/ankurjain-nitrr/hoop/blob/main/docs/using/suggestions.md",
      describes: true,
      live: false,
    });
    assert.equal(await page.locator(".tip:visible").count(), 1, "one tip at a time");
    await page.locator("#cancelComment").click();

    // Used once, the selection tip doesn't come back, through a reload too.
    await page.reload();
    await select(page, "event log");
    assert.equal(await page.locator("#tipSelect").count(), 0, "the selection tip is gone for good");
    assert.equal(await page.locator("#selBtn").getAttribute("aria-describedby"), null);

    // Suggesting the wording retires the suggestion tip.
    await page.locator("#selBtn").click();
    await page.locator("#tipSuggest").waitFor();
    await page.locator("#toggleSuggest").click();
    await page.locator("#csugg").waitFor();
    await page.locator("#cancelComment").click();
    await page.reload();
    await select(page, "Cassandra");
    await page.locator("#selBtn").click();
    await page.locator("#cbody").waitFor();
    assert.equal(await page.locator("#tipSuggest").count(), 0, "the suggestion tip is gone for good");
  }),
);

test("the Tips switch on Home turns every tip off and on again", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(PLAN));
    await page.goto(`${base}/`);
    const tips = page.locator("#tipsOn");
    assert.equal(await tips.getAttribute("aria-pressed"), "true", "tips start on");
    await tips.click();
    assert.equal(await page.locator("#tipsOn").getAttribute("aria-pressed"), "false");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "tipsOn", "focus stays on the switch");
    await page.goto(`${base}/r/${review_id}`);
    await select(page, "Cassandra");
    assert.equal(await page.locator("#tipSelect").count(), 0, "no tip while tips are off");
    await page.goto(`${base}/`);
    await page.locator("#tipsOn").click();
    assert.equal(await page.locator("#tipsOn").getAttribute("aria-pressed"), "true");
    await page.goto(`${base}/r/${review_id}`);
    await select(page, "Cassandra");
    await page.locator("#tipSelect").waitFor();
  }),
);

test("the build page's tip shows under its first empty section only, and goes once Claude is asked for text", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild("# Cutting cloud cost\n\nWhat this helps decide.\n\n## Where the money goes\n\n## Options\n");
    await page.goto(`${base}/r/${id}`);
    const tip = page.locator("#tipBuild");
    await tip.waitFor();
    assert.equal(await page.locator(".tip").count(), 1, "one tip, on the first empty section");
    assert.equal((await tip.textContent())?.trim(), "Ask Claude for the next section. How building works");
    assert.equal(await tip.locator("a").getAttribute("href"), "https://github.com/ankurjain-nitrr/hoop/blob/main/docs/using/building.md");
    const gen = page.locator('[aria-describedby="tipBuild"]');
    assert.match((await gen.getAttribute("aria-label")) ?? "", /^Generate .*Where the money goes/, "it describes that section's Generate");
    await gen.click();
    await page.locator("form.bgen button[type=submit]").click();
    await page.locator("#tipBuild").waitFor({ state: "detached" });
    await page.reload();
    await page.locator("[data-b-gen]").first().waitFor();
    assert.equal(await page.locator("#tipBuild").count(), 0, "gone for good once Claude was asked");
  }),
);
