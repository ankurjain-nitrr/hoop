import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { BROWSER_SKIP, hasFocus, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";

// #336, Keyboard: the review page's keys, which never act inside a text box, the comment box, the
// verdict panel, a dialog or a popover, with a modifier, held down or while composing.

const DOC =
  "# Launch\n\nWhy this matters.\n\n## Steps\n\nShip on Monday.\n\nThen tell the clients.\n\n## Question: Which day?\n\n- A. Monday (recommended)\n- B. Friday\n";

/** What the focused control is named. */
const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "");

/** Opens the review with nothing focused. */
async function open(page: Page, url: string, ready = ".top h1") {
  await page.goto(url);
  await page.locator(ready).first().waitFor();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
}

/** Presses j until the focused line's name matches `name`, failing after `max` presses. */
async function jTo(page: Page, name: RegExp, max = 20) {
  for (let i = 0; i < max && !name.test(await focused(page)); i++) await page.keyboard.press("j");
  assert.match(await focused(page), name);
}

/** Sends a keydown the browser can't make from a keyboard here: held down, or while an input method composes. */
const dispatch = (page: Page, init: { key: string; repeat?: boolean; isComposing?: boolean }) =>
  page.evaluate(
    ({ key, repeat, isComposing }) =>
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, repeat, isComposing, bubbles: true, cancelable: true })),
    init,
  );

test("on a review page, j and k move between lines, c comments, s suggests and v marks the section viewed", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    await open(page, `${base}/r/${review_id}`);
    await page.keyboard.press("k");
    assert.match(await focused(page), /^Comment on "Question: Which day\?" line 2$/, "k from nowhere goes to the last line");
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("j");
    assert.match(await focused(page), /^Comment on the title/, "j from nowhere goes to the first line");
    await page.keyboard.press("j");
    await page.keyboard.press("k");
    assert.match(await focused(page), /^Comment on the title/, "k goes back");
    await jTo(page, /"Steps" line 1$/);
    await page.keyboard.press("c");
    await page.locator("#cbody").waitFor();
    assert.ok(await hasFocus(page.locator("#cbody"), 2000), "c opens the comment box on the line");
    await page.keyboard.type("jk cv");
    assert.equal(await page.locator("#cbody").inputValue(), "jk cv", "typing in the box types");
    await page.keyboard.press("Escape");
    await page.keyboard.press("s");
    await page.locator("#csugg").waitFor();
    assert.match(await page.locator("#csugg").inputValue(), /Ship on Monday\./, "s opens the line's text to suggest a change");
    await page.keyboard.press("Escape");
    assert.match(await focused(page), /"Steps" line 1$/, "Escape after s goes back to the line's +, as after c");
    await page.keyboard.press("v");
    assert.equal(await page.locator("#viewed-S-1").isChecked(), true, "v marks the line's section viewed");
    assert.ok(await hasFocus(page.locator("#viewed-S-1"), 2000), "focus stays on the section's Viewed");
    await page.keyboard.press("v");
    assert.equal(await page.locator("#viewed-S-1").isChecked(), false, "v again undoes it");
  }),
);

test("regression: a key on a comment box's button, or on another line while the box holds words, leaves the words", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    await open(page, `${base}/r/${review_id}`);
    await jTo(page, /"Steps" line 1$/);
    await page.keyboard.press("c");
    await page.locator("#cbody").fill("Which Monday?");
    // On the box's own buttons, c and s do nothing.
    for (const button of ["#toggleSuggest", "#cancelComment", "#addComment"]) {
      await page.locator(button).focus();
      await page.keyboard.press("c");
      await page.keyboard.press("s");
      assert.equal(await page.locator("#cbody").inputValue(), "Which Monday?", `c and s on ${button} keep the words`);
    }
    // On another line, c and s don't replace the box that holds words.
    await page.getByRole("button", { name: 'Comment on "Steps" line 2' }).focus();
    await page.keyboard.press("c");
    await page.keyboard.press("s");
    assert.equal(await page.locator("#cbody").inputValue(), "Which Monday?", "c and s on another line keep the words");
  }),
);

test("regression: s on a heading keeps a suggestion kept for it, and puts focus in it", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    await open(page, `${base}/r/${review_id}`);
    const heading = page.getByRole("button", { name: 'Comment on "Steps" heading (applies to everything under it)' });
    await heading.click();
    await page.locator("#toggleSuggest").click();
    await page.locator("#csugg").fill("## Rollout steps");
    await page.locator("#csugg").press("Escape");
    await heading.focus();
    await page.keyboard.press("s");
    await page.locator("#csugg").waitFor();
    assert.equal(await page.locator("#csugg").inputValue(), "## Rollout steps", "the kept suggestion comes back");
    assert.ok(await hasFocus(page.locator("#csugg"), 2000), "focus is in the suggestion");
  }),
);

