import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { workHook } from "../src/work.js";

// docs/DESIGN-LANGUAGE.md, Drafts: unsent text on every page is kept in this browser through a
// reload, with a quiet "Draft saved" beside its box, until it is sent, cancelled or what it is for ends.

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const KEEP = { question: "Keep it?", options: [{ label: "Keep", recommended: true }, { label: "Remove" }] };

/** Waits for "Draft saved" to show beside `box`, and checks it isn't a live region. */
async function savedBeside(page: Page, box: string) {
  const note = page.locator(`${box} + .draft-saved`);
  await note.waitFor({ timeout: 3000 });
  assert.equal(await note.textContent(), "Draft saved");
  assert.equal(await note.evaluate((el) => el.closest('[role="status"], [aria-live]') === null), true, "it isn't announced");
}

test("the build page keeps a block's unsaved text through a reload, and drops it once saved", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const id = hoop.startBuild("# Cost\n\nNotes.\n").review_id;
    const block = hoop.builds.read(id).blocks.find((x) => x.text === "Notes.")!.id;
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    await page.goto(`${base}/r/${id}`);
    await page.locator(`[data-b-edit="${block}"]`).click();
    await page.locator(`#bt-${block}`).fill("Notes on the bill.");
    await savedBeside(page, `#bt-${block}`);
    await page.reload();
    await page.locator(`#bt-${block}`).waitFor();
    assert.equal(await page.locator(`#bt-${block}`).inputValue(), "Notes on the bill.", "the text comes back in its open box");
    await page.locator(`[data-b-save="${block}"]`).click();
    await page.locator(`[data-b-edit="${block}"]`).waitFor();
    await page.reload();
    await page.locator(`[data-b-edit="${block}"]`).waitFor();
    assert.equal(await page.locator(`#bt-${block}`).count(), 0, "once saved, nothing is kept");
  }),
);

test("a quick question keeps its Other answer and its note through a reload, and drops them once sent", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const ask = hoop.ask({ questions: [KEEP] }).review_id;
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    await page.goto(`${base}/r/${ask}`);
    await page.locator("[data-other]").click();
    await page.locator(".ask-other input").fill("Keep it a month");
    await savedBeside(page, ".ask-other input");
    await page.locator(".ask-note textarea").fill("Two clients call it");
    await page.reload();
    await page.locator(".ask-other input").waitFor();
    assert.equal(await page.locator(".ask-other input").inputValue(), "Keep it a month", "Other's box is open again with its words");
    assert.equal(await page.locator(".ask-note textarea").inputValue(), "Two clients call it", "and the note is back");
    await page.locator(".ask-other button[type=submit]").click();
    await page.locator(".ask-status", { hasText: /\S/ }).waitFor();
    await page.reload();
    await page.locator(".ask-opt").first().waitFor();
    assert.equal(await page.locator(".ask-other").count(), 0, "once sent, nothing is kept");
    assert.equal(await page.locator(".ask-note textarea").inputValue(), "");
  }),
);

test("Work keeps a comment being written on a todo through a reload, and drops it on Cancel", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  workHook(home, { ...HOOKS["post-taskcreate"], tool_input: { subject: "Run the tests" }, tool_response: { task: { id: "1", subject: "Run the tests" } } });
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
      await page.goto(`${base}/work`);
      await page.locator('[data-act="comment"]').first().click();
      const box = page.locator(".steer-form textarea, .steer-form input").first();
      await box.fill("Run them twice");
      await page.locator(".steer-form .draft-saved").waitFor({ timeout: 3000 });
      await page.reload();
      await page.locator(".steer-form").waitFor();
      assert.equal(
        await page.locator(".steer-form textarea, .steer-form input").first().inputValue(),
        "Run them twice",
        "the form is open again with its words",
      );
      await page.locator("[data-cancel]").click();
      await page.reload();
      await page.locator("section.work-session").waitFor();
      assert.equal(await page.locator(".steer-form").count(), 0, "once cancelled, nothing is kept");
    },
    new Hoop(new Store(home)),
  );
});

test("a review's comment shows Draft saved, and its drafts go once the review is closed; a blocked store breaks nothing", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page, browser }) => {
    const { review_id } = hoop.submit(parseMarkdown("# Plan\n\nWhy.\n\n## Steps\n\nShip on Monday.\n"));
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    await page.goto(`${base}/r/${review_id}`);
    await page.getByRole("button", { name: 'Comment on "Steps" line 1' }).click();
    await page.locator("#cbody").fill("Which Monday?");
    await savedBeside(page, "#cbody");
    await page.reload();
    await page.locator("#cbody").waitFor();
    assert.equal(await page.locator("#cbody").inputValue(), "Which Monday?", "kept through a reload, as before");
    hoop.close(review_id, "Not needed");
    await page.reload();
    await page.locator(".closed-note").waitFor();
    assert.equal(await page.locator("#cbody").count(), 0, "a closed review's drafts go");

    // With storage blocked, the page still works and keeps nothing.
    const other = await browser.newPage();
    await other.addInitScript(() => {
      for (const m of ["getItem", "setItem", "removeItem"] as const)
        Storage.prototype[m] = () => {
          throw new Error("blocked");
        };
    });
    const id2 = hoop.submit(parseMarkdown("# Second\n\nWhy.\n\n## Steps\n\nShip.\n")).review_id;
    await other.goto(`${base}/r/${id2}`);
    await other.getByRole("button", { name: 'Comment on "Steps" line 1' }).click();
    await other.locator("#cbody").fill("Still works");
    await other.locator("#addComment").click();
    await other.locator("[data-drop]").waitFor();
  }),
);
