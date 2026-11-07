import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { BROWSER_SKIP, hasFocus, tempHome, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { workHook } from "../src/work.js";

// docs/DESIGN-LANGUAGE.md, Drafts: unsent text on every page is kept in this browser through a
// reload, with a quiet "Draft saved" beside its box, until it is sent, cancelled or what it is for ends.

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const KEEP = { question: "Keep it?", options: [{ label: "Keep", recommended: true }, { label: "Remove" }] };

/** Waits for the "Draft saved" note `note` to show, and checks it isn't a live region. */
async function savedBeside(page: Page, note: string) {
  const el = page.locator(note);
  await el.waitFor({ timeout: 3000 });
  assert.equal(await el.textContent(), "Draft saved");
  assert.equal(await el.evaluate((el) => el.closest('[role="status"], [aria-live]') === null), true, "it isn't announced");
}

test("the build page keeps a block's unsaved text through a reload, and drops it once saved", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const id = hoop.startBuild("# Cost\n\nNotes.\n").review_id;
    const block = hoop.builds.read(id).blocks.find((x) => x.text === "Notes.")!.id;
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    await page.goto(`${base}/r/${id}`);
    await page.locator(`[data-b-edit="${block}"]`).click();
    await page.locator(`#bt-${block}`).fill("Notes on the bill.");
    await savedBeside(page, `.bblock[data-block="${block}"] .draft-saved`);
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
    await savedBeside(page, ".ask-other .draft-saved");
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
    await savedBeside(page, "#cbody + .draft-saved");
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
const keptNames = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith("hoop:kept:"))
      .map((k) => k.slice("hoop:kept:".length)),
  );

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
      await page.locator(`.bblock[data-block="${block}"] .draft-saved`).waitFor();
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
    await page.locator(`.bblock[data-block="${block}"] .draft-saved`).waitFor();
    hoop.buildChange(id, { op: "edit", block, text: "Claude's newer notes." });
    await page.reload();
    await page.locator(`[data-b-edit="${block}"]`).waitFor();
    assert.equal(await page.locator(`#bt-${block}`).count(), 0, "the block isn't opened over the newer text");
    assert.deepEqual(await keptNames(page), [`build:${id}:${block}`], "its draft stays kept");
    // Opened to edit, the block offers the kept words back above its box; Use it puts them in.
    await page.locator(`[data-b-edit="${block}"]`).click();
    const note = page.locator(".bblock.editing .stale-draft");
    await note.waitFor();
    assert.match((await note.textContent()) ?? "", /You had unsent text from before this changed.*My notes\./s);
    assert.equal(await page.locator(`#bt-${block}`).inputValue(), "Claude's newer notes.", "the box starts from the newer text");
    await note.getByRole("button", { name: /^Use your unsent text in / }).click();
    assert.equal(await page.locator(`#bt-${block}`).inputValue(), "My notes.", "Use it puts the kept words in the box");
    assert.equal(await page.locator(".stale-draft").count(), 0);
    // Discard drops a kept draft offered back.
    await page.locator(`[data-b-cancel="${block}"]`).click();
    await page.evaluate(
      ({ name }) => localStorage.setItem(`hoop:kept:${name}`, JSON.stringify({ text: "Old words.", base: "Something else", at: new Date().toISOString() })),
      { name: `build:${id}:${block}` },
    );
    await page.locator(`[data-b-edit="${block}"]`).click();
    await page
      .locator(".stale-draft")
      .getByRole("button", { name: /^Discard your unsent text for / })
      .click();
    assert.equal(await page.locator(".stale-draft").count(), 0);
    assert.deepEqual(await keptNames(page), [], "Discard drops the draft");
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
    assert.equal(await page.locator(".draft-saved:visible").count(), 0, "nothing was stored, so nothing says it was");
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
    assert.equal(await page.locator(".draft-saved:visible").count(), 0);
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
    await page.locator(".ask-card .ask-other .draft-saved").waitFor();
    await page.reload();
    await page.locator(".ask-card .ask-other input").waitFor();
    assert.equal(await page.locator(".ask-card .ask-other input").inputValue(), "Ship on Tuesday", "the card's Other words come back");
    hoop.withdraw(card, "Found it");
    await page.reload();
    await page.locator(".top h1").waitFor();
    await page.waitForFunction(() => !Object.keys(localStorage).some((k) => k.startsWith("hoop:kept:")));
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
    await page.locator(`.bblock[data-block="${block}"] .draft-saved`).waitFor();
    await page.evaluate((r) => localStorage.setItem(`hoop:${r}:drafts`, JSON.stringify({ revision: 1, summary: "Ship it." })), review_id);
    hoop.finishBuild(id);
    hoop.close(review_id, "Not needed");
    await page.goto(base);
    await page.waitForFunction(
      (r) => !Object.keys(localStorage).some((k) => k.startsWith("hoop:kept:")) && localStorage.getItem(`hoop:${r}:drafts`) === null,
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

test("regression: a tab that closes a box it never typed in leaves another tab's draft for it alone (block, Work form, Other)", {
  skip: BROWSER_SKIP,
}, async () => {
  const home = tempHome();
  workHook(home, { ...HOOKS["post-taskcreate"], tool_input: { subject: "Run the tests" }, tool_response: { task: { id: "1", subject: "Run the tests" } } });
  const hoop = new Hoop(new Store(home));
  const build = hoop.startBuild("# Cost\n\nNotes.\n").review_id;
  const block = hoop.builds.read(build).blocks.find((x) => x.text === "Notes.")!.id;
  const ask = hoop.ask({ questions: [KEEP] }).review_id;
  await withBrowser(async ({ base, browser }) => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    const [a, b] = [await ctx.newPage(), await ctx.newPage()];
    // The build page: A types in the block; B opens every block and previews them again.
    // Each page is open in both tabs before A types, so B holds none of A's words. A tab in the
    // background doesn't paint, so the tab that acts comes to the front first.
    await b.bringToFront();
    await b.goto(`${base}/r/${build}`);
    await b.locator(`[data-b-edit="${block}"]`).waitFor();
    await a.bringToFront();
    await a.goto(`${base}/r/${build}`);
    await a.locator(`[data-b-edit="${block}"]`).click();
    await a.locator(`#bt-${block}`).fill("Notes on the bill.");
    await a.locator(`.bblock[data-block="${block}"] .draft-saved`).waitFor();
    // The build page: B opens every block and previews them again, typing nothing.
    await b.bringToFront();
    await b.locator("#modeAll").click();
    await b.locator(`#bt-${block}`).waitFor();
    await b.locator("#modeAll").click();
    await b.locator(`[data-b-edit="${block}"]`).waitFor();
    // Work: A types a comment on the todo; B opens the same form and cancels it.
    await b.goto(`${base}/work`);
    await b.locator("section.work-session").waitFor();
    await a.bringToFront();
    await a.goto(`${base}/work`);
    await a.locator('[data-act="comment"]').first().click();
    await a.locator(".steer-form textarea, .steer-form input:not([type=hidden])").first().fill("Run them twice");
    await a.locator(".steer-form .draft-saved").waitFor();
    await b.bringToFront();
    await b.locator('[data-act="comment"]').first().click();
    await b.locator("[data-cancel]").click();
    // A quick question: A types Other's words; B opens Other and cancels it.
    await b.goto(`${base}/r/${ask}`);
    await b.locator("[data-other]").waitFor();
    await a.bringToFront();
    await a.goto(`${base}/r/${ask}`);
    await a.locator("[data-other]").click();
    await a.locator(".ask-other input").fill("Keep it a month");
    await a.locator(".ask-other .draft-saved").waitFor();
    await b.bringToFront();
    await b.locator("[data-other]").click();
    await b.locator(".ask-other button[data-other-cancel]").click();
    const names = await keptNames(b);
    assert.ok(names.includes(`build:${build}:${block}`), "the block's draft is kept");
    assert.ok(
      names.some((n) => n.startsWith("work:")),
      "the Work form's draft is kept",
    );
    assert.ok(names.includes(`ask:${ask}:other:Q1`), "Other's draft is kept");
    await ctx.close();
  }, hoop);
});

