import { test } from "node:test";
import assert from "node:assert/strict";
import { joinBlocks } from "../src/build.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { BROWSER_SKIP, hasFocus, tempHome, withBrowser } from "./helpers.js";

// Remove on the build page and Dismiss on a suggested heading ask nothing: right after either, Undo
// puts it back (docs/DESIGN-LANGUAGE.md, Confirming an action).

// b1 # Plan, b2 intro, b3 ## Goals, b4 goals text, b5 ### Detail, b6 detail text, b7 ## Costs, b8 costs text.
const DOC = "# Plan\n\nIntro.\n\n## Goals\n\nGoals text.\n\n### Detail\n\nDetail text.\n\n## Costs\n\n- Servers\n";

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

test("Undo refuses to put blocks back after the block they followed is gone", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "remove", block: "b4" });
  // Claude's writes aren't the person's changes, so they keep the removal; here the block before is gone.
  const build = hoop.builds.read(id);
  build.blocks = build.blocks.filter((b) => b.id !== "b3");
  hoop.builds.save(id, build, "claude", "test");
  assert.throws(() => hoop.buildChange(id, { op: "undo_remove" }), /the block it came after is gone/);
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
    await page.locator('[data-b-remove="b4"]').click();
    const undo = page.locator(".undo-line", { hasText: "Removed a block." }).getByRole("button", { name: "Undo" });
    await undo.waitFor();
    assert.equal(await page.locator(".confirm, .bconfirm, .bremove, dialog[open]").count(), 0, "no confirmation");
    assert.equal(
      hoop.builds.read(id).blocks.some((b) => b.id === "b4"),
      false,
      "it went at once",
    );
    await page.waitForFunction(() => document.querySelector("#page-live")?.textContent === "Removed a block. Undo puts it back.");
    // A refresh keeps Undo until the person's next change.
    await page.reload();
    await undo.click();
    await page.locator(".undo-line").waitFor({ state: "detached" });
    assert.equal(hoop.markdownOf(id), DOC);
    assert.ok(await hasFocus(page.locator('[data-b-edit="b4"]')));

    // A heading with its section: Undo stands where it was, and puts it all back.
    await page.getByRole("button", { name: "Remove Heading 1 “Goals”" }).click();
    await page.getByRole("button", { name: "Remove this heading and everything under it" }).click();
    await page.locator(".undo-line", { hasText: "Removed the heading “Goals” and everything under it." }).getByRole("button", { name: "Undo" }).click();
    await page.locator(".undo-line").waitFor({ state: "detached" });
    assert.equal(hoop.markdownOf(id), DOC);
  }),
);

test("on the build page Dismiss on a suggested heading asks nothing: Undo right after puts it back to accept", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild("# Plan\n");
    hoop.buildChange(id, { op: "suggest", block: "b1", kind: "outline" });
    hoop.takeRequests(id);
    hoop.buildSuggest(id, "g1", [{ heading: "## Risks" }]);
    await page.goto(`${base}/r/${id}`);
    await page.getByRole("button", { name: "Dismiss suggested heading “Risks”" }).click();
    const undo = page.getByRole("button", { name: "Undo: put back the suggested heading “Risks”" });
    await undo.waitFor();
    assert.ok(await hasFocus(undo), "with nothing else to accept, focus goes to Undo");
    assert.equal(await page.locator(".bprop").count(), 0);
    await undo.click();
    await page.locator(".bprop").waitFor();
    assert.ok(await hasFocus(page.getByRole("button", { name: "Accept suggested heading “Risks”" })));
    assert.equal(await page.locator(".undo-line").count(), 0, "Undo goes once used");
  }),
);
