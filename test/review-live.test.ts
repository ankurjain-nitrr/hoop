import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { BROWSER_SKIP, hasFocus, serveMermaid, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";
import type { Hoop } from "../src/hoop.js";
import { OPS } from "../src/ops.js";

// docs/DESIGN-LANGUAGE.md, Refreshing: an open review page shows Claude's replies, and a conversation
// they reopen, without a reload (#434). It waits while the person writes, and keeps focus and scroll.

const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of the background.`).join("\n\n");

/** Claude reads the review's feedback, as hoop_feedback does, so it can revise the review. */
const read = (hoop: Hoop, review_id: string) => OPS.find((o) => o.name === "feedback")!.run(hoop, { review_id }, { actor: "claude" });

/**
 * A review with one conversation Claude has read, on the Storage section, with `before` (markdown)
 * above that section and `after` below it.
 */
function talk(hoop: Hoop, before = "", after = "") {
  const { review_id } = hoop.submit(
    parseMarkdown(`# Plan\n\nWhy we store it this way.\n\n${before}## Storage\n\nUse Cassandra.\n\n${after}## Background\n\n${filler}\n`),
  );
  const storage = hoop.store.revision(review_id).items.find((i) => i.title === "Storage")!.id;
  hoop.review(review_id, { reviewer: "ankur", verdict: "changes_requested", comments: [{ item: storage, line: 1, body: "Why Cassandra?" }] }, true);
  read(hoop, review_id);
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
      await page.waitForFunction(() => document.getElementById("page-live")?.textContent === "Claude replied on “Storage” line 1.");

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
    assert.deepEqual(await page.evaluate((y) => (window as unknown as { ys: number[] }).ys.filter((v) => v !== y), y), [], "and never moved on the way");
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

const KEEP = { question: "Keep it?", options: [{ label: "Keep", recommended: true }, { label: "Remove" }] };

/** Sets what the page's `document.visibilityState` reads, as a tab going out of view or back does. */
const seenAs = (page: Page, state: "hidden" | "visible") =>
  page.evaluate((s) => Object.defineProperty(document, "visibilityState", { value: s, configurable: true }), state);

/** The live region's words once they read `words`. */
const said = (page: Page, words: string | RegExp) =>
  page.waitForFunction(
    ([w, re]) => {
      const t = document.getElementById("page-live")?.textContent ?? "";
      return re ? new RegExp(w).test(t) : t === w;
    },
    typeof words === "string" ? ([words, false] as const) : ([words.source, true] as const),
  );

test("regression: a quick question Claude anchors to a line shows on the open review, and so does its answer", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id, thread } = talk(hoop);
    await open(page, base, review_id, thread);
    const ask = hoop.ask({ questions: [KEEP], anchor: { review_id, words: "Use Cassandra." } }).review_id;
    const card = page.locator(`#ask-${ask}`);
    await card.waitFor({ timeout: 5000 });
    hoop.answer(ask, { question: "Q1", choice: "A" });
    await card.locator(".ask-answer:not(.none)").waitFor({ timeout: 5000 });
  }),
);

test("regression: a live refresh leaves the drafts another tab stored alone", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, browser }) => {
    const { review_id, thread } = talk(hoop);
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 100 }));
    const [a, b] = [await ctx.newPage(), await ctx.newPage()];
    await a.goto(`${base}/r/${review_id}`);
    await a.locator(`[data-reply="${thread}"]`).waitFor();
    // B, opened after A, writes a comment A never saw; it is stored for the review.
    await b.bringToFront();
    await b.goto(`${base}/r/${review_id}`);
    await b.getByRole("button", { name: 'Comment on "Background" line 1', exact: true }).click();
    await b.locator("#cbody").fill("Shorter, please.");
    await b.locator("#addComment").click();
    const stored = () => b.evaluate((id) => localStorage.getItem(`hoop:${id}:drafts`) ?? "", review_id);
    assert.match(await stored(), /Shorter, please\./);
    await b.close();
    // A, in view, refreshes for Claude's reply; B's drafts stay stored.
    await a.bringToFront();
    hoop.reply(thread, "Scale.");
    await a.getByText("Scale.", { exact: true }).waitFor({ timeout: 5000 });
    assert.match(await a.evaluate((id) => localStorage.getItem(`hoop:${id}:drafts`) ?? "", review_id), /Shorter, please\./, "A didn't write over them");
    await ctx.close();
  }),
);

test("regression: a refresh that brings a reply and changes the verdict says both, in one message", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id, thread } = talk(hoop);
    // The person resolves the conversation, so the verdict control offers Approve.
    hoop.review(review_id, { reviewer: "ankur", verdict: "changes_requested", summary: "Noted.", resolved_threads: [thread] }, true);
    read(hoop, review_id);
    await page.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 100 }));
    await page.goto(`${base}/r/${review_id}`);
    const finish = page.locator("#finishBtn");
    await finish.waitFor();
    const before = await finish.getAttribute("data-verdict");
    hoop.reply(thread, "Scale.");
    await page.getByText("Scale.", { exact: true }).waitFor({ timeout: 5000 });
    assert.notEqual(await finish.getAttribute("data-verdict"), before, "the reply reopened the conversation, which changes the verdict");
    await said(page, /^Claude replied on “Storage” line 1\. Now .+: .+/);
  }),
);