test("regression: typing a block back to its own text says no Draft saved and keeps nothing", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const id = hoop.startBuild("# Cost\n\nNotes.\n").review_id;
    const block = hoop.builds.read(id).blocks.find((x) => x.text === "Notes.")!.id;
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    await page.goto(`${base}/r/${id}`);
    await page.locator(`[data-b-edit="${block}"]`).click();
    await page.locator(`#bt-${block}`).fill("Notes on the bill.");
    await page.locator(`.bblock[data-block="${block}"] .draft-saved`).waitFor();
    await page.locator(`#bt-${block}`).fill("Notes.");
    await page.waitForTimeout(300);
    assert.equal(await page.locator(`.bblock[data-block="${block}"] .draft-saved:visible`).count(), 0, "no Draft saved for the block's own text");
    assert.deepEqual(await keptNames(page), [], "and nothing kept");
  }),
);

test("regression: Go with your recommendation drops the Other words typed for the questions it answers", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const ask = hoop.ask({ questions: [KEEP, { question: "Which format?", options: [{ label: "CSV", recommended: true }, { label: "JSON" }] }] }).review_id;
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    await page.goto(`${base}/r/${ask}`);
    await page.locator('[data-q="Q1"][data-other]').click();
    await page.locator(".ask-other input").fill("Keep it a month");
    await page.locator(".ask-other .draft-saved").waitFor();
    await page.locator(".go-rec").click();
    await page.locator(".ask-status", { hasText: /\S/ }).waitFor();
    assert.deepEqual(await keptNames(page), [], "the answered question's Other words go");
    await page.reload();
    await page.locator(".ask-opt").first().waitFor();
    assert.equal(await page.locator(".ask-other").count(), 0);
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
      // Opened to edit, the form offers the kept words back; Use it puts them in.
      await page.locator('[data-act="edit"]').first().click();
      await page.locator(".steer-form .stale-draft").waitFor();
      assert.equal(await field.inputValue(), "Run the tests twice", "the box starts from the newer text");
      await page
        .locator(".stale-draft")
        .getByRole("button", { name: /^Use your unsent text in / })
        .click();
      assert.equal(await field.inputValue(), "Run the whole suite", "Use it puts the kept words in the box");
      assert.equal(await page.locator(".stale-draft").count(), 0);
    },
    new Hoop(new Store(home)),
  );
});

