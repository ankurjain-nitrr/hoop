import { test } from "node:test";
import assert from "node:assert/strict";
import { joinBlocks, splitBlocks } from "../src/build.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { parentOf, swapRange, unitRange } from "../web/blocks.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

// b1 # Plan, b2 intro, b3 ## Goals, b4 goals text, b5 ### Detail, b6 detail text, b7 ## Costs,
// b8 costs text, b9 # Appendix, b10 appendix text. The odd separators must survive every move.
const DOC = "# Plan\n\nIntro.\n\n## Goals\n\nGoals text.\n\n\n\n### Detail\n\nDetail text.\n\n## Costs\n\n- Servers\n- Storage\n\n# Appendix\n\nMore.\n";

function started(md = DOC) {
  const hoop = new Hoop(new Store(tempHome()));
  return { hoop, id: hoop.startBuild(md).review_id };
}
const ids = (hoop: Hoop, id: string) => hoop.builds.read(id).blocks.map((b) => b.id);

test("a heading owns every block up to the next heading at its level or above", () => {
  const { blocks } = splitBlocks(DOC);
  // Each block's parent heading, by index: an H2 sits in its H1, an H3 in its H2, text in its heading.
  assert.deepEqual(
    blocks.map((_, i) => parentOf(blocks, i)),
    [-1, 0, 0, 2, 2, 4, 0, 6, -1, 8],
  );
  assert.deepEqual(unitRange(blocks, 0), [0, 8], "the first H1 holds everything up to the next H1");
  assert.deepEqual(unitRange(blocks, 2), [2, 6], "an H2 holds its text and its H3");
  assert.deepEqual(unitRange(blocks, 4), [4, 6]);
  assert.deepEqual(unitRange(blocks, 3), [3, 4], "a paragraph is only itself");
  assert.deepEqual(unitRange(blocks, 8), [8, 10]);
  assert.deepEqual(swapRange(blocks, 6, "up"), [2, 6], "Costs trades places with Goals and its subsection");
  assert.equal(swapRange(blocks, 2, "up"), undefined, "Goals can't leave its H1 past the H1's own text");
  assert.equal(swapRange(blocks, 4, "down"), undefined, "Detail can't move past Costs, a heading above its level");
  assert.equal(swapRange(blocks, 3, "down"), undefined, "a paragraph stays in its section");
  assert.deepEqual(swapRange(blocks, 8, "up"), [0, 8], "an H1 trades places with the H1 before it");
});

test("moving a heading moves its whole section among its siblings, as one step, and never past its parent", () => {
  const { hoop, id } = started();
  let build = hoop.buildChange(id, { op: "move", block: "b7", to: "up" });
  assert.deepEqual(ids(hoop, id), ["b1", "b2", "b7", "b8", "b3", "b4", "b5", "b6", "b9", "b10"]);
  assert.equal(build.steps.at(-1)!.what, 'moved the heading "Costs" before "Goals"');
  assert.equal(build.steps.length, 2, "the whole section moved in one step");
  build = hoop.buildChange(id, { op: "move", block: "b7", to: "down" });
  assert.equal(build.steps.at(-1)!.what, 'moved the heading "Costs" after "Goals"');
  assert.equal(joinBlocks(build), DOC, "moving back gives the document back byte for byte");

  // At a parent's boundary nothing moves and no step is recorded.
  const version = build.version;
  for (const [block, to] of [
    ["b3", "up"],
    ["b5", "down"],
    ["b5", "up"],
    ["b4", "down"],
    ["b4", "up"],
    ["b7", "down"],
  ] as const)
    assert.equal(hoop.buildChange(id, { op: "move", block, to }).version, version, `${block} ${to}`);

  // An H1 moves with everything under it.
  build = hoop.buildChange(id, { op: "move", block: "b9", to: "up" });
  assert.equal(
    joinBlocks(build),
    "# Appendix\n\nMore.\n\n# Plan\n\nIntro.\n\n## Goals\n\nGoals text.\n\n\n\n### Detail\n\nDetail text.\n\n## Costs\n\n- Servers\n- Storage\n",
  );
  assert.equal(build.steps.at(-1)!.what, 'moved the heading "Appendix" before "Plan"');
});

