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

/** The names this browser keeps drafts under, from the page. */
const keptNames = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("hoop:kept") || "[]") as string[]);

/** Blocks every storage call in pages opened after this. */
const BLOCK_STORAGE = () => {
  for (const m of ["getItem", "setItem", "removeItem"] as const)
    Storage.prototype[m] = () => {
      throw new Error("blocked");
    };
};

test("regression: two tabs on one build keep their own blocks' drafts; saving one in a tab never erases the other's", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, browser }) => {
    const id = hoop.startBuild("# Cost\n\nNotes.\n\nMore notes.\n").review_id;
    const [one, two] = ["Notes.", "More notes."].map((t) => hoop.builds.read(id).blocks.find((x) => x.text === t)!.id);
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    const [a, b] = [await ctx.newPage(), await ctx.newPage()];
    for (const [page, block, text] of [
      [a, one, "Notes on the bill."],
      [b, two, "More on the bill."],
    ] as const) {
      await page.goto(`${base}/r/${id}`);
      await page.locator(`[data-b-edit="${block}"]`).click();
      await page.locator(`#bt-${block}`).fill(text);
      await page.locator(`#bt-${block} + .draft-saved`).waitFor();
    }
    await b.locator(`[data-b-save="${two}"]`).click();
    await b.locator(`[data-b-edit="${two}"]`).waitFor();
    await a.reload();
    await a.locator(`#bt-${one}`).waitFor();
    assert.equal(await a.locator(`#bt-${one}`).inputValue(), "Notes on the bill.", "the other tab's draft is still kept");
    await ctx.close();
  }),
);

test("regression: a draft for a block that changed since isn't put back over the newer text, and stays kept", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const id = hoop.startBuild("# Cost\n\nNotes.\n").review_id;
    const block = hoop.builds.read(id).blocks.find((x) => x.text === "Notes.")!.id;
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    await page.goto(`${base}/r/${id}`);
    await page.locator(`[data-b-edit="${block}"]`).click();
    await page.locator(`#bt-${block}`).fill("My notes.");
    await page.locator(`#bt-${block} + .draft-saved`).waitFor();
    hoop.buildChange(id, { op: "edit", block, text: "Claude's newer notes." });
    await page.reload();
    await page.locator(`[data-b-edit="${block}"]`).waitFor();
    assert.equal(await page.locator(`#bt-${block}`).count(), 0, "the block isn't opened over the newer text");
    assert.deepEqual(await keptNames(page), [`build:${id}:${block}`], "its draft stays kept");
  }),
);

test("regression: with storage blocked, no page says Draft saved, and the build, quick question and Work pages still work", {
  skip: BROWSER_SKIP,
}, async () => {
  const home = tempHome();
  workHook(home, { ...HOOKS["post-taskcreate"], tool_input: { subject: "Run the tests" }, tool_response: { task: { id: "1", subject: "Run the tests" } } });
  const hoop = new Hoop(new Store(home));
  const build = hoop.startBuild("# Cost\n\nNotes.\n").review_id;
  const block = hoop.builds.read(build).blocks.find((x) => x.text === "Notes.")!.id;
  const ask = hoop.ask({ questions: [KEEP] }).review_id;
  await withBrowser(async ({ base, page }) => {
    await page.addInitScript(BLOCK_STORAGE);
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    await page.goto(`${base}/r/${build}`);
    await page.locator(`[data-b-edit="${block}"]`).click();
    await page.locator(`#bt-${block}`).fill("Notes on the bill.");
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".draft-saved").count(), 0, "nothing was stored, so nothing says it was");
    await page.locator(`[data-b-save="${block}"]`).click();
    await page.locator(`[data-b-edit="${block}"]`).waitFor();
    await page.goto(`${base}/r/${ask}`);
    await page.locator("[data-other]").click();
    await page.locator(".ask-other input").fill("Keep it a month");
    await page.locator(".ask-other button[type=submit]").click();
    await page.locator(".ask-status", { hasText: /\S/ }).waitFor();
    await page.goto(`${base}/work`);
    await page.locator('[data-act="comment"]').first().click();
    await page.locator(".steer-form textarea, .steer-form input").first().fill("Run them twice");
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".draft-saved").count(), 0);
    await page.locator("[data-cancel]").click();
    await page.locator(".steer-form").waitFor({ state: "detached" });
  }, hoop);
});