test("regression: no key acts in the verdict panel, with a modifier, held down or while composing", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    await open(page, `${base}/r/${review_id}`);
    await page.locator("#finishBtn").click();
    await page.locator("#finishPop").waitFor();
    await page.locator("#cancelFinish").focus();
    await page.keyboard.press("j");
    assert.ok(await hasFocus(page.locator("#cancelFinish"), 1000), "j in the verdict panel does nothing");
    await page.keyboard.press("Escape");
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("j");
    const first = await focused(page);
    for (const chord of ["Control+j", "Alt+j", "Meta+j"]) {
      await page.keyboard.press(chord);
      assert.equal(await focused(page), first, `${chord} does nothing`);
    }
    await dispatch(page, { key: "j", repeat: true });
    assert.equal(await focused(page), first, "a held j does nothing");
    await dispatch(page, { key: "j", isComposing: true });
    assert.equal(await focused(page), first, "j while an input method composes does nothing");
  }),
);

test("on a review page, 1 to 4 and g answer the Question section focus is in, and j skips a folded section", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    await open(page, `${base}/r/${review_id}`);
    await page.getByRole("button", { name: /^Comment on "Question: Which day\?" line 2/ }).focus();
    await page.keyboard.press("2");
    assert.equal(await page.locator('input[data-q="S-2"][value="b"]').isChecked(), true, "2 picks the second option");
    assert.ok(await hasFocus(page.locator('input[data-q="S-2"][value="b"]'), 2000), "focus goes to the option picked");
    await page.keyboard.press("g");
    assert.equal(await page.locator('input[data-q="S-2"][value="a"]').isChecked(), true, "g picks the recommended one");
    assert.ok(await hasFocus(page.locator('input[data-q="S-2"][value="a"]'), 2000), "focus goes to the option g picked");
    // Steps marked viewed folds; j passes over its lines.
    await page.locator("#viewed-S-1").check();
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("j");
      seen.push(await focused(page));
    }
    assert.deepEqual(
      seen.filter((s) => /"Steps" line/.test(s)),
      [],
      "a folded section's lines are skipped",
    );
  }),
);

test("on a review page, n and p move between open conversations, and a and x accept or reject Claude's change on the line", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    const [, second] = hoop.review(review_id, {
      verdict: "changes_requested",
      reviewer: "ana",
      comments: [
        { item: "S-1", line: 1, body: "Which Monday?" },
        { item: "S-1", line: 2, body: "Shorter." },
      ],
    }).comments;
    hoop.receive(review_id);
    hoop.proposeEdits(review_id, second!.thread!, [
      { item: "S-1", line: 2, find: "Then tell", replace: "Tell" },
      { item: "S-1", line: 2, find: "the clients", replace: "every client" },
    ]);
    await open(page, `${base}/r/${review_id}`, "[data-accept]");
    const thread = () => page.evaluate(() => document.activeElement?.closest(".thread")?.textContent ?? "");
    await page.keyboard.press("n");
    assert.match(await thread(), /Which Monday\?/, "n goes to the first open conversation");
    await page.keyboard.press("n");
    assert.match(await thread(), /Shorter\./, "n goes to the next");
    await page.keyboard.press("p");
    assert.match(await thread(), /Which Monday\?/, "p goes back");
    // The control n lands on names its conversation, and shows below the sticky header.
    assert.equal(await focused(page), 'Reply to the conversation on "Steps" line 1');
    // In a short window scrolled to the end, p scrolls up to the conversation: its Reply shows below the sticky header.
    await page.setViewportSize({ width: 1000, height: 360 });
    await page.keyboard.press("n");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.keyboard.press("p");
    const clear = await page.evaluate(() => {
      const header = document.querySelector(".frame")!.getBoundingClientRect();
      const top = document.querySelector(".top")!;
      const bottom = getComputedStyle(top).position === "sticky" ? top.getBoundingClientRect().bottom : header.bottom;
      return { at: document.activeElement!.getBoundingClientRect().top, below: bottom, scrolled: window.scrollY };
    });
    assert.ok(clear.scrolled > 0 && clear.at >= clear.below, `the focused Reply is at ${clear.at}px, under a header ending at ${clear.below}px`);
    await page.setViewportSize({ width: 1280, height: 720 });
    const decision = () => page.waitForRequest((r) => r.method() === "POST" && /\/edits\//.test(r.url())).then((r) => r.postData() ?? "");
    const line = page.getByRole("button", { name: /^Comment on "Steps" line 2$/ });
    await line.focus();
    const accepted = decision();
    await page.keyboard.press("a");
    assert.match(await accepted, /"accept"/, "a accepts Claude's change on the line");
    await page.locator(".toast", { hasText: "Accepted 1 edit; now rev 2." }).waitFor();
    assert.notEqual(await page.evaluate(() => document.activeElement === document.body), true, "focus stays on the page's controls");
    await page.locator(".rev", { hasText: "rev 2" }).first().waitFor();
    await line.focus();
    const rejected = decision();
    await page.keyboard.press("x");
    assert.match(await rejected, /"reject"/, "x rejects Claude's other change on the line");
  }),
);

