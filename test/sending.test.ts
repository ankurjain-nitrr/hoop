import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { workHook } from "../src/work.js";
import { BROWSER_SKIP, example, exampleWithQuestion, hasFocus, tempHome, withBrowser } from "./helpers.js";

// The design language's "Writing and sending" (#336): a box for long text sends with Ctrl+Enter (⌘+Enter
// on a Mac) and says so under it, and plain Enter starts a new line; any other box sends with Enter, and
// Shift+Enter starts a new line. Neither sends while an input method is composing.

const WEB = new URL("../web/", import.meta.url);
// The verb is what the box's button does; then what Escape does there, where it does something.
const LONG_HINT = /^(Ctrl|⌘)\+Enter (sends|saves|adds|previews)(; Escape cancels\.|; Escape keeps your words for later, Cancel discards them\.|\.)$/;
const SHORT_HINT = "Enter sends; Shift+Enter starts a new line.";

/** Text boxes that send nothing of their own, and why. */
const EXEMPT: [RegExp, string][] = [[/id="bt-\$\{esc\(id\)\}" class="btext" rows/, "unsaved text for a removed block can only be copied or discarded"]];

test("every text box on every page says how it sends, or is exempt with a reason", () => {
  const boxes = readdirSync(WEB)
    .filter((f) => f.endsWith(".js"))
    .flatMap((f) => [...readFileSync(new URL(f, WEB), "utf8").matchAll(/<textarea\b[^>]*>/g)].map((m) => ({ file: f, tag: m[0] })));
  assert.ok(boxes.length >= 10, "the pages' text boxes are found");
  for (const { file, tag: raw } of boxes) {
    if (EXEMPT.some(([re]) => re.test(raw))) continue;
    const src = readFileSync(new URL(file, WEB), "utf8");
    // A page may name a box's attributes once, as a constant (review.js's COMPOSER_SEND).
    const tag = raw.replace(/\$\{(\w+)\}/g, (all, name: string) => src.match(new RegExp(`const ${name} = '([^']*)'`))?.[1] ?? all);
    // The build page's block editor keeps its own key handling, for its formatting keys, through the same sendKey.
    const long = /data-send="long"/.test(tag) || (file === "build.js" && /class="btext/.test(tag));
    const short = /data-send="short"/.test(tag);
    assert.ok(long || short, `${file}: ${tag} says how it sends`);
  }
  // A text box made in code says how it sends too; the browser tests check the line under each box.
  for (const f of readdirSync(WEB).filter((x) => x.endsWith(".js"))) {
    const src = readFileSync(new URL(f, WEB), "utf8");
    if (/createElement\(\s*["']textarea["']/.test(src)) assert.match(src, /dataset\.send\s*=/, `${f} makes a text box that says how it sends`);
  }
  // No page reads Enter for a text box on its own.
  for (const f of readdirSync(WEB).filter((x) => x.endsWith(".js") && x !== "send.js")) {
    const src = readFileSync(new URL(f, WEB), "utf8");
    assert.doesNotMatch(
      src,
      /\.steer-form textarea"\)\) \{|e\.key === "Enter" && \(e\.metaKey \|\| e\.ctrlKey/,
      `${f} sends from a text box through web/send.js`,
    );
  }
});

/** The words under a box that say how it sends. */
const hintOf = (box: Locator) =>
  box.evaluate((el) =>
    (el.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .find((t) => t.includes("Enter")),
  );

/** A keydown for Enter, with Ctrl and ⌘ held when `ctrl`: while an input method composes, or as a held key repeats. */
const oddEnter = (box: Locator, ctrl: boolean, how: { isComposing?: boolean; repeat?: boolean }) =>
  box.evaluate(
    (el, [mod, extra]) =>
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: mod, metaKey: mod, bubbles: true, cancelable: true, ...extra })),
    [ctrl, how] as const,
  );
const composingEnter = (box: Locator, ctrl: boolean) => oddEnter(box, ctrl, { isComposing: true });

/**
 * Every text box open on the page says how it sends: it is marked to send, and its aria-describedby
 * names an element that holds the line naming the key. Boxes that send nothing of their own are left out.
 */
async function everyBoxSays(page: Page, what: string) {
  const boxes = await page.locator("textarea").evaluateAll((els) =>
    els
      .filter((el) => !el.closest(".orphan"))
      .map((el) => ({
        id: el.id,
        marked: el.hasAttribute("data-send") || el.classList.contains("btext"),
        hint: (el.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .find((t) => t.includes("Enter")),
      })),
  );
  assert.ok(boxes.length > 0, `${what}: a text box is open`);
  for (const box of boxes) {
    assert.ok(box.marked, `${what}: #${box.id} says how it sends`);
    assert.ok(box.hint && (LONG_HINT.test(box.hint) || box.hint === SHORT_HINT), `${what}: #${box.id} names the line under it (${box.hint})`);
  }
}

const settle = (page: Page) => page.waitForTimeout(300);

/**
 * Checks a box for long text: its hint, that plain Enter starts a new line, that Enter while composing
 * sends nothing, then that `key` (Ctrl+Enter or Meta+Enter) sends `text`, which `sent` waits for.
 */
async function sendsLong(page: Page, box: Locator, what: string, text: string, sent: () => Promise<unknown>, key = "Control+Enter") {
  await box.waitFor();
  await everyBoxSays(page, what);
  assert.match((await hintOf(box)) ?? "", LONG_HINT, `${what}: the line under it names the key`);
  await box.fill("One");
  await box.press("Enter");
  await box.pressSequentially("two");
  assert.equal(await box.inputValue(), "One\ntwo", `${what}: plain Enter starts a new line`);
  await box.fill(text);
  assert.equal(await composingEnter(box, true), true, `${what}: Ctrl+Enter while composing is left to the input method`);
  await settle(page);
  assert.equal(await box.inputValue(), text, `${what}: nothing is sent while an input method composes`);
  assert.equal(await oddEnter(box, true, { repeat: true }), false, `${what}: a held Ctrl+Enter's repeat is taken`);
  await settle(page);
  assert.equal(await box.inputValue(), text, `${what}: a held key's repeat sends nothing`);
  await box.press(key);
  await sent();
}

/** Checks a box where Enter sends: its hint, Shift+Enter's new line, composing, then Enter sends `text`. */
async function sendsShort(page: Page, box: Locator, what: string, text: string, sent: () => Promise<unknown>) {
  await box.waitFor();
  await everyBoxSays(page, what);
  assert.equal(await hintOf(box), SHORT_HINT, `${what}: the line under it names the key`);
  await box.fill("One");
  await box.press("Shift+Enter");
  await box.pressSequentially("two");
  assert.equal(await box.inputValue(), "One\ntwo", `${what}: Shift+Enter starts a new line`);
  await box.fill(text);
  assert.equal(await composingEnter(box, false), true, `${what}: Enter while composing is left to the input method`);
  await settle(page);
  assert.equal(await box.inputValue(), text, `${what}: nothing is sent while an input method composes`);
  assert.equal(await oddEnter(box, false, { repeat: true }), false, `${what}: a held Enter's repeat is taken`);
  await settle(page);
  assert.equal(await box.inputValue(), text, `${what}: a held key's repeat sends nothing`);
  await box.press("Enter");
  await sent();
}

const pending = (page: Page, text: string) => () => page.locator('.thread[data-comment="hide"]', { hasText: text }).waitFor();

test("the review page's comment, suggestion, reply, in-place edit and overall comment boxes send with Ctrl+Enter (#336)", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(example());
    hoop.comment(review_id, { item: "FR-2", line: 1, body: "Is the order fixed?" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/r/${review_id}`);
    await page.getByText("Export all orders as CSV").first().waitFor();
    const line = async (item: string, n: number) => {
      await page.locator(`[data-sel-item="${item}"][data-sel-line="${n - 1}"]`).hover();
      await page.getByRole("button", { name: `Comment on ${item} line ${n}` }).click();
    };

    // A comment on a line, then Escape cancels a second one.
    await line("FR-1", 2);
    await sendsLong(page, page.locator("#cbody"), "comment", "Say what a disconnect does.", pending(page, "Say what a disconnect does."));
    await line("FR-1", 1);
    await page.locator("#cbody").fill("Not this one");
    await page.locator("#cbody").press("Escape");
    await page.locator(".composer").waitFor({ state: "detached" });

    // A suggestion, sent from its own box, with ⌘+Enter.
    await line("FR-3", 1);
    await page.locator("#cbody").fill("Say inclusive.");
    await page.getByRole("button", { name: "Suggest a change" }).click();
    await sendsLong(
      page,
      page.locator("#csugg"),
      "suggestion",
      "When from or to are given, include orders created in that range, inclusive.",
      pending(page, "Say inclusive."),
      "Meta+Enter",
    );

    // A reply on Claude's comment.
    await page.locator(".thread", { hasText: "Is the order fixed?" }).getByRole("button", { name: "Reply" }).click();
    await sendsLong(page, page.locator("#cbody"), "reply", "Yes, fixed.", pending(page, "Yes, fixed."));

    // An edit in place, sent from its note.
    await page.locator('[data-sel-item="FR-2"][data-sel-line="0"]').hover();
    await page.getByRole("button", { name: "Edit FR-2 line 1 in place" }).click();
    await page.locator("#csugg").fill("Each row shall contain id, status and total, in that order.");
    await sendsLong(page, page.locator(".in-place #cbody"), "in-place edit", "Fewer columns.", pending(page, "Fewer columns."));

    // The overall comment sends the review.
    await page.locator("#finishBtn").click();
    await sendsLong(page, page.locator("#summary"), "overall comment", "Close. A few changes.", () => page.getByText(/Review submitted/).waitFor());
    assert.match(JSON.stringify(hoop.feedback(review_id)), /Close\. A few changes\./);
    assert.deepEqual(errors, []);
  }),
);

test(
  "Escape in the review page's comment, suggestion or edit box cancels but keeps the text, which comes back on that line (#336)",
  { skip: BROWSER_SKIP },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const { review_id } = hoop.submit(example());
      await page.goto(`${base}/r/${review_id}`);
      await page.getByText("Export all orders as CSV").first().waitFor();
      const line = async (item: string, n: number) => {
        await page.locator(`[data-sel-item="${item}"][data-sel-line="${n - 1}"]`).hover();
        await page.getByRole("button", { name: `Comment on ${item} line ${n}` }).click();
        await page.locator("#cbody").waitFor();
      };
      const pressEscape = async (box: string) => {
        await page.locator(box).press("Escape");
        await page.locator(".composer").waitFor({ state: "detached" });
      };

      // A comment: Escape keeps it for its line; another line starts empty; Cancel throws it away.
      await line("FR-1", 2);
      await page.locator("#cbody").fill("Say what a disconnect does.");
      await pressEscape("#cbody");
      await line("FR-2", 1);
      assert.equal(await page.locator("#cbody").inputValue(), "", "another line's box starts empty");
      await pressEscape("#cbody");
      await line("FR-1", 2);
      assert.equal(await page.locator("#cbody").inputValue(), "Say what a disconnect does.", "the line's comment comes back");
      await page.locator("#cancelComment").click();
      await line("FR-1", 2);
      assert.equal(await page.locator("#cbody").inputValue(), "", "Cancel throws the comment away");
      await pressEscape("#cbody");

      // A suggestion comes back with its comment, from Escape in either box.
      await line("FR-3", 1);
      await page.locator("#cbody").fill("Say inclusive.");
      await page.getByRole("button", { name: "Suggest a change" }).click();
      await page.locator("#csugg").fill("Include orders created in that range, inclusive.");
      await pressEscape("#csugg");
      await line("FR-3", 1);
      assert.equal(await page.locator("#cbody").inputValue(), "Say inclusive.");
      assert.equal(await page.locator("#csugg").inputValue(), "Include orders created in that range, inclusive.", "the suggestion comes back");

      // An edit in place comes back when the line is edited in place again.
      await page.locator("#cancelComment").click();
      await page.locator('[data-sel-item="FR-2"][data-sel-line="0"]').hover();
      await page.getByRole("button", { name: "Edit FR-2 line 1 in place" }).click();
      await page.locator("#csugg").fill("Each row shall contain id, status and total.");
      await page.locator(".in-place #cbody").fill("Fewer columns.");
      await pressEscape(".in-place #cbody");
      await page.locator('[data-sel-item="FR-2"][data-sel-line="0"]').hover();
      await page.getByRole("button", { name: "Edit FR-2 line 1 in place" }).click();
      assert.equal(await page.locator("#csugg").inputValue(), "Each row shall contain id, status and total.", "the edit comes back");
      assert.equal(await page.locator(".in-place #cbody").inputValue(), "Fewer columns.");
      assert.equal(hoop.feedback(review_id).status, "pending", "nothing was sent");
    }),
);

test(
  "words Escape keeps are drafts: they survive a reload, follow their line to a new revision, and turn stale when it changed (#336)",
  { skip: BROWSER_SKIP },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const { review_id } = hoop.submit(example());
      await page.goto(`${base}/r/${review_id}`);
      await page.getByText("Export all orders as CSV").first().waitFor();
      const plus = async (item: string, n: number) => {
        await page.locator(`[data-sel-item="${item}"][data-sel-line="${n - 1}"]`).hover();
        await page.getByRole("button", { name: `Comment on ${item} line ${n}` }).click();
        await page.locator("#cbody").waitFor();
      };
      const away = async () => {
        await page.locator("#cbody").press("Escape");
        await page.locator(".composer").waitFor({ state: "detached" });
      };

      // A comment narrowed with "Only about this text" comes back from the line's +, still narrowed.
      await plus("FR-2", 1);
      await page.locator("#cpart").fill("createdAt");
      await page.locator("#cbody").fill("ISO 8601 in UTC.");
      await away();
      await plus("FR-2", 1);
      assert.equal(await page.locator("#cbody").inputValue(), "ISO 8601 in UTC.", "the narrowed comment comes back");
      assert.equal(await page.locator(".composer .quote").innerText(), "createdAt", "still on the words it was narrowed to");
      await away();

      // A reload keeps them, like an open box's words.
      await plus("FR-3", 1);
      await page.locator("#cbody").fill("Inclusive?");
      await away();
      await page.reload();
      await page.getByText("Export all orders as CSV").first().waitFor();
      await plus("FR-3", 1);
      assert.equal(await page.locator("#cbody").inputValue(), "Inclusive?", "a reload keeps the words Escape put away");
      await away();

      // A new revision moves FR-2's line down and rewrites FR-3's: the first follows its line, the second turns stale.
      hoop.review(review_id, { verdict: "changes_requested", comments: [{ item: "FR-1", line: 1, body: "More detail." }] });
      hoop.receive(review_id);
      const next = example();
      const fr2 = next.items[1].body;
      next.items[1].body = `Rows shall be comma-separated.\n${fr2}`;
      next.items[2].body = "When from or to are given, the system shall include only orders created at or after from and before to.";
      hoop.submit({ ...next, review_id });
      await page.reload();
      await page.getByText("Export all orders as CSV").first().waitFor();
      await plus("FR-2", 2);
      assert.equal(await page.locator("#cbody").inputValue(), "ISO 8601 in UTC.", "the comment followed its line");
      await away();
      await plus("FR-3", 1);
      assert.equal(await page.locator("#cbody").inputValue(), "", "a changed line's box starts empty");
      await away();
      const stale = page.locator(".stale-drafts li");
      await stale.filter({ hasText: "Inclusive?" }).waitFor();
      assert.equal(await stale.count(), 1, "the changed line's words wait as one stale draft");

      // Escape while placing that stale draft again doesn't copy it: the stale list already holds its words.
      await stale.getByRole("button", { name: "Place again" }).click();
      await plus("FR-3", 1);
      assert.equal(await page.locator("#cbody").inputValue(), "Inclusive?");
      await away();
      await settle(page);
      assert.equal(await stale.count(), 1, "still one stale draft");
      await plus("FR-3", 1);
      assert.equal(await page.locator("#cbody").inputValue(), "", "nothing was kept twice");
    }),
);

test("kept words and stale drafts never swap or break: placing, replies, old drafts and Other answers (#336)", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(exampleWithQuestion());
    const thread = hoop.comment(review_id, { item: "FR-2", line: 1, body: "Is the order fixed?" }).comments[0]!.thread!;
    await page.goto(`${base}/r/${review_id}`);
    await page.getByText("Export all orders as CSV").first().waitFor();
    const plus = async (item: string, n: number) => {
      await page.locator(`[data-sel-item="${item}"][data-sel-line="${n - 1}"]`).hover();
      await page.getByRole("button", { name: `Comment on ${item} line ${n}` }).click();
      await page.locator("#cbody").waitFor();
    };
    const keep = async (words: string) => {
      await page.locator("#cbody").fill(words);
      await page.locator("#cbody").press("Escape");
      await page.locator(".composer").waitFor({ state: "detached" });
    };
    const reply = () => page.locator(`.thread:has([data-reply="${thread}"])`).getByRole("button", { name: "Reply" }).click();

    // Kept: a comment on a line the next revision rewrites, one on a line it keeps, a reply, and an Other answer.
    await plus("FR-1", 2);
    await keep("Old line words");
    await plus("FR-3", 1);
    await keep("Kept here");
    await reply();
    await keep("Yes, fixed.");
    await page.locator("#q-Q-1-other").check();
    await keep("Neither: a read replica");

    hoop.review(review_id, { verdict: "changes_requested", comments: [{ item: "FR-3", line: 1, body: "Sent." }] });
    hoop.receive(review_id);
    const next = exampleWithQuestion();
    next.items[0].body = "When a client calls GET /orders/export, the system shall respond with a CSV file of all orders.\nRows shall stream as they are read.";
    next.items[1].body = "Each row shall contain id, status and total, in that order.";
    next.items.find((i: { id: string }) => i.id === "Q-1").title = "Which store should orders come from?";
    hoop.submit({ ...next, review_id });
    await page.reload();
    await page.getByText("Export all orders as CSV").first().waitFor();

    // An Other answer whose question changed shows as a comment with its words, and can be placed again.
    const stale = page.locator(".stale-drafts li");
    const other = stale.filter({ hasText: "Neither: a read replica" });
    await other.waitFor();
    assert.doesNotMatch(await other.innerText(), /undefined/);
    assert.equal(await other.getByRole("button", { name: "Place again" }).count(), 1, "the Other answer's words can be placed again");

    // A reply stays kept while its line exists, though Claude rewrote it.
    await reply();
    assert.equal(await page.locator("#cbody").inputValue(), "Yes, fixed.", "the kept reply comes back as a reply");
    assert.equal(await page.locator('label[for="cbody"]').innerText(), "Reply");
    await page.locator("#cancelComment").click();

    // Placing the rewritten line's words on a line with kept words brings the stale words, and keeps both.
    await stale.filter({ hasText: "Old line words" }).getByRole("button", { name: "Place again" }).click();
    await plus("FR-3", 1);
    assert.equal(await page.locator("#cbody").inputValue(), "Old line words", "placing brings the stale draft's words");
    await page.locator("#cbody").press("Escape");
    await page.locator(".composer").waitFor({ state: "detached" });
    await plus("FR-3", 1);
    assert.equal(await page.locator("#cbody").inputValue(), "Kept here", "the line's kept words are still kept");
    await stale.filter({ hasText: "Old line words" }).waitFor();
  }),
);

test("a comment box restored from drafts an older page saved is kept by Escape like any other (#336)", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(example());
    await page.goto(`${base}/r/${review_id}`);
    await page.getByText("Export all orders as CSV").first().waitFor();
    const text = await page.locator('[data-sel-item="FR-3"][data-sel-line="0"]').innerText();
    // As the page saved an open box before it recorded how the box was opened.
    await page.evaluate(
      ([id, t]) =>
        localStorage.setItem(
          `hoop:${id}:drafts`,
          JSON.stringify({ revision: 1, composer: { item: "FR-3", line: 0, body: "From the old page", suggest: false, text: t } }),
        ),
      [review_id, text],
    );
    await page.reload();
    await page.locator("#cbody").waitFor();
    assert.equal(await page.locator("#cbody").inputValue(), "From the old page");
    await page.locator("#cbody").press("Escape");
    await page.locator(".composer").waitFor({ state: "detached" });
    await page.locator('[data-sel-item="FR-3"][data-sel-line="0"]').hover();
    await page.getByRole("button", { name: "Comment on FR-3 line 1" }).click();
    assert.equal(await page.locator("#cbody").inputValue(), "From the old page", "the old box's words come back");
    const kept = await page.evaluate((id) => JSON.parse(localStorage.getItem(`hoop:${id}:drafts`) ?? "{}").kept, review_id);
    assert.deepEqual(kept, [], "nothing is left kept out of sight");
  }),
);

test("an in-place edit Escape kept never undoes an edit accepted on its line since (#336)", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(example());
    const thread = hoop.comment(review_id, { item: "FR-2", line: 1, body: "Fewer columns?" }).comments[0]!.thread!;
    await page.goto(`${base}/r/${review_id}`);
    await page.getByText("Export all orders as CSV").first().waitFor();
    const edit = async () => {
      await page.locator('[data-sel-item="FR-2"][data-sel-line="0"]').hover();
      await page.getByRole("button", { name: "Edit FR-2 line 1 in place" }).click();
      await page.locator("#csugg").waitFor();
    };
    await edit();
    await page.locator("#csugg").fill("Each row shall contain id and total.");
    await page.locator("#csugg").press("Escape");
    await page.locator(".composer").waitFor({ state: "detached" });

    const { proposals } = hoop.proposeEdits(review_id, thread, [{ item: "FR-2", line: 1, find: "customerId, ", replace: "" }]);
    hoop.decideEdit(review_id, proposals[0]!.id, "accept");
    await page.reload();
    await page.getByText("Export all orders as CSV").first().waitFor();
    await edit();
    assert.equal(
      await page.locator("#csugg").inputValue(),
      "Each row shall contain id, status, total and createdAt, in that order.",
      "the box opens on the line as it reads now",
    );
    await page.locator(".stale-drafts li", { hasText: "Each row shall contain id and total." }).waitFor();
  }),
);

test("focus goes back to what opened the review page's comment box or verdict panel when it closes or sends (#336)", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(example());
    hoop.comment(review_id, { item: "FR-2", line: 1, body: "Is the order fixed?" });
    await page.goto(`${base}/r/${review_id}`);
    await page.getByText("Export all orders as CSV").first().waitFor();
    const focused = () =>
      page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.id ?? document.activeElement?.tagName);
    const closed = () => page.locator(".composer").waitFor({ state: "detached" });
    const plus = async () => {
      await page.locator('[data-sel-item="FR-1"][data-sel-line="1"]').hover();
      await page.getByRole("button", { name: "Comment on FR-1 line 2" }).click();
      await page.locator("#cbody").waitFor();
    };

    // A line's +: Escape, Cancel and Ctrl+Enter each put focus back on it.
    await plus();
    await page.locator("#cbody").press("Escape");
    await closed();
    assert.equal(await focused(), "Comment on FR-1 line 2", "Escape returns to the line's +");
    await page.locator("#cbody").waitFor({ state: "detached" });
    await plus();
    await page.locator("#cancelComment").click();
    await closed();
    assert.equal(await focused(), "Comment on FR-1 line 2", "Cancel returns to the line's +");
    await plus();
    await page.locator("#cbody").fill("Say what a disconnect does.");
    await page.locator("#cbody").press("Control+Enter");
    await closed();
    assert.equal(await focused(), "Comment on FR-1 line 2", "a comment added returns to the line's +");

    // Edit in place and Reply get focus back.
    await page.locator('[data-sel-item="FR-3"][data-sel-line="0"]').hover();
    await page.getByRole("button", { name: "Edit FR-3 line 1 in place" }).click();
    await page.locator("#csugg").press("Escape");
    await closed();
    assert.equal(await focused(), "Edit FR-3 line 1 in place");
    await page.locator(".thread", { hasText: "Is the order fixed?" }).getByRole("button", { name: "Reply" }).click();
    await page.locator("#cbody").press("Escape");
    await closed();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Reply", "Escape returns to Reply");

    // Comment on selection: the bar's button is gone once the box opens, so focus goes to the line's +.
    await page.locator('[data-sel-item="FR-3"][data-sel-line="0"]').evaluate((el) => {
      const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;
      const r = document.createRange();
      r.setStart(node, 0);
      r.setEnd(node, 4);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Comment on selection" }).click();
    await page.locator("#cbody").press("Escape");
    await closed();
    assert.equal(await focused(), "Comment on FR-3 line 1", "a comment on selected words returns to its line's +");

    // The verdict panel: Escape in its comment returns to the verdict button.
    await page.locator("#finishBtn").click();
    await page.locator("#summary").press("Escape");
    await page.locator("#finishPop").waitFor({ state: "hidden" });
    assert.equal(await focused(), "finishBtn");
  }),
);

test("on a review opened from a file, Request changes says what is kept, not that Claude revises (#336)", { skip: BROWSER_SKIP }, async () => {
  await withBrowser(
    async ({ hoop, base, page }) => {
      const file = join(tempHome(), "brief.md");
      writeFileSync(file, "# Brief\n\nWhat we build next.\n");
      const { review_id } = hoop.open(file);
      await page.goto(`${base}/r/${review_id}`);
      await page.getByText("What we build next.").first().waitFor();
      await page
        .getByRole("button", { name: /^Comment on / })
        .first()
        .click();
      await page.locator("#cbody").fill("Say when.");
      await page.locator("#cbody").press("Control+Enter");
      await page.locator(".composer").waitFor({ state: "detached" });
      assert.equal(await page.locator("#finishBtn").getAttribute("data-verdict"), "changes_requested");
      await page.locator("#finishBtn").click();
      const note = await page.locator("#finishPop .hint").first().innerText();
      assert.match(note, /No session revises a review opened from a file/);
      assert.doesNotMatch(note, /Claude revises/);
    },
    new Hoop(new Store(tempHome()), null),
  );
});

test("a quick question's note sends with Ctrl+Enter, with the answer picked, once per press (#336)", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.ask({
      questions: [
        { question: "Keep the old endpoint?", options: [{ label: "Keep it as an alias", recommended: true }, { label: "Remove it" }] },
        { question: "Which format?", options: [{ label: "CSV" }, { label: "JSON", recommended: true }] },
      ],
    });
    const answers = await slowPosts(page, /^\/api\/reviews\/[^/]+\/answer$/);
    await page.goto(`${base}/r/${id}`);
    const note = page.locator("#note-Q1");
    await note.waitFor();
    assert.equal(
      await hintOf(note),
      `${await page.evaluate(() => (/Mac/.test(navigator.platform) ? "⌘" : "Ctrl"))}+Enter sends.`,
      "the note says how it sends",
    );

    // With no answer picked, Ctrl+Enter sends nothing and goes to the first option.
    await note.fill("Two clients left");
    await note.press("Enter");
    await note.pressSequentially("both internal");
    assert.equal(await note.inputValue(), "Two clients left\nboth internal", "Enter starts a new line");
    await note.press("Control+Enter");
    assert.ok(await hasFocus(page.locator('[data-q="Q1"][data-choice="A"]')), "focus goes to the first option to pick one");
    assert.equal(answers.length, 0, "nothing is sent without an answer");

    // With an answer picked, the note goes with it; composing sends nothing, and a second press while it is on its way sends nothing more.
    await page.locator('[data-q="Q1"][data-choice="B"]').click();
    await page.locator('[data-q="Q1"][data-choice="B"][aria-pressed="true"]').waitFor();
    await settle(page);
    assert.equal(answers.length, 1);
    await note.fill("Both are internal.");
    assert.equal(await composingEnter(note, true), true, "Ctrl+Enter while composing is left to the input method");
    await settle(page);
    assert.equal(answers.length, 1, "nothing is sent while composing");
    await note.press("Control+Enter");
    await note.press("Control+Enter").catch(() => {});
    await page.locator(".ask-status", { hasText: /./ }).waitFor();
    await settle(page);
    assert.equal(answers.length, 2, "Ctrl+Enter twice sends the answer once");
    assert.deepEqual(JSON.parse(answers[1]!), { question: "Q1", choice: "B", note: "Both are internal." });
  }),
);

test(
  "a quick question's answers to different questions all go while one is on its way, and a note goes with the Other box's words (#336)",
  { skip: BROWSER_SKIP },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const { review_id: id } = hoop.ask({
        questions: [
          { question: "Keep the old endpoint?", options: [{ label: "Keep it as an alias", recommended: true }, { label: "Remove it" }] },
          { question: "Which format?", options: [{ label: "CSV" }, { label: "JSON", recommended: true }] },
        ],
      });
      const answers = await slowPosts(page, /^\/api\/reviews\/[^/]+\/answer$/);
      await page.goto(`${base}/r/${id}`);
      await page.locator('[data-q="Q1"][data-choice="B"]').waitFor();

      // Two questions answered while the first is on its way: both are sent.
      await page.locator('[data-q="Q1"][data-choice="B"]').click();
      await page.locator('[data-q="Q2"][data-choice="A"]').click();
      await page.locator('[data-q="Q2"][data-choice="A"][aria-pressed="true"]').waitFor();
      await settle(page);
      assert.deepEqual(
        answers.map((b) => JSON.parse(b).question),
        ["Q1", "Q2"],
        "each question's answer is sent",
      );

      // Other answered, then opened again with new words: Ctrl+Enter in the note sends the new words with it.
      await page.locator('[data-q="Q2"][data-other]').click();
      await page.locator("#other-Q2").fill("Avro");
      await page.locator("#other-Q2").press("Enter");
      await page.locator('[data-q="Q2"][data-other][aria-pressed="true"]').waitFor();
      await settle(page);
      await page.locator('[data-q="Q2"][data-other]').click();
      await page.locator("#other-Q2").fill("Parquet");
      await page.locator("#note-Q2").fill("For the warehouse.");
      await page.locator("#note-Q2").press("Control+Enter");
      await page.locator(".ask-q[data-q='Q2'] .ask-other").waitFor({ state: "detached" });
      await settle(page);
      assert.deepEqual(JSON.parse(answers.at(-1)!), { question: "Q2", choice: "other", text: "Parquet", note: "For the warehouse." });
    }),
);

test("on the review page, focus goes back to the Other option after its comment box closes or its answer is added (#336)", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(exampleWithQuestion());
    await page.goto(`${base}/r/${review_id}`);
    const other = page.locator("#q-Q-1-other");
    await other.waitFor();
    const open = async () => {
      await page.locator("#q-Q-1-a").check();
      await other.check();
      await page.locator("#cbody").waitFor();
    };
    const closed = () => page.locator(".composer").waitFor({ state: "detached" });
    const onOther = () => page.evaluate(() => document.activeElement?.id);

    await open();
    await page.locator("#cbody").press("Escape");
    await closed();
    assert.equal(await onOther(), "q-Q-1-other", "Escape returns to Other");
    await open();
    await page.locator("#cancelComment").click();
    await closed();
    assert.equal(await onOther(), "q-Q-1-other", "Cancel returns to Other");
    await open();
    await page.locator("#cbody").fill("A read replica.");
    await page.locator("#cbody").press("Control+Enter");
    await closed();
    assert.equal(await onOther(), "q-Q-1-other", "adding the answer returns to Other");
  }),
);

/** Every hint and shortcut title names ⌘ on a Mac and Ctrl elsewhere, on the review and build pages. */
test("hints and shortcut titles say ⌘ on a Mac and Ctrl elsewhere (#336)", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, browser }) => {
    const { review_id } = hoop.submit(example());
    const build = hoop.startBuild(OUTLINE).review_id;
    for (const [platform, mod] of [
      ["MacIntel", "⌘"],
      ["Win32", "Ctrl"],
    ] as const) {
      const page = await browser.newPage();
      // The browser tells the page it runs on this platform, as it would on that machine.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setUserAgentOverride", { userAgent: await page.evaluate(() => navigator.userAgent), platform });
      await page.goto(`${base}/r/${review_id}`);
      await page.locator('[data-sel-item="FR-1"][data-sel-line="1"]').hover();
      await page.getByRole("button", { name: "Comment on FR-1 line 2" }).click();
      assert.equal(
        await page.locator("#csendHint").innerText(),
        `${mod}+Enter adds; Escape keeps your words for later, Cancel discards them.`,
        `${platform}: the review page's hint`,
      );

      await page.goto(`${base}/r/${build}`);
      await page.getByRole("button", { name: "Add a brief" }).click();
      assert.equal(await page.locator("#bb-hint").innerText(), `${mod}+Enter saves; Escape cancels.`, `${platform}: the brief's hint`);
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: /^Edit Paragraph/ })
        .first()
        .click();
      const bold = page.getByRole("button", { name: /^Bold in Paragraph/ }).first();
      assert.equal(await bold.getAttribute("title"), `Bold (${mod}+B)`, `${platform}: the build page's shortcut title`);
      assert.equal(await page.locator(".bblock.editing .hint").innerText(), `${mod}+Enter previews; Escape cancels.`, `${platform}: the block's hint`);
      await page.close();
    }
  }),
);

