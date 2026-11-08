import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { BROWSER_SKIP, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";

// docs/DESIGN-LANGUAGE.md, Tips: one quiet line beside the control a feature uses, at the moment it
// applies, linking its page; it goes for good once the feature is used, keeping its place until the
// page loads again, and the Tips switch on Home turns every tip off (decided in rv_mw7ips3wabf46f).

const PLAN = "# Plan\n\nWhy we store it this way.\n\n## Storage\n\nUse Cassandra for the event log.\n";
const BUILD = "# Cutting cloud cost\n\nWhat this helps decide.\n\n## Where the money goes\n\n## Options\n";
const DOCS = "https://github.com/ankurjain-nitrr/hoop/blob/main/docs/using/";

/** Selects `words` in the Storage line, as a drag does, so the selection bar shows. */
async function select(page: Page, words: string) {
  await page.locator('[data-sel-line="0"]', { hasText: "Use Cassandra" }).evaluate((el, w) => {
    // The first text node holding the words: a highlighted comment splits the line into several.
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walk.nextNode()!;
    while (!node.textContent!.includes(w)) node = walk.nextNode()!;
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

/** A tip's words and link, whether `control` is described by it, and whether it's a live region. */
async function tipOf(page: Page, id: string, control: string) {
  const tip = page.locator(`#${id}`);
  return {
    text: (await tip.textContent())?.trim(),
    href: await tip.locator("a").getAttribute("href"),
    describes: (await page.locator(control).getAttribute("aria-describedby")) === id,
    live: await tip.evaluate((el) => el.closest('[aria-live], [role="status"], [role="alert"]') !== null),
  };
}

/** Comments on the words selected, with `body`, and adds the comment to the review. */
async function commentOnSelection(page: Page, body: string) {
  await page.locator("#selBtn").click();
  await page.locator("#cbody").fill(body);
  await page.locator("#addComment").click();
  await page.locator("#cbody").waitFor({ state: "detached" });
}

test("the review page's tips show at their moment, link their page, and go once their feature is used", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(PLAN));
    await page.goto(`${base}/r/${review_id}`);
    await select(page, "Cassandra");
    assert.deepEqual(await tipOf(page, "tipSelect", "#selBtn"), {
      text: "Comment on just these words. How comments work",
      href: `${DOCS}reviewing.md`,
      describes: true,
      live: false,
    });
    // A comment box open on selected words offers the suggestion instead, one tip at a time.
    await page.locator("#selBtn").click();
    await page.locator("#cbody").waitFor();
    assert.deepEqual(await tipOf(page, "tipSuggest", "#toggleSuggest"), {
      text: "Suggest the wording instead. How suggestions work",
      href: `${DOCS}suggestions.md`,
      describes: true,
      live: false,
    });
    assert.equal(await page.locator(".tip:visible").count(), 1, "one tip at a time");
    await page.locator("#cancelComment").click();

    // Opening the box isn't using the feature: the selection tip stays until a comment is added.
    await select(page, "Cassandra");
    assert.equal(await page.locator("#tipSelect").count(), 1, "still there after a cancelled comment");
    await commentOnSelection(page, "Why Cassandra?");
    await page.reload();
    await select(page, "event log");
    assert.equal(await page.locator("#tipSelect").count(), 0, "gone for good once a comment on selected words is added");
    assert.equal(await page.locator("#selBtn").getAttribute("aria-describedby"), null, "and Comment on selection no longer points at it");

    // A suggestion added retires the suggestion tip.
    await page.locator("#selBtn").click();
    await page.locator("#tipSuggest").waitFor();
    await page.locator("#toggleSuggest").click();
    await page.locator("#csugg").fill("the audit log");
    await page.locator("#addComment").click();
    await page.reload();
    await select(page, "Cassandra");
    await page.locator("#selBtn").click();
    await page.locator("#cbody").waitFor();
    assert.equal(await page.locator("#tipSuggest").count(), 0, "gone for good once a suggestion is added");
    assert.equal(await page.locator("#toggleSuggest").getAttribute("aria-describedby"), null);
  }),
);

test("Delete selection retires both review tips, and so does a comment on typed words from the keyboard path", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, browser }) => {
    const { review_id } = hoop.submit(parseMarkdown(PLAN));
    // Delete selection: a suggestion on selected words.
    const a = await browser.newPage();
    await a.goto(`${base}/r/${review_id}`);
    await select(a, "for the event log");
    await a.locator("#selDelete").click();
    await a.reload();
    await select(a, "Cassandra");
    assert.equal(await a.locator("#tipSelect").count(), 0, "Delete selection retires the selection tip");
    await a.locator("#selBtn").click();
    await a.locator("#cbody").waitFor();
    assert.equal(await a.locator("#tipSuggest").count(), 0, "and the suggestion tip");

    // The keyboard path: + on the line, then the words typed in "Only about this text".
    const k = await browser.newPage();
    await k.goto(`${base}/r/${review_id}`);
    await select(k, "Cassandra");
    await k.locator("#tipSelect").waitFor();
    await k.evaluate(() => getSelection()?.removeAllRanges());
    await k.getByRole("button", { name: /^Comment on "Storage" line 1/ }).click();
    await k.locator("#cpart").fill("Cassandra");
    await k.locator("#cbody").fill("Why this one?");
    await k.locator("#addComment").click();
    await k.reload();
    await select(k, "Cassandra");
    assert.equal(await k.locator("#tipSelect").count(), 0, "a comment on typed words retires the selection tip");
  }),
);