test("a quick question's card keeps its Other words, and a withdrawn question drops what was kept for it", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id } = hoop.submit(parseMarkdown("# Plan\n\nWhy.\n\n## Steps\n\nShip on Monday.\n"));
    const card = hoop.ask({ questions: [KEEP], anchor: { review_id, words: "Ship on Monday" } }).review_id;
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    await page.goto(`${base}/r/${review_id}`);
    await page.locator(".ask-card [data-other]").click();
    await page.locator(".ask-card .ask-other input").fill("Ship on Tuesday");
    await page.locator(".ask-card .ask-other input + .draft-saved").waitFor();
    await page.reload();
    await page.locator(".ask-card .ask-other input").waitFor();
    assert.equal(await page.locator(".ask-card .ask-other input").inputValue(), "Ship on Tuesday", "the card's Other words come back");
    hoop.withdraw(card, "Found it");
    await page.reload();
    await page.locator(".top h1").waitFor();
    await page.waitForFunction(() => !(JSON.parse(localStorage.getItem("hoop:kept") || "[]") as string[]).length);
  }),
);

test("Home's list drops drafts for a build that became a review and a closed review, though another tab kept them", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const id = hoop.startBuild("# Cost\n\nNotes.\n").review_id;
    const block = hoop.builds.read(id).blocks.find((x) => x.text === "Notes.")!.id;
    const { review_id } = hoop.submit(parseMarkdown("# Plan\n\nWhy.\n"));
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50, HOOP_PENDING_MS: 100 }));
    await page.goto(`${base}/r/${id}`);
    await page.locator(`[data-b-edit="${block}"]`).click();
    await page.locator(`#bt-${block}`).fill("Notes on the bill.");
    await page.locator(`#bt-${block} + .draft-saved`).waitFor();
    await page.evaluate((r) => localStorage.setItem(`hoop:${r}:drafts`, JSON.stringify({ revision: 1, summary: "Ship it." })), review_id);
    hoop.finishBuild(id);
    hoop.close(review_id, "Not needed");
    await page.goto(base);
    await page.waitForFunction(
      (r) => !(JSON.parse(localStorage.getItem("hoop:kept") || "[]") as string[]).length && localStorage.getItem(`hoop:${r}:drafts`) === null,
      review_id,
      { timeout: 5000 },
    );
  }),
);

test("a review's drafts typed before an approval go; drafts from before hoop recorded when they were typed stay", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const doc = "# Plan\n\nWhy.\n\n## Steps\n\nShip on Monday.\n";
    const typed = hoop.submit(parseMarkdown(doc)).review_id;
    const old = hoop.submit(parseMarkdown(doc.replace("Plan", "Old plan"))).review_id;
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    await page.goto(`${base}/r/${typed}`);
    await page.locator("#finishBtn").click();
    await page.locator("#summary").fill("Ship it.");
    await page.locator("#summary + .draft-saved").waitFor();
    // An overall comment kept before this change recorded no time.
    await page.evaluate((r) => localStorage.setItem(`hoop:${r}:drafts`, JSON.stringify({ revision: 1, summary: "From before." })), old);
    for (const id of [typed, old]) hoop.review(id, { verdict: "approved", reviewer: "ana" });
    await page.goto(`${base}/r/${typed}`);
    await page.locator("#finishBtn").click();
    assert.equal(await page.locator("#summary").inputValue(), "", "a draft typed before the approval goes");
    await page.goto(`${base}/r/${old}`);
    await page.locator("#finishBtn").click();
    assert.equal(await page.locator("#summary").inputValue(), "From before.", "a draft with no time is kept");
  }),
);

test("Work keeps an edit and a new todo through a reload, and an edit whose todo changed since isn't put back", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  workHook(home, { ...HOOKS["post-taskcreate"], tool_input: { subject: "Run the tests" }, tool_response: { task: { id: "1", subject: "Run the tests" } } });
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
      await page.goto(`${base}/work`);
      const field = page.locator(".steer-form textarea, .steer-form input:not([type=hidden])").first();
      await page.locator('[data-act="add"]').first().click();
      await field.fill("Write the docs");
      await page.locator(".steer-form .draft-saved").waitFor();
      await page.reload();
      await page.locator(".steer-form").waitFor();
      assert.equal(await field.inputValue(), "Write the docs", "the new todo's words come back");
      await page.locator("[data-cancel]").click();
      await page.locator('[data-act="edit"]').first().click();
      await field.fill("Run the whole suite");
      await page.locator(".steer-form .draft-saved").waitFor();
      await page.reload();
      await page.locator(".steer-form").waitFor();
      assert.equal(await field.inputValue(), "Run the whole suite", "the edit's words come back");
      // The todo changes under the kept edit: it isn't put back over the newer text.
      workHook(home, { ...HOOKS["post-taskupdate"], tool_input: { taskId: "1", subject: "Run the tests twice" } });
      await page.reload();
      await page.locator("section.work-session").waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.locator(".steer-form").count(), 0, "the edit isn't opened over the newer todo");
    },
    new Hoop(new Store(home)),
  );
});