// b1 # Cutting cloud cost, b2 paragraph, b3 ## Where the money goes
const OUTLINE = "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n";

test("the build page's brief, block text, outline notes and comment boxes send with Ctrl+Enter (#336)", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const id = hoop.startBuild(OUTLINE).review_id;
    const bare = hoop.startBuild("# Saving energy\n").review_id;
    await page.addInitScript(() => Object.assign(window, { HOOP_BUILD_MS: 200 }));
    await page.goto(`${base}/r/${id}`);
    await page.locator(".bblock").first().waitFor();

    await page.getByRole("button", { name: "Add a brief" }).click();
    await sendsLong(page, page.getByLabel("Anything else"), "brief", "Cite numbers.", () => page.locator(".bbrief").waitFor());
    assert.equal(hoop.builds.read(id).brief?.notes, "Cite numbers.");

    await page
      .getByRole("button", { name: /^Edit Paragraph/ })
      .first()
      .click();
    await sendsLong(page, page.getByLabel(/^Text of Paragraph/), "block text", "What this helps us decide.", () =>
      page.locator(".bblock.editing").waitFor({ state: "detached" }),
    );
    assert.match(hoop.markdownOf(id), /What this helps us decide\./);

    await page
      .getByRole("button", { name: /^Comment on Paragraph/ })
      .first()
      .click();
    await sendsLong(page, page.getByLabel(/^Comment on Paragraph .* for Claude$/), "comment", "Shorter, please.", () => page.locator(".bthread").waitFor());
    assert.equal(hoop.takeRequests(id)[0]?.comment, "Shorter, please.");

    await page.goto(`${base}/r/${bare}`);
    await page.getByRole("button", { name: "Suggest an outline for Title “Saving energy”" }).click();
    await sendsLong(page, page.getByLabel("Notes for Claude (optional)"), "outline notes", "For finance.", () =>
      page.locator(".bstatus", { hasText: "Queued: Claude suggests an outline" }).waitFor(),
    );
    assert.equal(hoop.builds.read(bare).requests?.[0]?.note, "For finance.");
  }),
);

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();

