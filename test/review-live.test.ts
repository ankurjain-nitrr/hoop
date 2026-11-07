import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { BROWSER_SKIP, hasFocus, serveMermaid, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";
import type { Hoop } from "../src/hoop.js";

// docs/DESIGN-LANGUAGE.md, Refreshing: an open review page shows Claude's replies, and a conversation
// they reopen, without a reload (#434). It waits while the person writes, and keeps focus and scroll.

const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of the background.`).join("\n\n");

/** A review with one conversation Claude has read, on the Storage section, after `before` (markdown). */
function talk(hoop: Hoop, before = "") {
  const { review_id } = hoop.submit(
    parseMarkdown(`# Plan\n\nWhy we store it this way.\n\n${before}## Storage\n\nUse Cassandra.\n\n## Background\n\n${filler}\n`),
  );
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

/** Counts the page's reads of review `id` from now on. */
function reads(page: Page, id: string) {
  const seen = { n: 0 };
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === `/api/reviews/${id}`) seen.n++;
  });
  return seen;
}

/** Opens review `id` with the list polled every 100 ms, and waits for its conversation's Reply. */
async function open(page: Page, base: string, id: string, thread: string) {
  await page.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 100 }));
  await page.goto(`${base}/r/${id}`);
  await page.locator(`[data-reply="${thread}"]`).waitFor();
}

test(
  "Claude's reply shows on an open review page without a reload, said once, keeping focus and scroll, and waits while a reply is written",
  {
    skip: BROWSER_SKIP,
  },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const { review_id, thread } = talk(hoop);
      await open(page, base, review_id, thread);
      const reply = page.locator(`[data-reply="${thread}"]`);
      // A poll that finds nothing changed reads nothing.
      const read = reads(page, review_id);
      await polls(page, 3);
      assert.equal(read.n, 0, "an unchanged review isn't read again");

      await reply.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
      await page.evaluate(() => scrollTo(0, 120));
      const y = await page.evaluate(() => scrollY);
      assert.ok(y > 0, "the page scrolls");
      hoop.reply(thread, "Scale.");
      await page.getByText("Scale.", { exact: true }).waitFor({ timeout: 5000 });
      assert.equal(await hasFocus(reply), true, "focus stays on the control it was on");
      assert.equal(await page.evaluate(() => scrollY), y, "and the page doesn't scroll");
      await page.waitForFunction(() => document.getElementById("page-live")?.textContent === 'Claude replied on "Storage" line 1.');

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

test("the refresh waits while the verdict panel is open, text is selected or the tab is hidden", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id, thread } = talk(hoop);
    await open(page, base, review_id, thread);
    const waits = async (what: string, start: () => Promise<unknown>, end: () => Promise<unknown>, words: string) => {
      await start();
      hoop.reply(thread, words);
      await polls(page, 3);
      assert.equal(await page.getByText(words).count(), 0, `nothing changes while ${what}`);
      await end();
      await page.getByText(words).waitFor({ timeout: 5000 });
    };
    const finish = page.locator("#finishBtn");
    await waits(
      "the verdict panel is open",
      () => finish.click(),
      () => finish.click(),
      "First.",
    );
    const line = page.getByText("Use Cassandra.");
    await waits(
      "text is selected",
      () => line.selectText(),
      () => page.evaluate(() => getSelection()?.removeAllRanges()),
      "Second.",
    );
    const read = reads(page, review_id);
    const seen = (state: string) =>
      page.evaluate((s) => {
        Object.defineProperty(document, "visibilityState", { value: s, configurable: true });
      }, state);
    await waits(
      "the tab is hidden",
      () => seen("hidden"),
      () => seen("visible"),
      "Third.",
    );
    assert.equal(read.n, 1, "a hidden tab reads nothing; the read comes once it is in view");
  }),
);

test("a live refresh keeps a drawn diagram's room, so the page doesn't jump under the reader", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const steps = Array.from({ length: 30 }, (_, i) => `  S${i} --> S${i + 1}`).join("\n");
    const { review_id, thread } = talk(hoop, `## Flow\n\n\`\`\`mermaid\nflowchart TD\n${steps}\n\`\`\`\n\n`);
    await serveMermaid(page);
    await open(page, base, review_id, thread);
    await page.locator(".diagram-frame.drawn").waitFor({ timeout: 15_000 });
    assert.ok((await page.locator(".diagram").evaluate((el) => el.getBoundingClientRect().height)) > 600, "the diagram is tall");
    await page.locator(`[data-reply="${thread}"]`).evaluate((el) => el.scrollIntoView({ block: "center" }));
    const y = await page.evaluate(() => scrollY);
    await page.evaluate(() => {
      // Every scroll position the page passes through while it refreshes.
      const w = window as unknown as { ys: number[] };
      w.ys = [];
      addEventListener("scroll", () => w.ys.push(scrollY));
    });
    hoop.reply(thread, "Scale.");
    await page.getByText("Scale.", { exact: true }).waitFor({ timeout: 5000 });
    await page.locator(".diagram-frame.drawn").waitFor({ timeout: 15_000 });
    assert.equal(await page.evaluate(() => scrollY), y, "the page stays where it was");
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as { ys: number[] }).ys.filter((v, i, all) => v !== all[i - 1])),
      [],
      "and never moved on the way",
    );
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

test("a proposed edit shows live too, since the page takes the review as it is now", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id, thread } = talk(hoop);
    await open(page, base, review_id, thread);
    const storage = hoop.store.revision(review_id).items.find((i) => i.title === "Storage")!.id;
    hoop.proposeEdits(review_id, thread, [{ item: storage, line: 1, find: "Cassandra", replace: "Postgres" }]);
    await page.locator("[data-accept]").first().waitFor({ timeout: 5000 });
  }),
);
