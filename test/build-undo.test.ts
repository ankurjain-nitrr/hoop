import { test } from "node:test";
import assert from "node:assert/strict";
import { joinBlocks } from "../src/build.js";
import { Hoop } from "../src/hoop.js";
import { freshId } from "../src/build-removed.js";
import { Store } from "../src/store.js";
import type { Locator, Page } from "playwright-core";
import { BROWSER_SKIP, hasFocus, tempHome, withBrowser, writeSaved } from "./helpers.js";

// Remove on the build page and Dismiss on a suggested heading ask nothing: right after either, Undo
// puts it back (docs/DESIGN-LANGUAGE.md, Confirming an action).

// b1 # Plan, b2 intro, b3 ## Goals, b4 goals text, b5 ### Detail, b6 detail text, b7 ## Costs, b8 costs text.
const DOC = "# Plan\n\nIntro.\n\n## Goals\n\nGoals text.\n\n### Detail\n\nDetail text.\n\n## Costs\n\n- Servers\n";

/** A block's name as its Remove names it: "Paragraph 2". */
const nameOf = async (page: Page, id: string) => (await page.locator(`[data-b-remove="${id}"]`).getAttribute("aria-label"))!.replace(/^Remove /, "");

/** Whether a button's description is its error line, a live alert. */
const describedByAlert = (undo: Locator) =>
  undo.evaluate((b) => document.getElementById(b.getAttribute("aria-describedby") ?? "")?.getAttribute("role") === "alert");

function started(md = DOC) {
  const hoop = new Hoop(new Store(tempHome()));
  return { hoop, id: hoop.startBuild(md).review_id };
}

test("Undo right after a removal puts the blocks back where they were, byte for byte; any other change forgets it", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "remove", block: "b4" });
  let build = hoop.buildChange(id, { op: "undo_remove" });
  assert.equal(joinBlocks(build), DOC);
  assert.equal(build.steps.at(-1)!.what, "put back a block");
  assert.equal(build.steps.at(-1)!.block, "b4");
  assert.equal(build.removed, undefined, "Undo goes once used");
  assert.throws(() => hoop.buildChange(id, { op: "undo_remove" }), /nothing removed to put back/);

  // A heading with everything under it goes back as one.
  hoop.buildChange(id, { op: "remove", block: "b3", section: true });
  build = hoop.buildChange(id, { op: "undo_remove" });
  assert.equal(joinBlocks(build), DOC);
  assert.equal(build.steps.at(-1)!.what, 'put back the heading "Goals" and everything under it');

  // The first block goes back first.
  hoop.buildChange(id, { op: "remove", block: "b1" });
  assert.equal(hoop.builds.read(id).removed?.after, null);
  assert.equal(joinBlocks(hoop.buildChange(id, { op: "undo_remove" })), DOC);

  // Undo is for right after: the person's next change forgets what was removed.
  hoop.buildChange(id, { op: "remove", block: "b6" });
  hoop.buildChange(id, { op: "edit", block: "b2", text: "Intro, edited." });
  assert.equal(hoop.builds.read(id).removed, undefined);
  assert.throws(() => hoop.buildChange(id, { op: "undo_remove" }), /nothing removed to put back/);
});

test("Undo puts the blocks back before the block after them when the one before is gone, and refuses when both are", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "remove", block: "b4" });
  // Claude's writes aren't the person's changes, so they keep the removal; here the block before is gone.
  const build = hoop.builds.read(id);
  build.blocks = build.blocks.filter((b) => b.id !== "b3");
  hoop.builds.save(id, build, "claude", "test");
  assert.deepEqual(
    hoop.buildChange(id, { op: "undo_remove" }).blocks.map((b) => b.id),
    ["b1", "b2", "b4", "b5", "b6", "b7", "b8"],
  );
  hoop.buildChange(id, { op: "remove", block: "b6" });
  const gone = hoop.builds.read(id);
  gone.blocks = gone.blocks.filter((b) => b.id !== "b5" && b.id !== "b7");
  hoop.builds.save(id, gone, "claude", "test");
  assert.throws(() => hoop.buildChange(id, { op: "undo_remove" }), /the blocks around it are gone/);
});

/** The parts of a build a removal touches, to compare before it and after its Undo. */
const state = (hoop: Hoop, id: string) => {
  const { blocks, changes, undo, history, drafts, notes, requests } = hoop.builds.read(id);
  return { markdown: joinBlocks(hoop.builds.read(id)), blocks, changes, undo, history, drafts, notes, open: requests?.filter((r) => r.status !== "written") };
};