test("the Work page's comment sends with Enter and its todo description with Ctrl+Enter, never while composing (#336)", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  for (const [id, subject] of [
    ["1", "Read the code"],
    ["2", "Write the migration"],
  ])
    workHook(home, { ...structuredClone(HOOKS["post-taskcreate"]), tool_input: { subject }, tool_response: { task: { id, subject } } }, at(1));
  await withBrowser(
    async ({ page, base }) => {
      await page.addInitScript(() => Object.assign(window, { HOOP_WORK_MS: 200 }));
      await page.goto(`${base}/work`);
      const todo = (id: string) => page.locator(`section.work-session .todo[data-todo="${id}"]`);
      await todo("2").waitFor();

      await todo("2")
        .getByRole("button", { name: /^Comment/ })
        .click();
      await sendsShort(page, page.getByLabel("Comment on todo #2"), "comment", "Mind the old rows", () =>
        todo("2").locator(".note", { hasText: "Mind the old rows" }).waitFor(),
      );

      await todo("1").getByRole("button", { name: /^Edit/ }).click();
      // A description runs to paragraphs, so it sends with Ctrl+Enter, and Enter starts a new line.
      await sendsLong(page, page.getByLabel("Description of todo #1"), "description", "Start with src/work.ts", () =>
        todo("1").locator(".note", { hasText: "edited its description" }).waitFor(),
      );
    },
    new Hoop(new Store(home)),
  );
});

