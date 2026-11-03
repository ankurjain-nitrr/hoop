import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "../src/markdown.js";
import { OPS } from "../src/ops.js";
import type { Hoop } from "../src/hoop.js";
import { BROWSER_SKIP, withBrowser } from "./helpers.js";

const run = (hoop: Hoop, name: string, input: Record<string, unknown>) => OPS.find((o) => o.name === name)!.run(hoop, input, { actor: "claude" });
const MARKS = /[`*]/;

test("#389: a title with code and emphasis shows formatted on the build page and Home, and plain in tabs and labels", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: buildId } = hoop.startBuild("# Plan with `code` and *emphasis*\n\nWhy it matters.\n");
    const { review_id: reviewId } = hoop.submit(parseMarkdown("# Review with `code` and *emphasis*\n\nWhy it matters.\n"));

    await page.goto(`${base}/r/${buildId}`);
    const h1 = page.locator(".title-row h1");
    await h1.locator("code", { hasText: "code" }).waitFor();
    assert.equal(await h1.locator("em", { hasText: "emphasis" }).count(), 1);
    assert.equal((await h1.textContent())?.trim(), "Plan with code and emphasis");
    assert.match(await page.title(), /^(\(\d+\) )?Plan with code and emphasis · hoop$/);
    const names = await page.$$eval("[aria-label], [title]", (els) =>
      els.flatMap((el) => [el.getAttribute("aria-label") ?? "", el.getAttribute("title") ?? ""]),
    );
    for (const name of names) assert.doesNotMatch(name, MARKS, name);
    assert.equal(await page.getByRole("button", { name: "Edit Title “Plan with code and emphasis”" }).count(), 1);

    await page.goto(`${base}/r/${reviewId}`);
    await page.locator(".title-row h1 code").waitFor();
    assert.match(await page.title(), /^(\(\d+\) )?Review with code and emphasis · hoop$/, "the review page's tab names the review");

    await page.goto(base);
    for (const [id, words] of [
      [buildId, "Plan with code and emphasis"],
      [reviewId, "Review with code and emphasis"],
    ] as const) {
      const t = page.locator(`a.row[href="/r/${id}"] .t`);
      await t.locator("code", { hasText: "code" }).waitFor();
      assert.equal(await t.locator("em").count(), 1);
      assert.equal((await t.textContent())?.trim(), words);
    }
    assert.equal(await page.getByRole("button", { name: "Close: Review with code and emphasis" }).count(), 1);
    // Code in a title reads as inline code does on the review page.
    const look = (sel: string) => page.$eval(sel, (el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).fontFamily]);
    const homeCode = await look(`a.row[href="/r/${reviewId}"] .t code`);
    await page.goto(`${base}/r/${reviewId}`);
    assert.deepEqual(homeCode, await look(".title-row h1 code"));
  }),
);

test("#389: a link in a title shows only its words inside a Home row's link", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.submit(parseMarkdown("# See [the spec](https://example.com) and **ship**\n\nWhy.\n"));
    await page.goto(base);
    const t = page.locator(`a.row[href="/r/${id}"] .t`);
    await t.locator("strong", { hasText: "ship" }).waitFor();
    assert.equal(await t.locator("a").count(), 0, "no link sits inside the row's link");
    assert.equal((await t.textContent())?.trim(), "See the spec and ship");
  }),
);

const QUOTES = "# Plan\n\n> A quoted line\n\n> First quoted\n> second quoted\n\nPrice > cost here.\n";

test("#390: a quote line on the build page shows as a quote, as on the review page, in both themes", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: reviewId } = hoop.submit(parseMarkdown(QUOTES));
    const { review_id: buildId } = hoop.startBuild(QUOTES);
    const LOOK = ["display", "borderLeftWidth", "borderLeftStyle", "borderLeftColor", "paddingLeft", "color"] as const;
    const looks = (sel: string) =>
      page.$$eval(
        sel,
        (els, keys) => els.map((el) => Object.fromEntries(keys.map((k) => [k, (getComputedStyle(el) as unknown as Record<string, string>)[k]]))),
        [...LOOK],
      );
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto(`${base}/r/${reviewId}`);
      await page.locator(".ln-quote").first().waitFor();
      const [review] = await looks(".ln-quote");

      await page.goto(`${base}/r/${buildId}`);
      await page.locator(".bpara .ln-quote").first().waitFor();
      const quotes = page.locator(".bpara .ln-quote");
      assert.deepEqual(await quotes.allInnerTexts(), ["A quoted line", "First quoted second quoted"], `no > shows (${colorScheme})`);
      for (const found of await looks(".bpara .ln-quote")) assert.deepEqual(found, review, `the build's quote matches the review page (${colorScheme})`);
      // A > later in a line leaves the paragraph as it is.
      const price = page.locator(".bpara", { hasText: "Price" });
      assert.equal((await price.textContent())?.trim(), "Price > cost here.");
      assert.equal(await price.locator(".ln-quote").count(), 0);
    }
    assert.equal(hoop.markdownOf(buildId), QUOTES);

    // A quote typed into a paragraph shows as a quote after Preview; its editor shows the >.
    await page.getByRole("button", { name: "Edit Paragraph 4" }).click();
    const box = page.getByLabel("Text of Paragraph 4");
    await box.fill("> Typed quote");
    await box.press("Control+Enter");
    await page.locator(".bpara .ln-quote", { hasText: "Typed quote" }).waitFor();
    assert.equal((await page.locator(".bpara .ln-quote", { hasText: "Typed quote" }).textContent())?.trim(), "Typed quote");
    await page.getByRole("button", { name: "Edit Paragraph 4" }).click();
    assert.equal(await page.getByLabel("Text of Paragraph 4").inputValue(), "> Typed quote");

    const built = QUOTES.replace("Price > cost here.", "> Typed quote");
    assert.equal(hoop.markdownOf(buildId), built);
    hoop.finishBuild(buildId);
    assert.equal((run(hoop, "export", { review_id: buildId }) as { markdown: string }).markdown, built, "the document exports byte for byte");
  }),
);