test("regression: Undo after removing a block keeps Claude's rewrite waiting on it, not saved as the person's text", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "rewrite", block: "b4" });
  hoop.takeRequests(id);
  const written = hoop.buildWriteBlock(id, "b4", "Claude's goals.");
  const mine = written.blocks.find((b) => b.text === "Claude's goals.")!.id;
  const before = state(hoop, id);
  assert.equal(before.changes?.length, 1, "Claude's rewrite waits");
  hoop.buildChange(id, { op: "remove", block: mine });
  assert.deepEqual(hoop.builds.read(id).changes, [], "the removal drops it");
  hoop.buildChange(id, { op: "undo_remove" });
  assert.deepEqual(state(hoop, id), before);
  // It still waits to be accepted or undone: Discard puts back the person's text.
  assert.equal(joinBlocks(hoop.buildChange(id, { op: "undo_change", block: mine })), DOC);
});

test("regression: Undo after removing a heading brings back its earlier versions, Claude's draft, Save's Undo and its pending Generate", () => {
  const { hoop, id } = started();
  writeSaved(hoop, id, "b5", "Claude's detail.");
  hoop.buildWrite(id, "b5", "A newer detail.");
  hoop.buildChange(id, { op: "generate", block: "b7", note: "list them" });
  const before = state(hoop, id);
  assert.ok(before.undo?.b5 && before.history?.b5 && before.drafts?.length, "a version, a draft and Save's Undo on Detail");
  hoop.buildChange(id, { op: "remove", block: "b3", section: true });
  hoop.buildChange(id, { op: "remove", block: "b7", section: true });
  // Claude's session takes requests in between: the Generate on the removed heading closes.
  hoop.takeRequests(id);
  hoop.buildChange(id, { op: "undo_remove" });
  assert.equal(hoop.builds.read(id).requests!.find((r) => r.block === "b7")!.status, "queued", "the Generate waits again");
  assert.equal(hoop.takeRequests(id)[0]!.section, "b7", "and Claude takes it");
  // The earlier removal can't be undone: only the last one is.
  assert.throws(() => hoop.buildChange(id, { op: "undo_remove" }), /nothing removed to put back/);
  const again = started();
  writeSaved(again.hoop, again.id, "b5", "Claude's detail.");
  again.hoop.buildWrite(again.id, "b5", "A newer detail.");
  const was = state(again.hoop, again.id);
  again.hoop.buildChange(again.id, { op: "remove", block: "b3", section: true });
  again.hoop.buildChange(again.id, { op: "undo_remove" });
  assert.deepEqual(state(again.hoop, again.id), was);
});

test("regression: Claude rewriting the block before a removal keeps Undo, which puts the blocks back after Claude's text", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "rewrite", block: "b4" });
  hoop.takeRequests(id);
  hoop.buildChange(id, { op: "remove", block: "b5", section: true });
  hoop.buildWriteBlock(id, "b4", "Claude's goals.\n\nAnd more.");
  const build = hoop.buildChange(id, { op: "undo_remove" });
  assert.match(joinBlocks(build), /Claude's goals\.\n\nAnd more\.\n\n### Detail\n\nDetail text\.\n\n## Costs/);
});

test("regression: a change Claude writes while a removal waits for Undo takes a new ID, so Undo brings back the removed one, in order", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "rewrite", block: "b4" });
  hoop.buildChange(id, { op: "rewrite", block: "b8" });
  hoop.takeRequests(id);
  const mine = hoop.buildWriteBlock(id, "b4", "Claude's goals.").blocks.find((b) => b.text === "Claude's goals.")!.id;
  hoop.buildChange(id, { op: "remove", block: mine });
  hoop.buildWriteBlock(id, "b8", "- Claude's servers");
  assert.deepEqual(
    hoop.builds.read(id).changes!.map((c) => c.id),
    ["c2"],
    "the removed change's ID isn't reused",
  );
  const build = hoop.buildChange(id, { op: "undo_remove" });
  assert.deepEqual(
    build.changes!.map((c) => [c.id, c.before[0]!.id]),
    [
      ["c1", "b4"],
      ["c2", "b8"],
    ],
  );
  // Claude's goals still wait: Discard puts back the person's text.
  assert.match(joinBlocks(hoop.buildChange(id, { op: "undo_change", block: mine })), /## Goals\n\nGoals text\./);
});

test("regression: a note Claude adds while a removal waits for Undo takes a new ID", () => {
  const { hoop, id } = started();
  const build = hoop.builds.read(id);
  // A note that went with a removal, kept for Undo.
  build.notes = [];
  build.removed = {
    blocks: [],
    after: null,
    before: null,
    what: "a block",
    level: 0,
    kept: { notes: [{ id: "n1", section: "b3", with: "b4", block: "b6", note: "x", at: "", status: "open" }] },
  };
  assert.equal(freshId(build, "n"), "n2");
  assert.equal(freshId(build, "n"), "n3", "and the next one after it");
  delete build.removed;
  assert.equal(freshId(build, "n"), "n4", "an ID once given never comes back");
});

