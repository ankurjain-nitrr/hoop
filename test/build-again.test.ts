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

/** The person presses Generate again on `block`, Claude takes it and writes `markdown` there. */
function rewrite(hoop: Hoop, id: string, block: string, markdown: string) {
  hoop.buildChange(id, { op: "rewrite", block });
  hoop.takeRequests(id);
  return hoop.buildWriteBlock(id, block, markdown);
}

test("Accept keeps Claude's rewrite, and a second rewrite still undoes to the first text", () => {
  const { hoop, id } = written();
  const before = hoop.markdownOf(id);
  rewrite(hoop, id, "b6", "- Servers: 40\n\n- Storage: 20");
  hoop.buildChange(id, { op: "accept_change", block: "b7" });
  assert.deepEqual(hoop.builds.read(id).changes, []);
  assert.match(hoop.markdownOf(id), /- Servers: 40/);

  rewrite(hoop, id, "b5", "One.");
  rewrite(hoop, id, "b9", "Two.\n\nThree.");
  hoop.buildChange(id, { op: "undo_change", block: "b10" });
  assert.equal(hoop.markdownOf(id), before.replace("- Servers\n- Storage", "- Servers: 40\n\n- Storage: 20"));
});

test("Generate again and block writes are refused where they don't fit", () => {
  const { hoop, id } = written();
  assert.throws(() => hoop.buildChange(id, { op: "rewrite", block: "b3" }), /a heading is written with Generate on it/);
  assert.throws(() => run(hoop, "build_write", { review_id: id, markdown: "x" }), /either section/);
  assert.throws(() => run(hoop, "build_write", { review_id: id, section: "b3", block: "b5", markdown: "x" }), /either section/);
  assert.throws(() => hoop.buildWriteBlock(id, "b3", "Text"), /is a heading/);
  assert.throws(() => hoop.buildChange(id, { op: "undo_change", block: "b5" }), /no change of Claude's waiting/);
  // Writing a block needs a rewrite Claude took on it.
  assert.throws(() => hoop.buildWriteBlock(id, "b5", "Text"), /block b5 has no rewrite request open/);
  hoop.buildChange(id, { op: "edit", block: "b6", text: "- Mine" });
  assert.throws(() => hoop.buildChange(id, { op: "rewrite", block: "b6" }), /only a block Claude wrote can be written again/);
  hoop.buildChange(id, { op: "rewrite", block: "b5" });
  const [task] = hoop.takeRequests(id);
  assert.throws(() => hoop.buildWriteBlock(id, "b5", "## New heading\n\nText"), /can't hold a heading/);
  assert.throws(() => hoop.buildSuggest(id, task!.request, [{ heading: "### X" }]), /hoop_build_write and block/);
  assert.throws(() => hoop.buildWrite(id, "b5", "Text"), new RegExp(`request ${task!.request} is a rewrite: pass block instead of section`));
  assert.throws(() => hoop.buildChange(id, { op: "nope" } as never), /expected op "add"/);
});

test("a late write never replaces the person's edit made after Claude took the request", () => {
  const { hoop, id } = written();
  hoop.buildChange(id, { op: "rewrite", block: "b5" });
  const [task] = hoop.takeRequests(id);
  hoop.buildChange(id, { op: "edit", block: "b5", text: "My own words." });
  assert.throws(() => hoop.buildWriteBlock(id, "b5", "Claude's words."), /the person changed block b5 after you took request g\d+.*call hoop_build_wait again/);
  assert.match(hoop.markdownOf(id), /My own words\./);
  assert.equal(hoop.builds.read(id).requests!.find((r) => r.id === task!.request)!.status, "written", "the request is closed");
});

test("a write answers only the request Claude took; a newer note waits, and the old block ID says where it went", () => {
  const { hoop, id } = written();
  hoop.buildChange(id, { op: "rewrite", block: "b5", note: "shorter" });
  const [first] = hoop.takeRequests(id);
  hoop.buildChange(id, { op: "rewrite", block: "b5", note: "add an example" });
  hoop.buildWriteBlock(id, "b5", "Short.");
  const build = hoop.builds.read(id);
  const newer = build.requests!.find((r) => r.note === "add an example")!;
  assert.deepEqual([newer.status, newer.block], ["queued", "b7"], "the newer request waits, on the block's new ID");
  assert.equal(build.requests!.find((r) => r.id === first!.request)!.block, "b7", "the answered request follows the block");
  const [next] = hoop.takeRequests(id);
  assert.deepEqual([next!.block, next!.block_markdown, next!.note], ["b7", "Short.", "add an example"]);
  assert.throws(() => hoop.buildWriteBlock(id, "b5", "Again."), /block b5 was already rewritten as b7; call hoop_build_wait for the newer request/);
  hoop.buildWriteBlock(id, "b7", "Short, for example.");
  assert.match(hoop.markdownOf(id), /Short, for example\./);
});

test("a rewrite Claude took twice queues the other again, with the new text", () => {
  const { hoop, id } = written();
  hoop.buildChange(id, { op: "rewrite", block: "b5", note: "one" });
  hoop.takeRequests(id);
  const requests = hoop.builds.read(id).requests!;
  // Two taken rewrites on one block, as when Claude took one and the page sent another before it wrote.
  hoop.builds.save(id, { ...hoop.builds.read(id), requests: [...requests, { ...requests.at(-1)!, id: "g9", note: "two" }] }, "claude", "test");
  hoop.buildWriteBlock(id, "b5", "First.");
  const g9 = hoop.builds.read(id).requests!.find((r) => r.id === "g9")!;
  assert.deepEqual([g9.status, g9.block], ["queued", "b7"]);
});

test("a newer Generate again on a block replaces one Claude hasn't taken", () => {
  const { hoop, id } = written();
  hoop.buildChange(id, { op: "rewrite", block: "b5", note: "one" });
  hoop.buildChange(id, { op: "rewrite", block: "b5", note: "two" });
  assert.deepEqual(
    hoop.takeRequests(id).map((t) => t.note),
    ["two"],
  );
});

test("a rewrite keeps the separator that followed the block", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.startBuild("# Plan\n\nWhy.\n\n\n\nAfter.\n");
  rewrite(hoop, id, "b2", "Because.");
  assert.equal(hoop.markdownOf(id), "# Plan\n\nBecause.\n\n\n\nAfter.\n");
});

test("an edit that splits a changed block is all undone, byte for byte; a change whose blocks are gone is dropped", () => {
  const { hoop, id } = written();
  const before = hoop.markdownOf(id);
  rewrite(hoop, id, "b5", "Claude's.");
  hoop.buildChange(id, { op: "edit", block: "b7", text: "Mine.\n\nAnd more." });
  assert.deepEqual(hoop.builds.read(id).changes![0]!.blocks, ["b7", "b8"]);
  hoop.buildChange(id, { op: "undo_change", block: "b8" });
  assert.equal(hoop.markdownOf(id), before);

  rewrite(hoop, id, "b6", "- Gone");
  hoop.buildChange(id, { op: "remove", block: "b9" });
  assert.deepEqual(hoop.builds.read(id).changes, []);
});

test("Finish is refused while one of Claude's changes waits", () => {
  const { hoop, id } = written();
  rewrite(hoop, id, "b5", "Claude's.");
  assert.throws(() => hoop.finishBuild(id), /Accept or undo Claude's 1 waiting change first/);
  hoop.buildChange(id, { op: "accept_change", block: "b7" });
  assert.equal(hoop.finishBuild(id).outcome, "revised");
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
    assert.equal(await page.locator('[data-block="b5"] [role="status"]').count(), 1, "one live region for the block");
    assert.deepEqual([again!.kind, again!.block, again!.note], ["rewrite", "b5", "shorter"]);
    await page.locator(".bstatus", { hasText: "Claude is writing this again" }).waitFor();
    hoop.buildWriteBlock(review, "b5", "Mostly compute.");
    await page.getByRole("button", { name: "Undo Claude's change to Paragraph 4" }).click();
    await page.locator(".bpara strong", { hasText: "most" }).waitFor();

    // A rewrite of the list, accepted. Finish first points at it.
    rewrite(hoop, review, "b6", "- Servers: 40\n- Storage: 20");
    await page.getByRole("button", { name: "Accept Claude's change to List 5" }).waitFor();
    await page.getByRole("button", { name: "Finish and review" }).click();
    await page.locator(".berr", { hasText: "Accept or undo Claude's 1 waiting change first" }).waitFor();
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute("aria-label")), "Accept Claude's change to List 5");
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