test("replies in two conversations in one refresh are said as a count", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(`# Plan\n\nWhy.\n\n## Storage\n\nUse Cassandra.\n\n## Queue\n\nUse Kafka.\n`));
    const items = hoop.store.revision(review_id).items;
    const at = (title: string) => items.find((i) => i.title === title)!.id;
    hoop.review(
      review_id,
      {
        reviewer: "ankur",
        verdict: "changes_requested",
        comments: [
          { item: at("Storage"), line: 1, body: "Why Cassandra?" },
          { item: at("Queue"), line: 1, body: "Why Kafka?" },
        ],
      },
      true,
    );
    hoop.feedback(review_id);
    const [one, two] = hoop.threads(review_id).threads!.map((t) => t.thread);
    await open(page, base, review_id, one!);
    // Out of view, the page reads nothing, so both replies come in one refresh.
    await seenAs(page, "hidden");
    hoop.reply(one!, "Scale.");
    hoop.reply(two!, "Ordering.");
    await polls(page, 2);
    await seenAs(page, "visible");
    await said(page, "Claude replied in 2 conversations.");
  }),
);

test("regression: a diagram keeps no room from before when its source changed, or when it fails to draw again", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const chart = (n: number) =>
      `## Flow\n\n\`\`\`mermaid\nflowchart TD\n${Array.from({ length: n }, (_, i) => `  S${i} --> S${i + 1}`).join("\n")}\n\`\`\`\n\n`;
    const doc = (n: number, tail: string) => parseMarkdown(`# Plan\n\nWhy we store it this way.\n\n${chart(n)}## Storage\n\n${tail}\n`);
    const { review_id, thread } = talk(hoop, chart(30));
    await serveMermaid(page);
    await open(page, base, review_id, thread);
    const box = page.locator(".diagram");
    await page.locator(".diagram-frame.drawn").waitFor({ timeout: 15_000 });
    const tall = await box.evaluate((el) => el.getBoundingClientRect().height);
    // A new revision with a short diagram: its box takes only the room it draws.
    hoop.submit({ ...doc(2, "Use Cassandra."), review_id }, 1);
    await page.locator("#showRevision").click({ timeout: 10_000 });
    await page.locator(".rev", { hasText: "rev 2" }).waitFor();
    assert.equal(await box.evaluate((el) => el.style.minHeight), "", "a changed source keeps no room");
    await page.locator(".diagram-frame.drawn").waitFor({ timeout: 15_000 });
    const short = await box.evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(short < tall, "the short diagram is shorter");
    // The same diagram in the next revision, with the library unreachable: the room it kept while it
    // tried goes once it fails.
    await page.unroute("**/*mermaid*");
    await page.route("**/*mermaid*", (r) => r.abort());
    hoop.submit({ ...doc(2, "Use Postgres."), review_id }, 2);
    await page.locator("#showRevision").click({ timeout: 10_000 });
    await page.locator(".rev", { hasText: "rev 3" }).waitFor();
    await page.locator(".diagram-error").waitFor({ timeout: 20_000 });
    assert.equal(await box.evaluate((el) => el.style.minHeight), "", "a diagram that fails keeps no room");
  }),
);

test(
  "a live refresh leaves a drawn diagram as it is, and keeps the line being read in place when a reply lands above it",
  {
    skip: BROWSER_SKIP,
  },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const steps = Array.from({ length: 30 }, (_, i) => `  S${i} --> S${i + 1}`).join("\n");
      const { review_id, thread } = talk(hoop, "", `## Flow\n\n\`\`\`mermaid\nflowchart TD\n${steps}\n\`\`\`\n\n`);
      await serveMermaid(page);
      await open(page, base, review_id, thread);
      await page.locator(".diagram-frame.drawn").waitFor({ timeout: 15_000 });
      // The reader is past the Storage conversation, with the diagram at the top of the window.
      const flow = page.locator(".diagram");
      await flow.evaluate((el) => el.scrollIntoView({ block: "start" }));
      const top = await flow.evaluate((el) => el.getBoundingClientRect().top);
      await page.locator(".diagram-frame").evaluate((el) => el.setAttribute("data-kept", ""));
      await page.evaluate(() => {
        const w = window as unknown as { waited: boolean };
        w.waited = false;
        new MutationObserver(() => {
          if (document.querySelector(".diagram-wait")) w.waited = true;
        }).observe(document.body, { subtree: true, childList: true });
      });
      hoop.reply(thread, "Scale, as the next section shows in its flow.");
      await page.getByText("Scale, as the next section shows in its flow.").waitFor({ state: "attached", timeout: 5000 });
      assert.equal(await page.locator(".diagram-frame[data-kept]").count(), 1, "the drawn diagram is the same frame");
      assert.equal(await page.evaluate(() => (window as unknown as { waited: boolean }).waited), false, "and never showed Drawing the diagram…");
      assert.ok(Math.abs((await flow.evaluate((el) => el.getBoundingClientRect().top)) - top) < 1, "what the person reads stays where it was");
    }),
);

test("a proposed edit and a quick question beside a line are said with their place", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id, thread } = talk(hoop);
    await open(page, base, review_id, thread);
    const storage = hoop.store.revision(review_id).items.find((i) => i.title === "Storage")!.id;
    hoop.proposeEdits(review_id, thread, [{ item: storage, line: 1, find: "Cassandra", replace: "Postgres" }]);
    await said(page, "Claude proposed an edit on “Storage” line 1.");
    hoop.ask({ questions: [KEEP], anchor: { review_id, words: "Use Cassandra." } });
    await said(page, "Claude asked a quick question on “Storage” line 1.");
  }),
);