test("regression: a rewrite Claude had taken is still taken after Undo, so Claude's late write lands", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "rewrite", block: "b4" });
  hoop.takeRequests(id);
  hoop.buildChange(id, { op: "remove", block: "b4" });
  hoop.buildChange(id, { op: "undo_remove" });
  assert.equal(hoop.builds.read(id).requests![0]!.status, "taken");
  const build = hoop.buildWriteBlock(id, "b4", "Claude's goals.");
  assert.equal(build.changes?.length, 1, "Claude's rewrite waits to be accepted");
});

test("Undo after a dismissal puts the suggested heading back to accept", () => {
  const { hoop, id } = started("# Plan\n");
  hoop.buildChange(id, { op: "suggest", block: "b1", kind: "outline" });
  hoop.takeRequests(id);
  const p = hoop.buildSuggest(id, "g1", [{ heading: "## Risks" }]).proposals![0]!;
  hoop.buildChange(id, { op: "dismiss", proposal: p.id });
  const build = hoop.buildChange(id, { op: "undo_dismiss", proposal: p.id });
  assert.equal(build.proposals![0]!.status, "proposed");
  assert.equal(build.steps.at(-1)!.what, 'put back the suggested heading "Risks"');
  assert.throws(() => hoop.buildChange(id, { op: "undo_dismiss", proposal: p.id }), /no dismissed suggestion/);
});

test("on the build page Remove asks nothing: Undo right after puts the block back, with focus on it", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(DOC);
    await page.goto(`${base}/r/${id}`);
    const name = await nameOf(page, "b4");
    assert.match(name, /^Paragraph \d+$/);
    await page.locator('[data-b-remove="b4"]').click();
    // regression: the line and Undo name the block as its Remove did.
    const undo = page.locator(".undo-line", { hasText: `Removed ${name}.` }).getByRole("button", { name: `Undo: put back ${name}`, exact: true });
    await undo.waitFor();
    assert.ok(await describedByAlert(undo), "Undo is described by its error line");
    assert.equal(await page.locator(".confirm, .bconfirm, .bremove, dialog[open]").count(), 0, "no confirmation");
    assert.equal(
      hoop.builds.read(id).blocks.some((b) => b.id === "b4"),
      false,
      "it went at once",
    );
    await page.waitForFunction((said) => document.querySelector("#page-live")?.textContent === said, `Removed ${name}. Undo puts it back.`);
    // A refresh keeps Undo until the person's next change.
    await page.reload();
    await undo.click();
    await page.locator(".undo-line").waitFor({ state: "detached" });
    assert.equal(hoop.markdownOf(id), DOC);
    assert.ok(await hasFocus(page.locator('[data-b-edit="b4"]')));
    await page.waitForFunction((said) => document.querySelector("#page-live")?.textContent === said, `Put back ${name}.`);

    // A heading with its section: Undo stands where it was, and puts it all back.
    await page.getByRole("button", { name: "Remove Heading 1 “Goals”" }).click();
    await page.getByRole("button", { name: "Remove this heading and everything under it" }).click();
    await page.getByRole("button", { name: "Undo: put back the heading “Goals” and everything under it", exact: true }).click();
    await page.locator(".undo-line").waitFor({ state: "detached" });
    assert.equal(hoop.markdownOf(id), DOC);

    // A choice of what to remove isn't a confirmation: once chosen, it goes at once and Undo follows.
    await page.getByRole("button", { name: "Remove Heading 1 “Goals”" }).click();
    await page.getByRole("button", { name: "Remove only the heading" }).click();
    const back = page.getByRole("button", { name: "Undo: put back the heading “Goals”", exact: true });
    await back.waitFor();
    assert.equal(
      hoop.builds.read(id).blocks.some((b) => b.id === "b3"),
      false,
      "it went at once",
    );
    await back.click();
    await page.locator(".undo-line").waitFor({ state: "detached" });
    assert.equal(hoop.markdownOf(id), DOC);
  }),
);