test(
  "regression: typing under the stale offer keeps the offered words; Use it brings them back, Discard keeps the typing and focuses the box",
  {
    skip: BROWSER_SKIP,
  },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const id = hoop.startBuild("# Cost\n\nNotes.\n").review_id;
      const block = hoop.builds.read(id).blocks.find((x) => x.text === "Notes.")!.id;
      const name = `build:${id}:${block}`;
      const old = (text: string) =>
        page.evaluate(
          ({ name, text }) => localStorage.setItem(`hoop:kept:${name}`, JSON.stringify({ text, base: "Something else", at: new Date().toISOString() })),
          { name, text },
        );
      await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
      await page.goto(`${base}/r/${id}`);
      await page.locator(`[data-b-edit="${block}"]`).waitFor();
      await old("My notes.");
      await page.locator(`[data-b-edit="${block}"]`).click();
      const offer = page.locator(".stale-draft");
      await offer.waitFor();
      const use = offer.getByRole("button", { name: /^Use your unsent text in / });
      assert.match((await use.getAttribute("aria-label")) ?? "", /^Use your unsent text in \S/, "Use it names where the words go");
      // Typing before choosing keeps a draft of its own, and the offered words stay.
      await page.locator(`#bt-${block}`).fill("Newer typing.");
      await page.locator(`.bblock[data-block="${block}"] .draft-saved`).waitFor();
      assert.match((await offer.textContent()) ?? "", /My notes\./, "the offer still shows the old words");
      assert.deepEqual((await keptNames(page)).sort(), [name, `${name}:stale`]);
      await use.click();
      assert.equal(await page.locator(`#bt-${block}`).inputValue(), "My notes.", "Use it brings the offered words back");
      assert.equal(await hasFocus(page.locator(`#bt-${block}`)), true);
      assert.deepEqual(await keptNames(page), [name], "the offer's own key goes");
      // Discard drops the offered words, keeps what was typed and puts focus in the box.
      await page.locator(`[data-b-cancel="${block}"]`).click();
      await old("Older still.");
      await page.locator(`[data-b-edit="${block}"]`).click();
      await page.locator(".stale-draft").waitFor();
      await page.locator(`#bt-${block}`).fill("Mine now.");
      await page.locator(`.bblock[data-block="${block}"] .draft-saved`).waitFor();
      await page
        .locator(".stale-draft")
        .getByRole("button", { name: /^Discard your unsent text for / })
        .click();
      assert.equal(await page.locator(".stale-draft").count(), 0);
      assert.equal(await page.locator(`#bt-${block}`).inputValue(), "Mine now.");
      assert.equal(await hasFocus(page.locator(`#bt-${block}`)), true, "Discard puts focus in the box");
      assert.deepEqual(await keptNames(page), [name]);
    }),
);