test("with storage blocked, tips show and every action still works", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, browser }) => {
    const { review_id } = hoop.submit(parseMarkdown(PLAN));
    const page = await browser.newPage();
    await page.addInitScript(() => {
      for (const m of ["getItem", "setItem", "removeItem"] as const)
        Storage.prototype[m] = () => {
          throw new Error("blocked");
        };
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/r/${review_id}`);
    await select(page, "Cassandra");
    await page.locator("#tipSelect").waitFor();
    await page.locator("#selDelete").click();
    await page.locator("[data-drop]").waitFor();
    await page.goto(`${base}/`);
    await page.locator("#tipsOn").click();
    await page.locator("#tipsOn").waitFor();
    assert.deepEqual(errors, []);
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

/** Where the build's tip is and how tall, whether it shows, and what it describes. */
const buildTip = (page: Page) =>
  page.locator("#tipBuild").evaluate((el) => ({
    gone: el.classList.contains("tip-gone"),
    box: JSON.stringify((({ x, y, width, height }) => ({ x, y, width, height }))(el.getBoundingClientRect())),
    describes: [...document.querySelectorAll('[aria-describedby="tipBuild"]')].map((c) => c.getAttribute("data-kind")),
  }));

test("the build page's tip sits beside Suggest the next heading, and keeps its place when Generate retires it", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(BUILD);
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`${base}/r/${id}`);
    const tip = page.locator("#tipBuild");
    await tip.waitFor();
    assert.equal(await page.locator(".tip").count(), 1, "one tip");
    assert.equal((await tip.textContent())?.trim(), "Ask Claude for the next section. How building works");
    assert.equal(await tip.locator("a").getAttribute("href"), `${DOCS}building.md`);
    const before = await buildTip(page);
    assert.deepEqual(before.describes, ["next"], "it describes Suggest the next heading");
    assert.equal(before.gone, false);
    // Generate on a section retires it; its place stays, unseen, and nothing points at it.
    await page.locator("[data-b-gen]").first().click();
    await page.locator("form.bgen button[type=submit]").click();
    await page.locator("#tipBuild.tip-gone").waitFor({ state: "attached" });
    const after = await buildTip(page);
    assert.deepEqual(after.describes, []);
    assert.equal(JSON.parse(after.box).height, JSON.parse(before.box).height, "its place keeps its height");
    await page.reload();
    await page.locator("[data-b-gen]").first().waitFor();
    assert.equal(await page.locator("#tipBuild").count(), 0, "gone for good after a reload");
  }),
);

test("Generate all and the Suggest form retire the build's tip too", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, browser }) => {
    const all = hoop.startBuild(BUILD).review_id;
    const a = await browser.newPage();
    await a.goto(`${base}/r/${all}`);
    await a.locator("#tipBuild").waitFor();
    await a.locator("[data-b-gen-all]").click();
    await a.locator("#tipBuild.tip-gone").waitFor({ state: "attached" });

    const ask = hoop.startBuild(BUILD).review_id;
    const s = await browser.newPage();
    await s.goto(`${base}/r/${ask}`);
    await s.locator("#tipBuild").waitFor();
    // A page of its own, so its browser storage starts clean.
    await s.locator("#tipBuild:not(.tip-gone)").waitFor();
    await s.locator('[data-b-suggest][data-kind="next"]').click();
    await s.locator("[data-b-suggest-form] button[type=submit]").click();
    await s.locator("#tipBuild.tip-gone").waitFor({ state: "attached" });
  }),
);

test(
  "the selection tip is a plain line on the selection bar's own surface, one line at 400 pixels, above the words, in both themes",
  {
    skip: BROWSER_SKIP,
  },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const { review_id } = hoop.submit(parseMarkdown(PLAN));
      await page.setViewportSize({ width: 400, height: 800 });
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(`${base}/r/${review_id}`);
        await select(page, "Cassandra");
        await page.locator("#tipSelect").waitFor();
        const look = await page.evaluate(() => {
          const bar = document.querySelector(".sel-bar")!;
          const tip = document.getElementById("tipSelect")!;
          const line = document.querySelector(".sel-tip")!;
          const b = getComputedStyle(bar);
          const t = getComputedStyle(line);
          const sel = getSelection()!.getRangeAt(0).getBoundingClientRect();
          return {
            barSurface: b.backgroundColor !== "rgba(0, 0, 0, 0)" && b.borderTopStyle === "solid",
            tipPlain: t.backgroundColor === "rgba(0, 0, 0, 0)" && t.borderTopStyle === "none",
            oneLine: tip.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(tip).lineHeight) + 1,
            inView: bar.getBoundingClientRect().right <= document.documentElement.clientWidth,
            above: bar.getBoundingClientRect().bottom <= sel.top,
          };
        });
        assert.deepEqual(look, { barSurface: true, tipPlain: true, oneLine: true, inView: true, above: true }, scheme);
      }
    }),
);