test("a paragraph moves within its section's own text", () => {
  const { hoop, id } = started("# T\n\n## A\n\none\n\ntwo\n\n## B\n");
  const build = hoop.buildChange(id, { op: "move", block: "b3", to: "down" });
  assert.equal(joinBlocks(build), "# T\n\n## A\n\ntwo\n\none\n\n## B\n");
  assert.equal(build.steps.at(-1)!.what, "moved a block down");
  assert.equal(hoop.buildChange(id, { op: "move", block: "b3", to: "down" }).version, build.version, "not into the next section");
});

test("removing a heading takes its section, or only the heading, whose blocks join the section above", () => {
  const { hoop, id } = started();
  hoop.buildWrite(id, "b5", "Claude's detail.");
  let build = hoop.buildChange(id, { op: "remove", block: "b3", section: true });
  assert.equal(joinBlocks(build), "# Plan\n\nIntro.\n\n## Costs\n\n- Servers\n- Storage\n\n# Appendix\n\nMore.\n");
  assert.equal(build.steps.at(-1)!.what, 'removed the heading "Goals" and everything under it');
  assert.equal(build.undo?.b5, undefined, "a removed section's Undo goes with it");

  const other = started();
  build = other.hoop.buildChange(other.id, { op: "remove", block: "b3" });
  assert.equal(
    joinBlocks(build),
    "# Plan\n\nIntro.\n\nGoals text.\n\n\n\n### Detail\n\nDetail text.\n\n## Costs\n\n- Servers\n- Storage\n\n# Appendix\n\nMore.\n",
  );
  assert.equal(build.steps.at(-1)!.what, 'removed the heading "Goals"');
  assert.throws(() => other.hoop.buildChange(other.id, { op: "remove", block: "b5", section: "yes" } as never), /section: true or false/);
});

test("Generate on a heading covers its whole section, subsections included, and Undo puts it all back", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "generate", block: "b3" });
  const [task] = hoop.takeRequests(id);
  assert.equal(task!.section_markdown, "Goals text.\n\n\n\n### Detail\n\nDetail text.");
  assert.throws(() => hoop.buildWrite(id, "b3", "Text.\n\n## Another"), /the person owns the outline/);
  let build = hoop.buildWrite(id, "b3", "New goals.\n\n### Detail\n\nNew detail.");
  assert.equal(
    joinBlocks(build),
    "# Plan\n\nIntro.\n\n## Goals\n\nNew goals.\n\n### Detail\n\nNew detail.\n\n## Costs\n\n- Servers\n- Storage\n\n# Appendix\n\nMore.\n",
  );
  // The section Claude wrote moves as one.
  build = hoop.buildChange(id, { op: "move", block: "b7", to: "up" });
  assert.match(joinBlocks(build), /## Costs\n\n- Servers\n- Storage\n\n## Goals\n\nNew goals\.\n\n### Detail\n\nNew detail\.\n\n# Appendix/);
  build = hoop.buildChange(id, { op: "undo", block: "b3" });
  assert.match(joinBlocks(build), /## Goals\n\nGoals text\.\n\n\n\n### Detail\n\nDetail text\.\n\n# Appendix/);
});