test("on the Work page a second send before the first answers sends nothing, and Escape never cancels while composing (#336)", {
  skip: BROWSER_SKIP,
}, async () => {
  const home = tempHome();
  workHook(
    home,
    { ...structuredClone(HOOKS["post-taskcreate"]), tool_input: { subject: "Read the code" }, tool_response: { task: { id: "1", subject: "Read the code" } } },
    at(1),
  );
  await withBrowser(
    async ({ page, base }) => {
      const changes = await slowPosts(page, /^\/api\/work\/[^/]+\/changes$/);
      await page.addInitScript(() => Object.assign(window, { HOOP_WORK_MS: 200 }));
      await page.goto(`${base}/work`);
      const todo = page.locator('section.work-session .todo[data-todo="1"]');
      await todo.waitFor();

      // Escape while an input method composes leaves the form open.
      await todo.getByRole("button", { name: /^Comment/ }).click();
      const box = page.getByLabel("Comment on todo #1");
      await box.fill("Mind the old rows");
      await box.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true })));
      await settle(page);
      assert.equal(await box.inputValue(), "Mind the old rows", "the form stays open while an input method composes");

      // Enter, then a click on Send before the first answers: one comment.
      await box.press("Enter");
      await page
        .locator(".steer-form")
        .getByRole("button", { name: "Send" })
        .click({ timeout: 300 })
        .catch(() => {});
      await todo.locator(".note", { hasText: "Mind the old rows" }).waitFor();
      await settle(page);
      assert.equal(changes.length, 1, "Enter and a click send one comment");

      // Ctrl+Enter twice in a new todo's description: one todo.
      await page.getByRole("button", { name: "Add todo" }).click();
      await page.getByLabel("Subject of the new todo").fill("Write the docs");
      const about = page.getByLabel("Description of the new todo (optional)");
      await about.fill("Cover the flags");
      await about.press("Control+Enter");
      await about.press("Control+Enter").catch(() => {});
      await page.locator(".steer-form").waitFor({ state: "detached" });
      await settle(page);
      assert.deepEqual(
        changes.map((c) => JSON.parse(c).changes[0].kind),
        ["comment", "add"],
        "Ctrl+Enter twice adds one todo",
      );
    },
    new Hoop(new Store(home)),
  );
});

