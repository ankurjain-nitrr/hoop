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
    await page.locator(".title-row h1 code").waitFor();
    assert.deepEqual(homeCode, await look(".title-row h1 code"));
  }),
);

/** Every accessible name and tooltip on the page. */
const labels = (page: import("playwright-core").Page) =>
  page.$$eval("[aria-label], [title]", (els) => els.flatMap((el) => [el.getAttribute("aria-label") ?? "", el.getAttribute("title") ?? ""]));

test("#389: a link in a title shows only its words inside a Home row's link, and in the build page's labels", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const title = "See [the spec](https://example.com) and **ship**";
    const { review_id: id } = hoop.submit(parseMarkdown(`# ${title}\n\nWhy.\n`));
    const { review_id: buildId } = hoop.startBuild(`# ${title}\n\nWhy.\n`);
    await page.goto(base);
    const t = page.locator(`a.row[href="/r/${id}"] .t`);
    await t.locator("strong", { hasText: "ship" }).waitFor();
    assert.equal(await t.locator("a").count(), 0, "no link sits inside the row's link");
    assert.equal((await t.textContent())?.trim(), "See the spec and ship");

    await page.goto(`${base}/r/${buildId}`);
    await page.locator(".title-row h1 strong").waitFor();
    for (const name of await labels(page)) assert.doesNotMatch(name, /<a|\]\(|example\.com|\*/, name);
    assert.equal(await page.getByRole("button", { name: "Edit Title “See the spec and ship”" }).count(), 1);
    assert.match(await page.title(), /^(\(\d+\) )?See the spec and ship · hoop$/);
  }),
);

test("#389: a title holding HTML shows it as text everywhere, and runs nothing", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const title = "Ship <img src=x onerror=window.pwned=1> `now`";
    const { review_id: id } = hoop.submit(parseMarkdown(`# ${title}\n\nWhy.\n`));
    const { review_id: buildId } = hoop.startBuild(`# ${title}\n\nWhy.\n`);
    const words = "Ship <img src=x onerror=window.pwned=1> now";
    for (const [url, sel] of [
      [base, `a.row[href="/r/${id}"] .t`],
      [`${base}/r/${buildId}`, ".title-row h1"],
      [`${base}/r/${id}`, ".title-row h1 .anchor"],
    ] as const) {
      await page.goto(url);
      await page.locator(`${sel} code`).first().waitFor();
      assert.equal((await page.locator(sel).first().textContent())?.trim(), words, url);
      assert.equal(await page.locator("img").count(), 0, `no image is made (${url})`);
      assert.equal(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned), undefined);
      if (url !== base) assert.match(await page.title(), /^(\(\d+\) )?Ship <img src=x onerror=window\.pwned=1> now · hoop$/);
    }
  }),
);

test("#389: Claude's suggested headings show formatted, and plain in their labels", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild("# Plan\n\n## Costs\n");
    hoop.buildChange(id, { op: "suggest", block: "b2", kind: "subsections" });
    hoop.buildSuggest(id, "g1", [{ heading: "### Use `npm ci` *first*" }]);
    await page.goto(`${base}/r/${id}`);
    const shown = page.locator(".bprop-h");
    await shown.locator("code", { hasText: "npm ci" }).waitFor();
    assert.equal(await shown.locator("em", { hasText: "first" }).count(), 1);
    assert.equal(await shown.innerText(), "Heading 2 Use npm ci first");
    assert.equal(await page.getByRole("button", { name: "Accept suggested heading “Use npm ci first”" }).count(), 1);
    for (const name of await labels(page)) assert.doesNotMatch(name, MARKS, name);
  }),
);

