import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Locator, Page } from "playwright-core";
import { BROWSER_SKIP, example, hasFocus, tempHome, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { workHook } from "../src/work.js";
import { OPS } from "../src/ops.js";

// docs/DESIGN-LANGUAGE.md, Focus after an action: after an action focus goes to what comes next, and
// never drops to the top of the page.
const RULE = "(docs/DESIGN-LANGUAGE.md, Focus after an action)";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));

/** What has focus, for a failure's message; "body" when focus fell to the page. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "body";
    return `${el.tagName.toLowerCase()} ${(el.getAttribute("aria-label") || el.textContent || el.id || "").trim().slice(0, 40)}`;
  });

/** Waits for the page to settle after an action, then fails when focus fell to the page. */
async function keepsFocus(page: Page, action: string) {
  await page.waitForTimeout(300);
  assert.notEqual(await focused(page), "body", `${action}: focus dropped to the top of the page ${RULE}`);
}

/** Presses a control from the keyboard, as a person who can't see where focus went would. */
async function press(page: Page, selector: string) {
  const el = page.locator(selector).first();
  await el.focus();
  await page.keyboard.press((await el.getAttribute("type")) === "checkbox" ? "Space" : "Enter");
}

const steps = "# Launch\n\nWhy this matters.\n\n## Steps\n\nShip on Monday.\n\nThen tell the clients.\n";

test("on the review page, each action leaves focus on what comes next, never on the page", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const id = hoop.submit(parseMarkdown(steps)).review_id;
    hoop.review(id, { verdict: "comment", reviewer: "ana", comments: [{ item: "S-1", line: 1, body: "Which Monday?" }] });
    hoop.receive(id);
    hoop.submit({ ...parseMarkdown(steps.replace("Then tell", "Tell")), review_id: id });
    await page.goto(`${base}/r/${id}`);
    await page.locator(".top h1").waitFor();
    // Each check goes on after a miss, so one run names every defect.
    const missed: string[] = [];
    const lands = async (target: Locator, what: string) => {
      if (!(await hasFocus(target, 2000))) missed.push(`${what}, not ${await focused(page)}`);
    };

    // The tabs: focus stays on the tab pressed.
    await press(page, "#tab-changes");
    await lands(page.locator("#tab-changes"), `Changes keeps focus ${RULE}`);
    await press(page, "#tab-proposal");
    await lands(page.locator("#tab-proposal"), `Proposal keeps focus ${RULE}`);

    // Viewed is a toggle: focus stays on it.
    await press(page, "#viewed-S-1");
    await lands(page.locator("#viewed-S-1"), `Viewed keeps focus ${RULE}`);
    await press(page, "#viewed-S-1");

    // Resolve folds the conversation to its row, which takes focus; Unresolve puts focus on Resolve.
    await press(page, "[data-resolve]");
    const folded = page.locator(".thread.resolved .thread-head .fold-btn");
    await lands(folded, `Resolve folds the conversation and puts focus on its row ${RULE}`);
    await press(page, ".thread.resolved .thread-head .fold-btn");
    await press(page, "[data-unresolve]");
    await lands(page.locator("[data-resolve]"), `Unresolve puts focus on Resolve ${RULE}`);

    // The composer's Suggest a change is a toggle: focus stays on it both ways.
    const line = await page.locator('.add-btn[data-item="S-1"]').last().getAttribute("data-line");
    const plus = `.add-btn[data-item="S-1"][data-line="${line}"]`;
    await press(page, plus);
    await page.locator("#cbody").waitFor();
    await press(page, "#toggleSuggest");
    await lands(page.locator("#toggleSuggest"), `Suggest a change keeps focus ${RULE}`);
    await press(page, "#toggleSuggest");
    await lands(page.locator("#toggleSuggest"), `Remove suggestion keeps focus ${RULE}`);

    // A pending comment deleted: its card goes, and focus goes to its line's +.
    await page.locator("#cbody").fill("Shorter.");
    await press(page, "#addComment");
    await page.locator("[data-drop]").waitFor();
    await press(page, "[data-drop]");
    await lands(page.locator(plus), `Delete puts focus on the line's + ${RULE}`);

    // Two pending comments on one line: deleting the first puts focus on the other's Delete, which names its line.
    for (const body of ["First.", "Second."]) {
      await press(page, plus);
      await page.locator("#cbody").fill(body);
      await press(page, "#addComment");
    }
    const deletes = page.locator("[data-drop]");
    await deletes.nth(1).waitFor();
    const label = (await deletes.first().getAttribute("aria-label")) ?? "";
    if (!/^Delete your comment on "Steps" line \d+$/.test(label)) missed.push(`Delete names what it deletes, not "${label}"`);
    const other = await deletes.nth(1).getAttribute("data-drop");
    await press(page, "[data-drop]");
    await lands(page.locator(`[data-drop="${other}"]`), `Delete puts focus on the next pending comment's Delete on the line ${RULE}`);
    await press(page, "[data-drop]");
    await lands(page.locator(plus), `Delete on the line's last pending comment puts focus on its + ${RULE}`);
    assert.deepEqual(missed, []);
  }),
);