test("on the Work page a send's answer leaves alone a form opened after it (#336)", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  for (const [id, subject] of [
    ["1", "Read the code"],
    ["2", "Write the migration"],
  ])
    workHook(home, { ...structuredClone(HOOKS["post-taskcreate"]), tool_input: { subject }, tool_response: { task: { id, subject } } }, at(1));
  await withBrowser(
    async ({ page, base }) => {
      // The first comment is held, then answered; the second is held, then refused.
      let refuse = false;
      await page.route(
        (url) => /^\/api\/work\/[^/]+\/changes$/.test(url.pathname),
        async (route) => {
          await new Promise((r) => setTimeout(r, 800));
          if (refuse) await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Refused for the test" }) });
          else await route.continue();
        },
      );
      await page.addInitScript(() => Object.assign(window, { HOOP_WORK_MS: 200 }));
      await page.goto(`${base}/work`);
      const todo = (id: string) => page.locator(`section.work-session .todo[data-todo="${id}"]`);
      await todo("1").waitFor();

      for (const [answer, words] of [
        ["answered", "Mind the old rows"],
        ["refused", "And the new ones"],
      ] as const) {
        refuse = answer === "refused";
        await todo("2")
          .getByRole("button", { name: /^Comment/ })
          .click();
        await page.getByLabel("Comment on todo #2").fill(words);
        await page.getByLabel("Comment on todo #2").press("Enter");
        // Escape closes the form while its send is on its way, and the person opens another.
        await page.getByLabel("Comment on todo #2").press("Escape");
        await todo("1").getByRole("button", { name: /^Edit/ }).click();
        const field = page.getByLabel("New text for todo #1");
        await field.fill("Read the code and the docs");
        await page.waitForTimeout(1200);
        assert.equal(await field.inputValue(), "Read the code and the docs", `${answer}: the new form stays open with its text`);
        assert.equal(await page.locator(".steer-error").innerText(), "", `${answer}: the first send's answer shows nothing in the new form`);
        assert.equal(await field.getAttribute("aria-invalid"), null, `${answer}: the new form isn't marked invalid`);
        await field.press("Escape");
        await page.locator(".steer-form").waitFor({ state: "detached" });
      }
    },
    new Hoop(new Store(home)),
  );
});

