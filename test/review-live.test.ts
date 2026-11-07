import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { BROWSER_SKIP, hasFocus, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";
import type { Hoop } from "../src/hoop.js";

// docs/DESIGN-LANGUAGE.md, Refreshing: an open review page shows Claude's replies, and a conversation
// they reopen, without a reload (#434). It waits while the person writes, and keeps focus and scroll.

const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of the background.`).join("\n\n");

/** A review with one conversation Claude has read, on the Storage section. */
function talk(hoop: Hoop) {
  const { review_id } = hoop.submit(parseMarkdown(`# Plan\n\nWhy we store it this way.\n\n## Storage\n\nUse Cassandra.\n\n## Background\n\n${filler}\n`));
  const storage = hoop.store.revision(review_id).items.find((i) => i.title === "Storage")!.id;
  hoop.review(review_id, { reviewer: "ankur", verdict: "changes_requested", comments: [{ item: storage, line: 1, body: "Why Cassandra?" }] }, true);
  hoop.feedback(review_id);
  const thread = hoop.threads(review_id).threads![0]!.thread;
  return { review_id, thread };
}

/** Waits for `n` answers to the page's poll of the reviews list. */
async function polls(page: Page, n: number) {
  for (let i = 0; i < n; i++) await page.waitForResponse((r) => new URL(r.url()).pathname === "/api/reviews");
}

test("Claude's reply shows on an open review page without a reload, keeping focus and scroll, and waits while a reply is written", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id, thread } = talk(hoop);
    await page.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 100 }));
    await page.goto(`${base}/r/${review_id}`);
    const reply = page.locator(`[data-reply="${thread}"]`);
    await reply.waitFor();
    await reply.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
    await page.evaluate(() => scrollTo(0, 120));
    const y = await page.evaluate(() => scrollY);
    assert.ok(y > 0, "the page scrolls");

    hoop.reply(thread, "Scale.");
    await page.getByText("Scale.", { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await hasFocus(reply), true, "focus stays on the control it was on");
    assert.equal(await page.evaluate(() => scrollY), y, "and the page doesn't scroll");

    // While a reply is being written, the refresh waits, and the words stay.
    await reply.click();
    await page.locator("#cbody").fill("Not sure");
    hoop.reply(thread, "It grows past one machine.");
    await polls(page, 3);
    assert.equal(await page.getByText("It grows past one machine.").count(), 0, "nothing changes under the open box");
    assert.equal(await page.locator("#cbody").inputValue(), "Not sure");
    await page.locator("#cancelComment").click();
    await page.getByText("It grows past one machine.").waitFor({ timeout: 5000 });
  }),
);

test("on an approved review, Claude's reply reopens a resolved conversation while the page is open", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id, thread } = talk(hoop);
    hoop.review(review_id, { reviewer: "ankur", verdict: "approved", resolved_threads: [thread] }, true);
    await page.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 100 }));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(`.thread.resolved[data-thread="${thread}"]`).waitFor();
    hoop.reply(thread, "One more thing on storage.");
    await page.getByText("One more thing on storage.").waitFor({ timeout: 5000 });
    assert.equal(await page.locator(`.thread.resolved[data-thread="${thread}"]`).count(), 0, "the conversation shows as open");
    assert.equal(hoop.store.meta(review_id).status, "approved", "and the approval holds");
  }),
);
