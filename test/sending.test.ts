import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { Locator, Page } from "playwright-core";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { workHook } from "../src/work.js";
import { BROWSER_SKIP, example, tempHome, withBrowser } from "./helpers.js";

// The design language's "Writing and sending" (#336): a box for long text sends with Ctrl+Enter (Cmd+Enter
// on a Mac) and says so under it, and plain Enter starts a new line; any other box sends with Enter, and
// Shift+Enter starts a new line. Neither sends while an input method is composing.

const WEB = new URL("../web/", import.meta.url);
const LONG_HINT = /^(Ctrl|Cmd)\+Enter (sends|saves|adds); Escape cancels\.$/;
const SHORT_HINT = "Enter sends; Shift+Enter starts a new line.";

/** Text boxes that send nothing of their own, and why. */
const EXEMPT: [RegExp, string][] = [
  [/id="note-\$\{key\}"/, "a quick question's note goes with the answer the person picks"],
  [/id="bt-\$\{esc\(id\)\}" class="btext" rows/, "unsaved text for a removed block can only be copied or discarded"],
];

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
    assert.match(tag, /aria-describedby="/, `${file}: ${tag} names the line under it`);
    assert.match(src, long ? /longHint\(/ : /SHORT_HINT/, `${file}: the line under ${tag} says how it sends`);
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

/** A keydown for Enter, with Ctrl and Cmd held, while an input method is composing. */
const composingEnter = (box: Locator, ctrl: boolean) =>
  box.evaluate(
    (el, mod) =>
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: mod, metaKey: mod, isComposing: true, bubbles: true, cancelable: true })),
    ctrl,
  );

const settle = (page: Page) => page.waitForTimeout(300);

/**
 * Checks a box for long text: its hint, that plain Enter starts a new line, that Enter while composing
 * sends nothing, then that `key` (Ctrl+Enter or Meta+Enter) sends `text`, which `sent` waits for.
 */
async function sendsLong(page: Page, box: Locator, what: string, text: string, sent: () => Promise<unknown>, key = "Control+Enter") {
  await box.waitFor();
  assert.match((await hintOf(box)) ?? "", LONG_HINT, `${what}: the line under it names the key`);
  await box.fill("One");
  await box.press("Enter");
  await box.pressSequentially("two");
  assert.equal(await box.inputValue(), "One\ntwo", `${what}: plain Enter starts a new line`);
  await box.fill(text);
  assert.equal(await composingEnter(box, true), true, `${what}: Ctrl+Enter while composing is left to the input method`);
  await settle(page);
  assert.equal(await box.inputValue(), text, `${what}: nothing is sent while an input method composes`);
  await box.press(key);
  await sent();
}

/** Checks a box where Enter sends: its hint, Shift+Enter's new line, composing, then Enter sends `text`. */
async function sendsShort(page: Page, box: Locator, what: string, text: string, sent: () => Promise<unknown>) {
  await box.waitFor();
  assert.equal(await hintOf(box), SHORT_HINT, `${what}: the line under it names the key`);
  await box.fill("One");
  await box.press("Shift+Enter");
  await box.pressSequentially("two");
  assert.equal(await box.inputValue(), "One\ntwo", `${what}: Shift+Enter starts a new line`);
  await box.fill(text);
  assert.equal(await composingEnter(box, false), true, `${what}: Enter while composing is left to the input method`);
  await settle(page);
  assert.equal(await box.inputValue(), text, `${what}: nothing is sent while an input method composes`);
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

    // A suggestion, sent from its own box, with Cmd+Enter.
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

test("the Work page's comment and description boxes send with Enter, never while composing (#336)", { skip: BROWSER_SKIP }, async () => {
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
      await sendsShort(page, page.getByLabel("Description of todo #1"), "description", "Start with src/work.ts", () =>
        todo("1").locator(".note", { hasText: "edited its description" }).waitFor(),
      );
    },
    new Hoop(new Store(home)),
  );
});