/** Holds each POST to `path` for a moment, so a second send lands while the first is on its way; returns their bodies. */
async function slowPosts(page: Page, path: RegExp) {
  const seen: string[] = [];
  await page.route(
    (url) => path.test(url.pathname),
    async (route) => {
      if (route.request().method() === "POST") {
        seen.push(route.request().postData() ?? "");
        await new Promise((r) => setTimeout(r, 600));
      }
      await route.continue();
    },
  );
  return seen;
}

test("a second press before the first send answers sends nothing: Ctrl+Enter twice, or a double click (#336)", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    // The review page: Ctrl+Enter twice in the overall comment, then a double click on Submit review.
    const { review_id } = hoop.submit(example());
    const reviews = await slowPosts(page, /^\/api\/reviews\/[^/]+\/feedback$/);
    await page.goto(`${base}/r/${review_id}`);
    await page.getByText("Export all orders as CSV").first().waitFor();
    await page.locator("#finishBtn").click();
    await page.locator("#summary").fill("Once.");
    await page.locator("#summary").press("Control+Enter");
    await page.locator("#summary").press("Control+Enter");
    await page.getByText(/Review submitted/).waitFor();
    await settle(page);
    assert.equal(reviews.length, 1, "Ctrl+Enter twice submits the review once");
    await page.locator("#finishBtn").click();
    await page.locator("#summary").fill("Twice?");
    await page.locator("#submitReview").dblclick();
    await page.locator("#finishPop").waitFor({ state: "hidden" });
    await settle(page);
    assert.equal(reviews.length, 2, "a double click on Submit review submits it once");

    // The build page: a comment for Claude by Ctrl+Enter twice and by a double click, and outline notes by a double click.
    const id = hoop.startBuild(OUTLINE).review_id;
    const builds = await slowPosts(page, /^\/api\/reviews\/[^/]+\/build$/);
    await page.goto(`${base}/r/${id}`);
    await page.locator(".bblock").first().waitFor();
    const comment = async (text: string, how: (box: Locator) => Promise<void>) => {
      await page
        .getByRole("button", { name: /^Comment on Paragraph/ })
        .first()
        .click();
      const box = page.getByLabel(/^Comment on Paragraph .* for Claude$/);
      await box.fill(text);
      await how(box);
      await page.locator(".bcomment-form").waitFor({ state: "detached" });
    };
    await comment("Shorter", async (box) => {
      await box.press("Control+Enter");
      await box.press("Control+Enter");
    });
    await comment("Simpler", () => page.locator(".bcomment-form").getByRole("button", { name: "Send", exact: true }).dblclick());
    await settle(page);
    assert.deepEqual(
      hoop.takeRequests(id).map((r) => r.comment),
      ["Shorter", "Simpler"],
      "each comment is sent once",
    );
    assert.equal(builds.length, 2);

    const bare = hoop.startBuild("# Saving energy\n").review_id;
    await page.goto(`${base}/r/${bare}`);
    await page.getByRole("button", { name: "Suggest an outline for Title “Saving energy”" }).click();
    await page.getByLabel("Notes for Claude (optional)").fill("For finance.");
    await page.locator(".bgen").getByRole("button", { name: "Suggest an outline" }).dblclick();
    await page.locator(".bstatus", { hasText: "Queued: Claude suggests an outline" }).waitFor();
    await settle(page);
    assert.equal(hoop.builds.read(bare).requests?.length, 1, "a double click asks for one outline");
  }),
);