test("on the build page sections nest and indent, fold, move with their content and ask how to be removed, from the keyboard", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(DOC);
    await page.goto(`${base}/r/${id}`);
    await page.locator(".bsec").first().waitFor();

    // Goals sits in Plan's body, Detail in Goals', each further right; Appendix is beside Plan.
    const inside = async (outer: string, inner: string) =>
      (await page.locator(`[data-section="${outer}"] > .bsec-body [data-section="${inner}"]`).count()) === 1;
    const left = async (block: string) => (await page.locator(`[data-block="${block}"]`).boundingBox())!.x;
    const nest = {
      goalsInPlan: await inside("b1", "b3"),
      detailInGoals: await inside("b3", "b5"),
      appendixInPlan: await inside("b1", "b9"),
      lefts: [await left("b1"), await left("b3"), await left("b5")],
      texts: [await left("b2"), await left("b4"), await left("b6")],
      appendix: await left("b9"),
    };
    assert.deepEqual([nest.goalsInPlan, nest.detailInGoals, nest.appendixInPlan], [true, true, false]);
    for (const xs of [nest.lefts, nest.texts]) assert.ok(xs[0]! < xs[1]! && xs[1]! < xs[2]!, `indents ${xs}`);
    assert.equal(nest.appendix, nest.lefts[0]);
    // The + after a heading sits inside its section.
    assert.equal(await page.locator('[data-section="b3"] > .bsec-body > .adder [data-b-add="b3"]').count(), 1);

    // Fold Goals from the keyboard: its section hides, and Enter opens it again.
    const fold = page.getByRole("button", { name: "Collapse Heading 1 “Goals”" });
    await fold.focus();
    await page.keyboard.press("Enter");
    const expand = page.getByRole("button", { name: "Expand Heading 1 “Goals”" });
    await expand.waitFor();
    assert.equal(await expand.getAttribute("aria-expanded"), "false");
    assert.equal(await page.getByText("Detail text.").isVisible(), false);
    assert.equal(await expand.evaluate((el) => el === document.activeElement), true, "focus stays on the toggle");
    await page.keyboard.press("Enter");
    await page.getByText("Detail text.").waitFor();

    // Move Costs above Goals with the keyboard: Goals' subsection goes with it.
    await page.getByRole("button", { name: "Move Heading 1 “Costs” up" }).focus();
    await page.keyboard.press("Enter");
    await page.locator('[data-section="b1"] > .bsec-body > [data-section="b7"] + .bsec[data-section="b3"]').waitFor();
    assert.equal(hoop.markdownOf(id).indexOf("## Costs") < hoop.markdownOf(id).indexOf("## Goals"), true);
    assert.equal(await page.getByRole("button", { name: "Move Heading 1 “Goals” down" }).isDisabled(), true, "Goals is last in Plan");

    // Remove on a heading asks inline; Escape closes the choice.
    const remove = page.getByRole("button", { name: "Remove Heading 1 “Goals”" });
    await remove.click();
    assert.equal(await remove.getAttribute("aria-expanded"), "true");
    const all = page.getByRole("button", { name: "Remove this heading and everything under it" });
    assert.equal(await all.evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press("Escape");
    await page.locator(".bremove").waitFor({ state: "detached" });
    assert.equal(await remove.evaluate((el) => el === document.activeElement), true);
    await remove.click();
    await page.getByRole("button", { name: "Remove only the heading" }).click();
    await page.locator('[data-block="b3"]').waitFor({ state: "detached" });
    assert.equal(
      hoop.markdownOf(id),
      "# Plan\n\nIntro.\n\n## Costs\n\n- Servers\n- Storage\n\nGoals text.\n\n\n\n### Detail\n\nDetail text.\n\n# Appendix\n\nMore.\n",
    );
    await page.getByRole("button", { name: "Remove Heading 1 “Costs”" }).click();
    await page.getByRole("button", { name: "Remove this heading and everything under it" }).click();
    await page.locator('[data-block="b5"]').waitFor({ state: "detached" });
    assert.equal(hoop.markdownOf(id), "# Plan\n\nIntro.\n\n# Appendix\n\nMore.\n");

    // On a phone the indent narrows.
    const indent = () =>
      page
        .locator(".bsec-body")
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).marginLeft));
    const wide = await indent();
    await page.setViewportSize({ width: 400, height: 800 });
    const narrow = await indent();
    assert.ok(narrow < wide, `${narrow} < ${wide}`);
  }),
);