test("#389: headings in the review outline, and a quick question's heading and the review it is about, show formatted", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: reviewId } = hoop.submit(parseMarkdown("# Plan with `code`\n\nWhy.\n\n## Step *one*\n\nRun `npm ci` first.\n"));
    await page.goto(`${base}/r/${reviewId}`);
    const entry = page.locator(".outline .ol-t", { hasText: "Step" });
    await entry.locator("em", { hasText: "one" }).waitFor();
    assert.equal((await entry.textContent())?.trim(), "Step one");
    assert.equal(await page.locator(".outline a a").count(), 0, "no link sits inside an outline link");

    const { review_id: askId } = hoop.ask({
      questions: [{ question: "Keep `npm ci`?", options: [{ label: "Yes", recommended: true }, { label: "No" }] }],
      anchor: { review_id: reviewId, words: "Run `npm ci` first." },
    });
    await page.goto(`${base}/r/${askId}`);
    const heading = page.locator(".ask-q h2");
    await heading.locator("code", { hasText: "npm ci" }).waitFor();
    assert.equal((await heading.textContent())?.trim(), "Keep npm ci?");
    const about = page.locator(".ask-about");
    assert.equal((await about.textContent())?.trim(), "About “Run npm ci first.” in Plan with code");
    assert.equal(await about.locator("code").count(), 2, "the words and the review's title each show their code");
    assert.match(await page.title(), /^(\(\d+\) )?Keep npm ci\? · hoop$/);
    // Code in these reads as inline code does in the review's own header.
    const look = (sel: string) => page.$eval(sel, (el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).fontFamily]);
    const askCode = await look(".ask-q h2 code");
    await page.goto(`${base}/r/${reviewId}`);
    await page.locator(".title-row h1 code").waitFor();
    assert.deepEqual(askCode, await look(".title-row h1 code"));
  }),
);

test("#389: Undo after removing a heading or dismissing a suggested one names it formatted, and plainly in its label", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const doc = "# Plan\n\n## Run `npm ci`\n\nWhy.\n";
    const { review_id: id } = hoop.startBuild(doc);
    hoop.buildChange(id, { op: "suggest", block: "b1", kind: "outline" });
    hoop.takeRequests(id);
    hoop.buildSuggest(id, "g1", [{ heading: "## Mind *risks*" }]);
    await page.goto(`${base}/r/${id}`);

    await page.getByRole("button", { name: "Dismiss suggested heading “Mind risks”" }).click();
    const dismissed = page.locator(".undo-line", { hasText: "Dismissed the suggested heading" });
    await dismissed.locator("em", { hasText: "risks" }).waitFor();
    assert.equal((await dismissed.textContent())?.trim(), "Dismissed the suggested heading “Mind risks”.Undo");
    await page.waitForFunction(() => document.querySelector("#page-live")?.textContent === "Dismissed the suggested heading “Mind risks”. Undo puts it back.");
    await page.getByRole("button", { name: "Undo: put back the suggested heading “Mind risks”", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#page-live")?.textContent === "Put back the suggested heading “Mind risks”.");

    await page.getByRole("button", { name: "Remove Heading 1 “Run npm ci”" }).click();
    await page.getByRole("button", { name: "Remove this heading and everything under it" }).click();
    const removed = page.locator(".undo-line", { hasText: "Removed" });
    await removed.locator("code", { hasText: "npm ci" }).waitFor();
    assert.equal((await removed.textContent())?.trim(), "Removed the heading “Run npm ci” and everything under it.Undo");
    for (const name of await labels(page)) assert.doesNotMatch(name, MARKS, name);
    await page.getByRole("button", { name: "Undo: put back the heading “Run npm ci” and everything under it", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#page-live")?.textContent === "Put back the heading “Run npm ci” and everything under it.");
    assert.equal(hoop.markdownOf(id), doc);
  }),
);

const LOOK = ["display", "borderLeftWidth", "borderLeftStyle", "borderLeftColor", "paddingLeft", "color"] as const;
/** Each element's quote look: its rule and colour. */
const looks = (page: import("playwright-core").Page, sel: string) =>
  page.$$eval(sel, (els, keys) => els.map((el) => Object.fromEntries(keys.map((k) => [k, (getComputedStyle(el) as unknown as Record<string, string>)[k]]))), [
    ...LOOK,
  ]);

const QUOTES = "# Plan\n\n> A quoted line\n\n> First quoted\n> second quoted\n\nPrice > cost here.\n";

test("#390: a quote line on the build page shows as a quote, as on the review page, in both themes", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: reviewId } = hoop.submit(parseMarkdown(QUOTES));
    const { review_id: buildId } = hoop.startBuild(QUOTES);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto(`${base}/r/${reviewId}`);
      await page.locator(".ln-quote").first().waitFor();
      const [review] = await looks(page, ".ln-quote");
      const reviewQuotes = await page.locator(".ln-quote").allInnerTexts();

      await page.goto(`${base}/r/${buildId}`);
      await page.locator(".bbody .ln-quote").first().waitFor();
      const quotes = await page.locator(".bbody .ln-quote").allInnerTexts();
      assert.deepEqual(quotes, ["A quoted line", "First quoted", "second quoted"], `no > shows (${colorScheme})`);
      assert.deepEqual(quotes, reviewQuotes, "each quote line reads as on the review page");
      for (const found of await looks(page, ".bbody .ln-quote")) assert.deepEqual(found, review, `the build's quote matches the review page (${colorScheme})`);
      // A quote line is a block line, not a comment thread's quote of selected words: same size and margin as a paragraph.
      assert.equal(await page.locator(".bbody .bquote").count(), 0);
      const box = (sel: string) => page.$eval(sel, (el) => [getComputedStyle(el).fontSize, getComputedStyle(el).marginTop]);
      assert.deepEqual(await box(".bbody .ln-quote >> xpath=.."), await box(".bbody .bpara"));
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
    const typed = page.locator(".bbody .ln-quote", { hasText: "Typed quote" });
    await typed.waitFor();
    assert.equal((await typed.textContent())?.trim(), "Typed quote");
    await page.getByRole("button", { name: "Edit Paragraph 4" }).click();
    assert.equal(await page.getByLabel("Text of Paragraph 4").inputValue(), "> Typed quote");

    const built = QUOTES.replace("Price > cost here.", "> Typed quote");
    assert.equal(hoop.markdownOf(buildId), built);
    hoop.finishBuild(buildId);
    assert.equal((run(hoop, "export", { review_id: buildId }) as { markdown: string }).markdown, built, "the document exports byte for byte");
  }),
);