test("regression: Work keeps every draft when its first read fails, drops a gone todo's draft, and Discards an offered edit", {
  skip: BROWSER_SKIP,
}, async () => {
  const home = tempHome();
  workHook(home, { ...HOOKS["post-taskcreate"], tool_input: { subject: "Run the tests" }, tool_response: { task: { id: "1", subject: "Run the tests" } } });
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
      await page.goto(`${base}/work`);
      await page.locator('[data-act="comment"]').first().click();
      await page.locator(".steer-form textarea").fill("Run them twice");
      await page.locator(".steer-form .draft-saved").waitFor();
      const kept = await keptNames(page);
      assert.equal(kept.length, 1);
      // The pages don't answer on load: nothing is dropped.
      await page.route("**/api/work", (r) => r.abort("connectionrefused"));
      await page.reload();
      await page.waitForTimeout(500);
      assert.deepEqual(await keptNames(page), kept, "a failed read drops nothing");
      await page.unroute("**/api/work");
      await page.reload();
      await page.locator(".steer-form textarea").waitFor();
      assert.equal(await page.locator(".steer-form textarea").inputValue(), "Run them twice", "and the form opens again once Work reads");
      // An edit whose todo changed offers its words back; Discard drops them and focuses the box.
      await page.locator("[data-cancel]").click();
      await page.evaluate(
        (key) =>
          localStorage.setItem(
            `hoop:kept:work:${key}:edit`,
            JSON.stringify({ key, mode: "edit", draft: "Old edit", desc: "", base: '["Something else",""]', at: new Date().toISOString() }),
          ),
        kept[0]!.slice("work:".length, -":comment".length),
      );
      await page.locator('[data-act="edit"]').first().click();
      await page
        .locator(".stale-draft")
        .getByRole("button", { name: /^Discard your unsent text for / })
        .click();
      assert.equal(await page.locator(".stale-draft").count(), 0);
      assert.equal(await hasFocus(page.locator(".steer-form input:not([type=hidden])").first()), true, "Discard puts focus in the box");
      assert.deepEqual(await keptNames(page), [], "Discard drops the offered words");
      await page.locator("[data-cancel]").click();
      // A todo that is gone takes its draft with it.
      await page.locator('[data-act="comment"]').first().click();
      await page.locator(".steer-form textarea").fill("About to go");
      await page.locator(".steer-form .draft-saved").waitFor();
      workHook(home, { ...HOOKS["post-taskupdate-deleted"], tool_input: { taskId: "1", status: "deleted" } });
      await page.reload();
      // With its only todo gone, the session may not show at all, so the wait is on the draft going.
      await page.waitForFunction(() => !Object.keys(localStorage).some((k) => k.startsWith("hoop:kept:")), undefined, { timeout: 5000 });
      assert.deepEqual(await keptNames(page), [], "a gone todo's draft goes");
    },
    new Hoop(new Store(home)),
  );
});

