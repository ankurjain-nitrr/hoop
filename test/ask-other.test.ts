import { test } from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import { parseMarkdown } from "../src/markdown.js";
import { BROWSER_SKIP, hasFocus, withBrowser } from "./helpers.js";

const LONG = "Two clients still call it, and the third one moves next quarter. ".repeat(4);
const question = (q: string) => ({
  question: q,
  context: LONG,
  options: [{ label: "Keep it as an alias", recommended: true }, { label: "Remove it" }, { label: "Deprecate it first" }],
});
const PLAN = `# Plan\n\nWhy this matters.\n\n${Array.from({ length: 6 }, (_, i) => `## Step ${i + 1}\n\n${LONG}\n\nShip step ${i + 1} on Monday.\n`).join("\n")}`;

/** Scrolls `other` to the middle of the viewport, opens its Other box, and checks where the box and focus land and that nothing scrolled. */
async function opensBelowOther(page: Page, scope: Locator, other: Locator, what: string) {
  await other.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const y = await page.evaluate(() => window.scrollY);
  assert.ok(y > 0, `${what}: the page scrolled to the question`);
  await other.click();
  const box = scope.locator(".ask-other");
  await box.waitFor();
  assert.ok(await other.evaluate((el) => el.nextElementSibling?.classList.contains("ask-other")), `${what}: the box comes right after Other in reading order`);
  const [o, b] = [await other.boundingBox(), await box.boundingBox()];
  assert.ok(o && b && b.y >= o.y + o.height && b.y - (o.y + o.height) < 24, `${what}: the box shows right below Other (${JSON.stringify({ o, b })})`);
  assert.ok(await hasFocus(box.locator("input")), `${what}: the box has focus`);
  assert.equal(await page.evaluate(() => window.scrollY), y, `${what}: the page didn't scroll when the box opened`);
  assert.equal(await other.getAttribute("aria-expanded"), "true");

  await page.keyboard.press("Escape");
  await box.waitFor({ state: "detached" });
  assert.ok(await hasFocus(other), `${what}: Escape puts focus back on Other`);
  assert.equal(await other.getAttribute("aria-expanded"), "false");
  assert.equal(await page.evaluate(() => window.scrollY), y, `${what}: the page didn't scroll when the box closed`);

  await other.click();
  await box.getByRole("button", { name: "Cancel" }).click();
  await box.waitFor({ state: "detached" });
  assert.ok(await hasFocus(other), `${what}: Cancel puts focus back on Other`);
  assert.equal(await page.evaluate(() => window.scrollY), y, `${what}: the page didn't scroll when Cancel closed the box`);
}

test(
  "Other opens its box right below the Other option, with focus in it and no scroll, and Escape or Cancel returns to Other (#289)",
  { skip: BROWSER_SKIP },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const ask = hoop.ask({ questions: ["One?", "Two?", "Three?", "Four?"].map(question) }).review_id;
      const review = hoop.submit(parseMarkdown(PLAN)).review_id;
      const card = hoop.ask({
        questions: [question("Keep it?"), question("Rename it?")],
        anchor: { review_id: review, words: "Ship step 4 on Monday." },
      }).review_id;
      for (const colorScheme of ["light", "dark"] as const) {
        for (const width of [400, 1200]) {
          await page.emulateMedia({ colorScheme });
          await page.setViewportSize({ width, height: 700 });
          const at = `${colorScheme}, ${width} px`;

          await page.goto(`${base}/r/${ask}`);
          await page.locator(".ask-q").first().waitFor();
          const q3 = page.locator('.ask-q[data-q="Q3"]');
          await opensBelowOther(page, q3, q3.locator("[data-other]"), `ask page, ${at}`);

          await page.goto(`${base}/r/${review}`);
          const cardEl = page.locator(`#ask-${card}`);
          await cardEl.waitFor();
          const q2 = cardEl.locator('.ask-q[data-q="Q2"]');
          await opensBelowOther(page, q2, q2.locator("[data-other]"), `card, ${at}`);
        }
      }
    }),
);