test(
  "regression: the Undo line for a removed heading sits at its level, outside a folded section, with focus on a control that shows",
  { skip: BROWSER_SKIP },
  () =>
    withBrowser(async ({ hoop, base, page }) => {
      const { review_id: id } = hoop.startBuild(DOC);
      await page.goto(`${base}/r/${id}`);
      // Goals folded: Costs follows the last block inside it, Detail text.
      await page.locator('[data-b-fold="b3"]').click();
      await page.getByRole("button", { name: "Remove Heading 1 “Costs”" }).click();
      await page.getByRole("button", { name: "Remove this heading and everything under it" }).click();
      const undo = page.getByRole("button", { name: "Undo: put back the heading “Costs” and everything under it", exact: true });
      await undo.waitFor();
      assert.ok(await undo.isVisible(), "the line shows, not inside the folded section");
      assert.equal(await page.locator('[data-section="b3"] .undo-line').count(), 0, "it sits beside Goals, not in it");
      assert.ok(await hasFocus(undo), "the + before Costs is folded away, so focus goes to Undo");
      await undo.click();
      await page.locator(".undo-line").waitFor({ state: "detached" });
      assert.equal(hoop.markdownOf(id), DOC);
      assert.ok(await hasFocus(page.locator('[data-b-edit="b7"]')));
    }),
);

test("regression: when the block before a removal is gone, the Undo line sits where Undo puts it back, before the block after it", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(DOC);
    await page.goto(`${base}/r/${id}`);
    // Detail text goes; then the Detail heading before it goes too, as if Claude had rewritten it away.
    const name = await nameOf(page, "b6");
    await page.locator('[data-b-remove="b6"]').click();
    const undo = page.getByRole("button", { name: `Undo: put back ${name}`, exact: true });
    await undo.waitFor();
    const build = hoop.builds.read(id);
    build.blocks = build.blocks.filter((b) => b.id !== "b5");
    hoop.builds.save(id, build, "claude", "test");
    await page.reload();
    await undo.waitFor();
    // It comes back after Goals text, before Costs: the line is there, under Goals, not at the top.
    assert.equal(await page.locator('[data-section="b3"] .undo-line').count(), 1);
    assert.equal(
      await page.evaluate(() => {
        const line = document.querySelector(".undo-line");
        const before = document.querySelector('[data-block="b4"]');
        return Boolean(line && before && before.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
      true,
      "after Goals text",
    );
    await undo.click();
    await page.locator(".undo-line").waitFor({ state: "detached" });
    assert.match(hoop.markdownOf(id), /Goals text\.\n\nDetail text\.\n\n## Costs/);
  }),
);

test("regression: when Undo can't put a block back, the page says why under it and keeps it", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(DOC);
    await page.goto(`${base}/r/${id}`);
    const name = await nameOf(page, "b6");
    await page.locator('[data-b-remove="b6"]').click();
    const undo = page.getByRole("button", { name: `Undo: put back ${name}`, exact: true });
    await undo.waitFor();
    // The blocks on both sides go, as if Claude had rewritten them away.
    const build = hoop.builds.read(id);
    build.blocks = build.blocks.filter((b) => b.id !== "b5" && b.id !== "b7");
    hoop.builds.save(id, build, "claude", "test");
    await undo.click();
    await page.locator(".undo-line + .berr", { hasText: "the blocks around it are gone, so it can't go back where it was" }).waitFor();
    assert.ok(await hasFocus(undo));
  }),
);

test("on the build page Dismiss on a suggested heading asks nothing: Undo right after puts it back to accept", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild("# Plan\n");
    hoop.buildChange(id, { op: "suggest", block: "b1", kind: "outline" });
    hoop.takeRequests(id);
    hoop.buildSuggest(id, "g1", [{ heading: "## Risks" }]);
    await page.goto(`${base}/r/${id}`);
    const card = await page.locator(".bprops").boundingBox();
    await page.getByRole("button", { name: "Dismiss suggested heading “Risks”" }).click();
    const undo = page.getByRole("button", { name: "Undo: put back the suggested heading “Risks”" });
    await undo.waitFor();
    // regression: the line sits where Claude's suggestions were, lined up with their card.
    const line = await page.locator(".undo-line").boundingBox();
    assert.ok(Math.abs(line!.x - card!.x) < 1, `the line starts at ${line!.x}px, the card at ${card!.x}px`);
    assert.ok(await describedByAlert(undo), "Undo is described by its error line");
    assert.ok(await hasFocus(undo), "with nothing else to accept, focus goes to Undo");
    assert.equal(await page.locator(".bprop").count(), 0);
    await undo.click();
    await page.locator(".bprop").waitFor();
    assert.ok(await hasFocus(page.getByRole("button", { name: "Accept suggested heading “Risks”" })));
    assert.equal(await page.locator(".undo-line").count(), 0, "Undo goes once used");
    // regression: screen readers hear what came back.
    await page
      .waitForFunction(() => document.querySelector("#page-live")?.textContent === "Put back the suggested heading “Risks”.", undefined, { timeout: 3000 })
      .catch(async () => assert.fail(`the live region says ${await page.locator("#page-live").textContent()}`));
  }),
);