test("regression: Other words typed before the question was answered elsewhere don't come back over the answer", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const ask = hoop.ask({ questions: [KEEP] }).review_id;
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    await page.goto(`${base}/r/${ask}`);
    await page.locator("[data-other]").click();
    await page.locator(".ask-other input").fill("Keep it a month");
    await page.locator(".ask-other .draft-saved").waitFor();
    hoop.answer(ask, { question: "Q1", choice: "A" });
    await page.reload();
    await page.locator(".ask-answer:not(.none)").waitFor();
    assert.equal(await page.locator(".ask-other").count(), 0, "Other's box doesn't open over the answer");
    assert.deepEqual(await keptNames(page), [], "and its words go");
  }),
);

test("regression: the 500-draft cap drops the oldest, never a draft the page is using, and not one for lacking a time", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const id = hoop.startBuild("# Cost\n\nNotes.\n").review_id;
    const block = hoop.builds.read(id).blocks.find((x) => x.text === "Notes.")!.id;
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 50 }));
    await page.goto(`${base}/r/${id}`);
    await page.locator(`[data-b-edit="${block}"]`).click();
    await page.locator(`#bt-${block}`).fill("Mine.");
    await page.locator(`.bblock[data-block="${block}"] .draft-saved`).waitFor();
    // Older than everything else, the page's own draft would be the first to go without care.
    await page.evaluate(
      ({ name }) => {
        const mine = JSON.parse(localStorage.getItem(`hoop:kept:${name}`) ?? "{}");
        localStorage.setItem(`hoop:kept:${name}`, JSON.stringify({ ...mine, at: "2000-01-01T00:00:00.000Z" }));
        localStorage.setItem("hoop:kept:other:untimed", JSON.stringify({ text: "x" }));
        for (let i = 0; i < 499; i++)
          localStorage.setItem(`hoop:kept:other:${i}`, JSON.stringify({ text: "x", at: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString() }));
      },
      { name: `build:${id}:${block}` },
    );
    await page.locator(`#bt-${block}`).fill("Mine, longer.");
    await page.waitForFunction(() => Object.keys(localStorage).filter((k) => k.startsWith("hoop:kept:")).length === 500);
    const names = await keptNames(page);
    assert.ok(names.includes(`build:${id}:${block}`), "the open box's draft stays");
    assert.ok(names.includes("other:untimed"), "a draft with no time isn't dropped first");
    assert.ok(!names.includes("other:0"), "the oldest goes");
    assert.ok(names.includes("other:1"));
  }),
);