// The redraws below name no place for focus, so the page's fallback (web/focus.js) keeps it on the
// control. The quick question page has no such redraw: every one of its redraws names where focus goes,
// so its checks guard the pattern, and its fallback is a safety net.
test("on Home, the quick question and Work pages, a redraw keeps focus on the control, and actions never leave it on the page", {
  skip: BROWSER_SKIP,
}, async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home));
  // A todo to remove on Work.
  for (const [id, subject] of [
    ["1", "Read the code"],
    ["2", "Run the tests"],
  ])
    workHook(home, { ...HOOKS["post-taskcreate"], tool_input: { subject }, tool_response: { task: { id, subject } } });
  const action = (title: string) =>
    OPS.find((o) => o.name === "action")!.run(hoop, { title, description: "Do it.", done_when: { kind: "manual" } } as never, { actor: "claude" });
  action("Run the migration");
  hoop.submit(example());
  const ask = hoop.ask({
    questions: [
      { question: "Keep it?", options: [{ label: "Keep", recommended: true }, { label: "Remove" }] },
      { question: "Which format?", options: [{ label: "CSV" }, { label: "JSON", recommended: true }] },
    ],
  }).review_id;
  await withBrowser(async ({ base, page }) => {
    await page.addInitScript(() => Object.assign(window, { HOOP_PENDING_MS: 200, HOOP_WORK_MS: 200 }));
    await page.goto(`${base}/`);
    await page.locator(".list .action").first().waitFor();
    await press(page, '[data-collapse="home:pending"]');
    await keepsFocus(page, "Home: fold Pending");
    await press(page, "[data-action-decline]");
    await page.locator(".decline input").waitFor();
    await page.keyboard.press("Escape");
    await keepsFocus(page, "Home: Escape from Won't do");
    await press(page, "[data-action-done]");
    await keepsFocus(page, "Home: Done on the last open action item");
    // Done on the last open item puts focus on Undo; a new item arriving redraws Home, and Undo keeps it.
    assert.ok(await hasFocus(page.locator("[data-action-reopen]"), 2000), `Done on the last open item puts focus on Undo ${RULE}`);
    action("Rotate the key");
    await page.locator(".list .action", { hasText: "Rotate the key" }).waitFor();
    assert.ok(await hasFocus(page.locator("[data-action-reopen]"), 2000), `Home's redraw keeps focus on Undo ${RULE}`);

    await page.goto(`${base}/r/${ask}`);
    await page.locator(".ask-opt").first().waitFor();
    await press(page, ".ask-opt");
    await keepsFocus(page, "Quick question: answer");
    await press(page, "[data-other]");
    await page.keyboard.press("Escape");
    await keepsFocus(page, "Quick question: Escape from Other");

    await page.goto(`${base}/work`);
    await page.locator("section.work-session").waitFor();
    await press(page, '[data-act="remove"]');
    await page.locator("[data-confirm]").waitFor();
    await press(page, "[data-confirm]");
    await keepsFocus(page, "Work: Remove a todo");
    await press(page, '[data-act="remove"]');
    await page.locator("[data-cancel]").waitFor();
    await press(page, "[data-cancel]");
    await keepsFocus(page, "Work: Cancel a removal");
    // A todo arriving redraws Work; the frame's Home link keeps focus.
    const link = page.locator('header.frame a[href="/"]:not(.brand)');
    await link.focus();
    workHook(home, { ...HOOKS["post-taskcreate"], tool_input: { subject: "Write the docs" }, tool_response: { task: { id: "3", subject: "Write the docs" } } });
    await page.locator(".todo", { hasText: "Write the docs" }).waitFor();
    assert.ok(await hasFocus(link, 2000), `Work's redraw keeps focus on the link ${RULE}`);
  }, hoop);
});

test(
  "on the build page, a redraw keeps focus on the control, and moving, folding and adding blocks never leave it on the page",
  {
    skip: BROWSER_SKIP,
  },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const id = hoop.startBuild("# Cost\n\nNotes.\n\n## Summary\n\nMost of it is compute.\n\nServers.\n").review_id;
      await page.addInitScript(() => Object.assign(window, { HOOP_BUILD_MS: 200 }));
      await page.goto(`${base}/r/${id}`);
      await page.locator(".bblock").first().waitFor();
      const block = (text: string) => hoop.builds.read(id).blocks.find((x) => x.text === text)!.id;
      const servers = block("Servers.");
      // A block moved: focus follows it to its Edit.
      await press(page, `[data-b-move="${servers}"][data-b-to="up"]`);
      assert.ok(await hasFocus(page.locator(`[data-b-edit="${servers}"]`), 2000), `Move up puts focus on the moved block's Edit ${RULE}`);
      await press(page, `[data-b-move="${servers}"][data-b-to="down"]`);
      assert.ok(await hasFocus(page.locator(`[data-b-edit="${servers}"]`), 2000), `Move down puts focus on the moved block's Edit ${RULE}`);
      // Folding a section is a toggle: focus stays on its fold button.
      const summary = block("## Summary");
      await press(page, `[data-b-fold="${summary}"]`);
      assert.ok(await hasFocus(page.locator(`[data-b-fold="${summary}"]`), 2000), `the fold button keeps focus ${RULE}`);
      // A + opens the kinds of block to add; Escape closes them, back on the +.
      await press(page, '[data-b-add=""]');
      await page.keyboard.press("Escape");
      await keepsFocus(page, "Build: Escape from the + menu");
      // Claude's change redraws the build; Finish and review, which names no block, keeps focus.
      await page.locator("#finishBuild").focus();
      hoop.buildChange(id, { op: "add", kind: "h2", after: hoop.builds.read(id).blocks.at(-1)!.id });
      await page
        .locator(".bblock")
        .nth(hoop.builds.read(id).blocks.length - 1)
        .waitFor();
      assert.ok(await hasFocus(page.locator("#finishBuild"), 2000), `the build's redraw keeps focus on Finish and review ${RULE}`);
    }),
);