const MIXED = "# Plan\n\n- item\n> after list\n\n| a | b |\n|---|---|\n| 1 | 2 |\n> after table\n\nIntro\n> quote\nlazy\n\n- item two\n  > nested in item\n";

test("#390: a quote line after a list item, a table row or a paragraph reads as on the review page", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: reviewId } = hoop.submit(parseMarkdown(MIXED));
    const { review_id: buildId } = hoop.startBuild(MIXED);
    await page.goto(`${base}/r/${reviewId}`);
    await page.locator(".ln-quote").first().waitFor();
    const reviewQuotes = await page.locator(".ln-quote").allInnerTexts();
    assert.deepEqual(reviewQuotes, ["after list", "after table", "quote"]);

    await page.goto(`${base}/r/${buildId}`);
    await page.locator(".bbody .ln-quote").first().waitFor();
    assert.deepEqual(await page.locator(".bbody .ln-quote").allInnerTexts(), reviewQuotes);
    const blocks = page.locator(".bblock .bbody");
    // The list keeps its item, the table its rows, and neither shows a >.
    const list = blocks.filter({ hasText: "after list" });
    assert.equal((await list.locator(".blist").textContent())?.trim(), "•item");
    const table = blocks.filter({ hasText: "after table" });
    assert.deepEqual(await table.locator(".md-table td, .md-table th").allInnerTexts(), ["a", "b", "1", "2"]);
    // After a quote, a line without > starts a paragraph of its own, as the review page shows it.
    const prose = blocks.filter({ hasText: "Intro" });
    assert.deepEqual(await prose.locator(".bpara").allInnerTexts(), ["Intro", "lazy"]);
    // A > indented under a list item stays in the item.
    const nested = blocks.filter({ hasText: "item two" });
    assert.equal(await nested.locator(".ln-quote").count(), 0);
    assert.match((await nested.locator(".blist").textContent()) ?? "", /item two.*nested in item/);
    for (const where of [list, table, prose]) assert.doesNotMatch((await where.locator(":scope > :first-child").textContent()) ?? "", />/);
    assert.equal(hoop.markdownOf(buildId), MIXED, "the markdown is unchanged");
  }),
);