test("regression: Draft saved moves nothing when it shows: the build block, Other and Work's form at 400 pixels", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  workHook(home, { ...HOOKS["post-taskcreate"], tool_input: { subject: "Run the tests" }, tool_response: { task: { id: "1", subject: "Run the tests" } } });
  const hoop = new Hoop(new Store(home));
  const build = hoop.startBuild("# Cost\n\nNotes.\n").review_id;
  const block = hoop.builds.read(build).blocks.find((x) => x.text === "Notes.")!.id;
  const ask = hoop.ask({ questions: [KEEP] }).review_id;
  await withBrowser(async ({ base, page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    // Long enough to measure the page after typing and before the note shows.
    await page.addInitScript(() => Object.assign(window, { HOOP_DRAFT_MS: 700 }));
    /** Each element's place and size, to compare before and after the note shows. */
    const boxes = (sels: string[]) =>
      Promise.all(
        sels.map((s) =>
          page
            .locator(s)
            .first()
            .evaluate((el) => JSON.stringify(el.getBoundingClientRect())),
        ),
      );
    const unmoved = async (type: () => Promise<void>, note: string, sels: string[]) => {
      await type();
      const before = await boxes(sels);
      assert.equal(await page.locator(note).isVisible(), false, "measured before the note shows");
      await page.locator(note).waitFor();
      assert.deepEqual(await boxes(sels), before, `${note} moves nothing`);
    };
    await page.goto(`${base}/r/${build}`);
    await page.locator(`[data-b-edit="${block}"]`).click();
    await unmoved(() => page.locator(`#bt-${block}`).fill("Notes on the bill."), `.bblock[data-block="${block}"] .draft-saved`, [
      `.bblock[data-block="${block}"]`,
      `#bt-${block}`,
      `[data-b-save="${block}"]`,
    ]);
    await page.goto(`${base}/r/${ask}`);
    await page.locator("[data-other]").click();
    await unmoved(() => page.locator(".ask-other input").fill("Keep it a month"), ".ask-other .draft-saved", [
      ".ask-other input",
      ".ask-other button[type=submit]",
      ".ask-other",
    ]);
    await unmoved(() => page.locator(".ask-note textarea").fill("Two clients call it"), ".ask-note .draft-saved", [".ask-note textarea", ".ask-note"]);
    await page.goto(`${base}/work`);
    // From the keyboard, as Work's buttons there are opened in the 400-pixel checks.
    await page.locator('[data-act="comment"]').first().press("Enter");
    await unmoved(() => page.locator(".steer-form textarea").fill("Run them twice"), ".steer-form .draft-saved", [
      ".steer-form textarea",
      ".steer-form button[type=submit]",
      ".steer-form",
    ]);
  }, hoop);
});

test("a stale note is named, takes focus first, and reads apart from its kept words in both themes", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const id = hoop.startBuild("# Cost\n\nNotes.\n").review_id;
    const block = hoop.builds.read(id).blocks.find((x) => x.text === "Notes.")!.id;
    await page.goto(`${base}/r/${id}`);
    await page.locator(`[data-b-edit="${block}"]`).waitFor();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate(
        ({ name }) => localStorage.setItem(`hoop:kept:${name}`, JSON.stringify({ text: "My notes.", base: "Something else", at: new Date().toISOString() })),
        { name: `build:${id}:${block}` },
      );
      await page.locator(`[data-b-edit="${block}"]`).click();
      const note = page.getByRole("group", { name: "Unsent draft" });
      await note.waitFor();
      assert.equal(await hasFocus(note.getByRole("button", { name: /^Use your unsent text in / })), true, `${scheme}: focus starts on Use it`);
      const look = await note.locator(".kept-text").evaluate((el) => {
        const s = getComputedStyle(el);
        const n = getComputedStyle(el.closest(".stale-draft")!);
        return { border: s.borderTopStyle, own: s.backgroundColor !== n.backgroundColor, ink: s.color };
      });
      assert.equal(look.border, "solid", `${scheme}: the kept words have their own frame`);
      assert.equal(look.own, true, `${scheme}: on their own background`);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      const next = await page.evaluate(() => {
        const el = document.activeElement;
        return Boolean(el?.closest(".bblock.editing")) && !el?.closest(".stale-draft");
      });
      assert.equal(next, true, `${scheme}: Tab goes on from the note into the block's editor`);
      await note.getByRole("button", { name: /^Discard your unsent text for / }).click();
      assert.equal(await hasFocus(page.locator(`#bt-${block}`)), true, `${scheme}: Discard puts focus in the box`);
      await page.locator(`[data-b-cancel="${block}"]`).click();
    }
  }),
);
