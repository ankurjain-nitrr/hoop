import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { OPS } from "../src/ops.js";
import { Store } from "../src/store.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

const OUTLINE = "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n\n## Options\n";
const run = (hoop: Hoop, name: string, input: Record<string, unknown>) => OPS.find((o) => o.name === name)!.run(hoop, input, { actor: "claude" });

/** A build whose "Where the money goes" Claude wrote: b5 a paragraph, b6 a list, then ## Options (b4). */
function written() {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.startBuild(OUTLINE);
  hoop.buildWrite(id, "b3", "Compute is **most** of it.\n\n- Servers\n- Storage");
  return { hoop, id };
}

test("Generate again on a block Claude wrote asks Claude for that block alone, and Undo puts it back", () => {
  const { hoop, id } = written();
  const before = hoop.markdownOf(id);
  hoop.buildChange(id, { op: "rewrite", block: "b5", note: " shorter " });
  const [task] = hoop.takeRequests(id);
  assert.deepEqual(
    { kind: task!.kind, block: task!.block, block_markdown: task!.block_markdown, note: task!.note, section: task!.section },
    { kind: "rewrite", block: "b5", block_markdown: "Compute is **most** of it.", note: "shorter", section: "b3" },
  );
  assert.equal(task!.section_markdown, "Compute is **most** of it.\n\n- Servers\n- Storage", "with what sits under its heading");

  const out = run(hoop, "build_write", { review_id: id, block: "b5", markdown: "Compute is **70%**." }) as { markdown: string };
  assert.equal(out.markdown, before.replace("Compute is **most** of it.", "Compute is **70%**."), "only that block changed");
  const build = hoop.builds.read(id);
  assert.deepEqual(
    build.changes?.map((c) => [c.blocks, c.before.map((b) => b.text)]),
    [[["b7"], ["Compute is **most** of it."]]],
  );
  assert.equal(build.requests!.find((r) => r.kind === "rewrite")!.status, "written");
  assert.deepEqual(
    build.steps.slice(-3).map((s) => [s.by, s.what]),
    [
      ["person", "asked Claude to write a block again"],
      ["claude", "started on a block"],
      ["claude", "rewrote a block"],
    ],
  );

  hoop.buildChange(id, { op: "undo_change", block: "b7" });
  assert.equal(hoop.markdownOf(id), before, "Undo puts back what was there");
  assert.deepEqual(hoop.builds.read(id).changes, []);
});

test("Accept keeps Claude's rewrite, and a second rewrite still undoes to the first text", () => {
  const { hoop, id } = written();
  const before = hoop.markdownOf(id);
  hoop.buildWriteBlock(id, "b6", "- Servers: 40\n\n- Storage: 20");
  hoop.buildChange(id, { op: "accept_change", block: "b7" });
  assert.deepEqual(hoop.builds.read(id).changes, []);
  assert.match(hoop.markdownOf(id), /- Servers: 40/);

  hoop.buildWriteBlock(id, "b5", "One.");
  hoop.buildWriteBlock(id, "b9", "Two.\n\nThree.");
  hoop.buildChange(id, { op: "undo_change", block: "b10" });
  assert.equal(hoop.markdownOf(id), before.replace("- Servers\n- Storage", "- Servers: 40\n\n- Storage: 20"));
});

test("Generate again and block writes are refused where they don't fit", () => {
  const { hoop, id } = written();
  assert.throws(() => hoop.buildChange(id, { op: "rewrite", block: "b3" }), /a heading is written with Generate on it/);
  assert.throws(() => run(hoop, "build_write", { review_id: id, markdown: "x" }), /either section/);
  assert.throws(() => run(hoop, "build_write", { review_id: id, section: "b3", block: "b5", markdown: "x" }), /either section/);
  assert.throws(() => hoop.buildWriteBlock(id, "b5", "## New heading\n\nText"), /can't hold a heading/);
  assert.throws(() => hoop.buildWriteBlock(id, "b3", "Text"), /is a heading/);
  assert.throws(() => hoop.buildChange(id, { op: "undo_change", block: "b5" }), /no change of Claude's waiting/);
  hoop.buildChange(id, { op: "rewrite", block: "b5" });
  assert.throws(() => hoop.buildSuggest(id, hoop.takeRequests(id)[0]!.request, [{ heading: "### X" }]), /hoop_build_write and block/);
});

test("on the page, Generate again asks Claude to write a block again, and its change waits for Accept or Undo", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: review } = hoop.startBuild(OUTLINE);
    hoop.buildWrite(review, "b3", "Compute is **most** of it.\n\n- Servers\n- Storage");
    hoop.buildChange(review, { op: "edit", block: "b2", text: "What this helps decide." });
    await page.goto(`${base}/r/${review}`);
    await page.locator(".bpara strong", { hasText: "most" }).waitFor();
    // Only blocks Claude wrote offer it, not the person's; the heading's own Generate again is labelled in words.
    assert.equal(await page.getByRole("button", { name: "Generate again Paragraph 2" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Generate again Heading 1 “Where the money goes”" }).innerText(), "Generate again");

    await page.getByRole("button", { name: "Generate again Paragraph 4" }).click();
    await page.getByLabel("What should change in Paragraph 4? (optional)").fill("shorter");
    await page.keyboard.press("Enter");
    await page.locator(".bstatus", { hasText: "Queued: Claude writes this again" }).waitFor();
    const [again] = hoop.takeRequests(review);
    assert.deepEqual([again!.kind, again!.block, again!.note], ["rewrite", "b5", "shorter"]);
    await page.locator(".bstatus", { hasText: "Claude is writing this again" }).waitFor();
    hoop.buildWriteBlock(review, "b5", "Mostly compute.");
    await page.getByRole("button", { name: "Undo Claude's change to Paragraph 4" }).click();
    await page.locator(".bpara strong", { hasText: "most" }).waitFor();

    // A rewrite of the list, accepted.
    hoop.buildWriteBlock(review, "b6", "- Servers: 40\n- Storage: 20");
    await page.getByRole("button", { name: "Accept Claude's change to List 5" }).click();
    await page.locator(".bchange").waitFor({ state: "detached" });
    assert.match(hoop.markdownOf(review), /- Servers: 40\n- Storage: 20\n/);

    // "Everything under the heading" asks for the heading's Generate instead.
    await page.getByRole("button", { name: "Generate again Paragraph 4" }).click();
    await page.getByLabel("Everything under the heading “Where the money goes”").check();
    await page.getByRole("button", { name: "Generate again", exact: true }).click();
    await page.locator('[data-block="b3"] .bstatus', { hasText: "Queued" }).waitFor();
    const [all] = hoop.takeRequests(review);
    assert.deepEqual([all!.kind, all!.section], ["write", "b3"]);
  }),
);