test("on a quick question's card beside a line, 1 to 4 answer it once", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    const KEEP = { question: "Keep it?", options: [{ label: "Keep", recommended: true }, { label: "Remove" }] };
    hoop.ask({ questions: [KEEP], anchor: { review_id, words: "Ship on Monday" } });
    await open(page, `${base}/r/${review_id}`, ".ask-card .ask-opt");
    const answers: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/answer")) answers.push(r.postData() ?? "");
    });
    await page.locator(".ask-card .ask-opt").first().focus();
    await page.keyboard.press("1");
    await page.locator(".ask-card .ask-status", { hasText: /\S/ }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(answers.length, 1, "1 sends one answer");
  }),
);

/** Whether the page's live region comes to say `text`. */
const said = (page: Page, text: string) =>
  page
    .waitForFunction((t) => document.querySelector("#page-live")?.textContent === t, text, { timeout: 3000 })
    .then(
      () => true,
      () => false,
    );

test("? opens the shortcut panel under the top bar, and ? or Escape closes it, with focus back where it was", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    await open(page, `${base}/r/${review_id}`);
    const line = page.getByRole("button", { name: 'Comment on "Steps" line 1' });
    for (const close of ["?", "Escape"]) {
      await line.focus();
      await page.keyboard.press("?");
      await page.locator("#keysPanel").waitFor();
      assert.ok(await hasFocus(page.locator("#keysTitle"), 2000), "focus goes to the panel");
      assert.match((await page.locator("#keysPanel").textContent()) ?? "", /Next line.*Accept Claude's change on the line/s, "it lists the keys");
      await page.keyboard.press(close);
      await page.locator("#keysPanel").waitFor({ state: "detached" });
      assert.ok(await hasFocus(line, 2000), `${close} closes it, with focus back on the line`);
    }
    await line.focus();
    await page.keyboard.press("?");
    await page.locator("#keysClose").click();
    assert.ok(await hasFocus(line, 2000), "Close closes it, with focus back on the line");
    // Opened with nothing focused, it closes leaving focus nowhere.
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("?");
    await page.locator("#keysPanel").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#keysPanel").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "focus goes back to nowhere");
    // c on another line while the comment box holds words says what to do first.
    await line.focus();
    await page.keyboard.press("c");
    await page.locator("#cbody").fill("Which Monday?");
    await page.getByRole("button", { name: 'Comment on "Steps" line 2' }).focus();
    await page.keyboard.press("c");
    assert.ok(await said(page, "Add or cancel your comment first"));
  }),
);

test("the Keyboard shortcuts switch is kept through a reload; while it is off the keys do nothing and ? still opens the panel", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    await open(page, `${base}/r/${review_id}`);
    await page.keyboard.press("?");
    const toggle = page.locator("#keysOn");
    assert.equal(await toggle.getAttribute("aria-pressed"), "true", "on by default");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    assert.ok(await hasFocus(toggle, 2000), "focus stays on the switch");
    await open(page, `${base}/r/${review_id}`);
    const line = page.getByRole("button", { name: 'Comment on "Steps" line 1' });
    await line.focus();
    for (const key of ["j", "c", "v", "1"]) await page.keyboard.press(key);
    assert.ok(await hasFocus(line, 1000), "no key acts while the switch is off");
    assert.equal(await page.locator("#cbody").count(), 0, "c opens nothing");
    assert.equal(await page.locator("#viewed-S-1").isChecked(), false, "v marks nothing");
    await page.keyboard.press("?");
    assert.equal(await page.locator("#keysOn").getAttribute("aria-pressed"), "false", "the switch is kept through the reload, and ? opens the panel");
  }),
);

test("a key with nothing to act on changes nothing, and the live region says why; a blocked store leaves the keys on", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown(DOC));
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw new Error("blocked");
      };
    });
    await open(page, `${base}/r/${review_id}`);
    const line = page.getByRole("button", { name: 'Comment on "Steps" line 1' });
    await line.focus();
    await page.keyboard.press("a");
    assert.ok(await said(page, "No change from Claude on this line"), "a says there's no change");
    await page.keyboard.press("1");
    assert.ok(await said(page, "This line isn't in a question"), "1 says the line isn't in a question");
    assert.ok(await hasFocus(line, 1000), "focus stays put");
    await page.keyboard.press("n");
    assert.ok(await said(page, "No next open conversation"), "n says there's none");
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("k");
    await page.keyboard.press("j");
    assert.ok(await said(page, "No next line"), "j at the last line says so");
  }),
);
