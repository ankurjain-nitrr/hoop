import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { VERSIONS_MAX } from "../src/build-history.js";
import { OPS } from "../src/ops.js";
import { Store } from "../src/store.js";
import { BROWSER_SKIP, hasFocus, tempHome, withBrowser, writeSaved } from "./helpers.js";

// Each section keeps its earlier versions, which the person steps through and saves back; and
// Claude's notes on text it wrote that contradicts other text it wrote (#349).

// b1 # title, b2 paragraph, b3 ## Where the money goes, b4 paragraph, b5 ## Options, b6 ## Risks
const OUTLINE = "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n\nOld guess.\n\n## Options\n\n## Risks\n";
const run = (hoop: Hoop, name: string, input: Record<string, unknown>) => OPS.find((o) => o.name === name)!.run(hoop, input, { actor: "claude" });

function started(markdown = OUTLINE) {
  const hoop = new Hoop(new Store(tempHome()));
  return { hoop, id: hoop.startBuild(markdown).review_id };
}

/** A section's versions, oldest first, as [how, texts]. */
const versions = (hoop: Hoop, id: string, section: string) =>
  (hoop.builds.read(id).history?.[section]?.versions ?? []).map((v) => [v.how ?? "start", v.blocks.map((b) => b.text)]);
const section = (hoop: Hoop, id: string) => hoop.markdownOf(id).split("## Where the money goes\n\n")[1]!.split("\n\n## Options")[0];

test("a saved draft keeps the text it replaced as a version; a draft never saved, or discarded, makes none", () => {
  const { hoop, id } = started();
  hoop.buildWrite(id, "b3", "First draft.");
  hoop.buildChange(id, { op: "discard_draft", block: "b3" });
  hoop.buildWrite(id, "b3", "Second draft.");
  assert.deepEqual(versions(hoop, id, "b3"), [], "a draft waiting or discarded is no version");
  hoop.buildChange(id, { op: "save_draft", block: "b3" });
  assert.deepEqual(versions(hoop, id, "b3"), [["start", ["Old guess."]]]);
  assert.deepEqual(hoop.builds.read(id).history!.b3!.current!.how, "generated");
  assert.equal(section(hoop, id), "Second draft.");
});

test("restore makes an old version current and keeps the replaced one as a version", () => {
  const { hoop, id } = started();
  writeSaved(hoop, id, "b3", "Claude's text.");
  const added = hoop.builds.read(id).blocks.find((b) => b.text === "Claude's text.")!.id;
  hoop.buildChange(id, { op: "edit", block: added, text: "My text." });
  assert.deepEqual(versions(hoop, id, "b3"), [
    ["start", ["Old guess."]],
    ["generated", ["Claude's text."]],
  ]);
  const [first, second] = hoop.builds.read(id).history!.b3!.versions;
  // Saving the first version back: its text is current, and the person's text is the newest version.
  const restored = hoop.buildChange(id, { op: "restore", block: "b3", version: first!.id });
  assert.equal(section(hoop, id), "Old guess.");
  assert.deepEqual(versions(hoop, id, "b3"), [
    ["generated", ["Claude's text."]],
    ["edited", ["My text."]],
  ]);
  assert.equal(restored.steps.at(-1)!.what, "saved an earlier version of the text under a heading");
  // And back again: Claude's version is current, the start text a version once more.
  hoop.buildChange(id, { op: "restore", block: "b3", version: second!.id });
  assert.equal(section(hoop, id), "Claude's text.");
  assert.deepEqual(versions(hoop, id, "b3"), [
    ["edited", ["My text."]],
    ["start", ["Old guess."]],
  ]);
  assert.equal(hoop.builds.read(id).history!.b3!.current!.how, "generated");
  assert.throws(() => hoop.buildChange(id, { op: "restore", block: "b3", version: second!.id }), /no version v2/);
  assert.throws(() => hoop.buildChange(id, { op: "restore", block: "b9", version: "v1" }), /has no block b9/);
});

test("Undo puts back the text before Claude's save, which stops being a version, and keeps Claude's text as one", () => {
  const { hoop, id } = started();
  writeSaved(hoop, id, "b3", "Claude's text.");
  hoop.buildChange(id, { op: "undo", block: "b3" });
  assert.equal(section(hoop, id), "Old guess.");
  assert.deepEqual(versions(hoop, id, "b3"), [["generated", ["Claude's text."]]]);
  // Claude's text comes back from its version, and the start text is a version again.
  const [v] = hoop.builds.read(id).history!.b3!.versions;
  hoop.buildChange(id, { op: "restore", block: "b3", version: v!.id });
  assert.equal(section(hoop, id), "Claude's text.");
  assert.deepEqual(versions(hoop, id, "b3"), [["start", ["Old guess."]]]);
});

test("a saved rewrite makes a version and a discarded one doesn't; restore waits while a rewrite does", () => {
  const { hoop, id } = started();
  writeSaved(hoop, id, "b3", "Claude's text.");
  const block = hoop.builds.read(id).blocks.find((b) => b.text === "Claude's text.")!.id;
  hoop.buildChange(id, { op: "rewrite", block });
  hoop.takeRequests(id);
  hoop.buildWriteBlock(id, block, "Shorter.");
  assert.deepEqual(versions(hoop, id, "b3"), [["start", ["Old guess."]]], "a rewrite waiting is no version");
  const v1 = hoop.builds.read(id).history!.b3!.versions[0]!.id;
  assert.throws(() => hoop.buildChange(id, { op: "restore", block: "b3", version: v1 }), /Claude's change waits under this heading: save or discard it first/);
  const rewritten = hoop.builds.read(id).blocks.find((b) => b.text === "Shorter.")!.id;
  hoop.buildChange(id, { op: "undo_change", block: rewritten });
  assert.deepEqual(versions(hoop, id, "b3"), [["start", ["Old guess."]]], "a discarded rewrite is no version");
  hoop.buildChange(id, { op: "rewrite", block });
  hoop.takeRequests(id);
  hoop.buildWriteBlock(id, block, "Shorter.");
  hoop.buildChange(id, { op: "accept_change", block: hoop.builds.read(id).blocks.find((b) => b.text === "Shorter.")!.id });
  assert.deepEqual(versions(hoop, id, "b3"), [
    ["start", ["Old guess."]],
    ["generated", ["Claude's text."]],
  ]);
  assert.equal(hoop.builds.read(id).history!.b3!.current!.how, "rewrote");
});

test("the person's edits in a row are one version, and a section keeps at most its last versions", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "edit", block: "b4", text: "One." });
  hoop.buildChange(id, { op: "add", kind: "paragraph", after: "b4" });
  const added = hoop.builds.read(id).blocks[4]!.id;
  hoop.buildChange(id, { op: "edit", block: added, text: "Two." });
  assert.deepEqual(versions(hoop, id, "b3"), [["start", ["Old guess."]]]);
  // A heading's own edit, and a block added under another heading, aren't versions of this one.
  hoop.buildChange(id, { op: "edit", block: "b3", text: "## Where it goes" });
  hoop.buildChange(id, { op: "add", kind: "paragraph", after: "b5" });
  assert.equal(versions(hoop, id, "b3").length, 1);
  assert.equal(versions(hoop, id, "b5").length, 0, "the first text under a heading replaces nothing, so it keeps no version");
  for (let k = 0; k < VERSIONS_MAX + 3; k++) writeSaved(hoop, id, "b3", `Draft ${k}.`);
  const kept = versions(hoop, id, "b3");
  assert.equal(kept.length, VERSIONS_MAX);
  assert.deepEqual(kept.at(-1), ["generated", [`Draft ${VERSIONS_MAX + 1}.`]]);
  // A section that is gone takes its versions with it.
  hoop.buildChange(id, { op: "remove", block: "b3", section: true });
  assert.equal(hoop.builds.read(id).history?.b3, undefined);
});

test("write refuses a contradiction note naming a missing block, or one Claude didn't write", () => {
  const { hoop, id } = started();
  writeSaved(hoop, id, "b3", "Compute is 70% of it.");
  const mine = hoop.builds.read(id).blocks.find((b) => b.text === "Compute is 70% of it.")!.id;
  const note = "Risks says compute is half";
  // The build started from Claude's notes; the person makes the paragraph under the title theirs.
  hoop.buildChange(id, { op: "edit", block: "b2", text: "What this helps decide." });
  assert.throws(() => hoop.buildWrite(id, "b6", "Compute is half.", undefined, undefined, { block: "b99", note }), /the build has no block b99/);
  assert.throws(
    () => hoop.buildWrite(id, "b6", "Compute is half.", undefined, undefined, { block: "b2", note }),
    /block b2 isn't text you wrote \(the person wrote or edited it, or you didn't write it with hoop_build_write\): flag only your own text/,
  );
  assert.throws(() => hoop.buildWrite(id, "b6", "Compute is half.", undefined, undefined, { block: "b3", note }), /isn't text you wrote/);
  assert.throws(
    () => hoop.buildWrite(id, "b6", "Compute is half.", undefined, undefined, { block: mine, note: "  " }),
    /say in one line what contradicts what/,
  );
  // A block Claude wrote but the person edited since is theirs.
  hoop.buildChange(id, { op: "edit", block: mine, text: "Compute is 70% of it, roughly." });
  assert.throws(() => hoop.buildWrite(id, "b6", "Compute is half.", undefined, undefined, { block: mine, note }), /isn't text you wrote/);
  // The section a write replaces can't hold the other place.
  writeSaved(hoop, id, "b5", "Rightsize first.");
  const options = hoop.builds.read(id).blocks.find((b) => b.text === "Rightsize first.")!.id;
  assert.throws(() => hoop.buildWrite(id, "b5", "Buy reserved.", undefined, undefined, { block: options, note }), /text this write replaces/);
  assert.equal(hoop.builds.read(id).drafts, undefined, "a refused write leaves nothing");
  assert.equal(hoop.builds.read(id).notes, undefined);
});

test("a contradiction note goes with Claude's draft, stays when it is saved, goes when it is discarded, and the person resolves it", () => {
  const { hoop, id } = started();
  writeSaved(hoop, id, "b3", "Compute is 70% of it.");
  const mine = hoop.builds.read(id).blocks.find((b) => b.text === "Compute is 70% of it.")!.id;
  // Claude names its own blocks, so every request carries them.
  hoop.buildChange(id, { op: "generate", block: "b6" });
  const [task] = hoop.takeRequests(id);
  assert.deepEqual(
    task!.claude_blocks!.find((b) => b.block === mine),
    { block: mine, heading: "## Where the money goes", starts: "Compute is 70% of it." },
  );
  const out = run(hoop, "build_write", { review_id: id, section: "b6", markdown: "Compute is half.", contradicts: { block: mine, note: "Costs says 70%" } });
  assert.equal((out as { draft: boolean }).draft, true);
  const [n] = hoop.builds.read(id).notes!;
  assert.deepEqual([n!.section, n!.block, n!.note, n!.status], ["b6", mine, "Costs says 70%", "open"]);
  hoop.buildChange(id, { op: "discard_draft", block: "b6" });
  assert.equal(hoop.builds.read(id).notes, undefined, "discarding the draft drops its note");
  hoop.buildWrite(id, "b6", "Compute is half.", undefined, undefined, { block: mine, note: "Costs says 70%" });
  hoop.buildChange(id, { op: "save_draft", block: "b6" });
  const kept = hoop.builds.read(id).notes!;
  assert.equal(kept.length, 1);
  const resolved = hoop.buildChange(id, { op: "resolve_note", note: kept[0]!.id });
  assert.equal(resolved.notes![0]!.status, "resolved");
  assert.equal(resolved.steps.at(-1)!.what, "resolved Claude's note on a contradiction");
  const again = hoop.buildChange(id, { op: "resolve_note", note: kept[0]!.id });
  assert.equal(again.version, resolved.version, "resolving it again changes nothing");
  assert.throws(() => hoop.buildChange(id, { op: "resolve_note", note: "n9" }), /no note n9/);
});

test("a rewrite's contradiction note sits with the section it is in, and the command line takes one", () => {
  const { hoop, id } = started();
  writeSaved(hoop, id, "b3", "Compute is 70% of it.");
  writeSaved(hoop, id, "b6", "Compute is a third.");
  const [costs, risks] = ["Compute is 70% of it.", "Compute is a third."].map((t) => hoop.builds.read(id).blocks.find((b) => b.text === t)!.id);
  hoop.buildChange(id, { op: "rewrite", block: risks! });
  hoop.takeRequests(id);
  assert.throws(() => hoop.buildWriteBlock(id, risks!, "Half.", undefined, undefined, { block: risks!, note: "x" }), /text this write replaces/);
  hoop.buildWriteBlock(id, risks!, "Compute is half.", undefined, undefined, { block: costs!, note: "Costs says 70%" });
  const [n] = hoop.builds.read(id).notes!;
  const first = hoop.builds.read(id).blocks.find((b) => b.text === "Compute is half.")!.id;
  assert.deepEqual([n!.section, n!.with, n!.block], ["b6", first, costs]);
  // Discarding the rewrite drops the note.
  hoop.buildChange(id, { op: "undo_change", block: first });
  assert.equal(hoop.builds.read(id).notes, undefined);
  const cli = OPS.find((o) => o.name === "build_write")!.cli!;
  assert.deepEqual(cli.parse({ pos: [id, "b6", "/dev/null"], flags: { contradicts: costs!, note: "Costs says 70%" }, lists: {} } as never), {
    review_id: id,
    section: "b6",
    contradicts: { block: costs, note: "Costs says 70%" },
    markdown: "",
  });
});

test("on the page, a section's versions step from the keyboard, show what changed, and Save puts one back", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    writeSaved(hoop, id, "b3", "Compute is **most** of it.");
    const mine = hoop.builds.read(id).blocks.find((b) => b.text === "Compute is **most** of it.")!.id;
    hoop.buildChange(id, { op: "edit", block: mine, text: "Compute is 70% of it." });
    await page.goto(`${base}/r/${id}`);
    const toggle = page.getByRole("button", { name: "Versions 2 of Heading 1 “Where the money goes”" });
    await toggle.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("group", { name: "Versions of Heading 1 “Where the money goes”" });
    await panel.waitFor();
    // The newest version is picked, with focus on it, and the change view shows what changed since.
    const generated = panel.getByRole("radio", { name: /^Claude generated · / });
    assert.ok(await hasFocus(generated));
    assert.ok(await generated.isChecked());
    assert.match(await panel.locator(".bdiff-row.del").innerText(), /^−\s+Only in this version:\s+Compute is most of it\.$/);
    assert.match(await panel.locator(".bdiff-row.add").innerText(), /^\+\s+New since this version:\s+Compute is 70% of it\.$/);
    // The arrow key steps to the next one, the text the build started with.
    await page.keyboard.press("ArrowDown");
    const start = panel.getByRole("radio", { name: /^Earlier text · replaced / });
    await page.waitForFunction(() => document.activeElement?.closest(".bver")?.textContent?.startsWith("Earlier text"));
    assert.ok(await start.isChecked());
    assert.match(await panel.locator(".bdiff-row.del").innerText(), /Old guess\./);
    // Save puts it back; focus goes to the versions' button, which now counts the replaced text.
    await page.keyboard.press("Tab");
    assert.ok(await hasFocus(panel.getByRole("button", { name: /^Save this version of Heading 1 “Where the money goes”: Earlier text/ })));
    await page.keyboard.press("Enter");
    await panel.waitFor({ state: "detached" });
    assert.equal(hoop.markdownOf(id), OUTLINE);
    assert.ok(await hasFocus(toggle));
    await page.locator("#page-live", { hasText: "The text it replaced is now the newest version." }).waitFor({ state: "attached" });
    // Escape closes the versions, with focus back on their button.
    await page.keyboard.press("Enter");
    await panel.waitFor();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    assert.ok(await hasFocus(toggle));
  }),
);

test("on the page, Claude's note names both places, links to the other, and Resolve takes it away", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    writeSaved(hoop, id, "b3", "Compute is 70% of it.");
    const costs = hoop.builds.read(id).blocks.find((b) => b.text === "Compute is 70% of it.")!.id;
    hoop.buildWrite(id, "b6", "Compute is half.", undefined, undefined, { block: costs, note: "This says half; Where the money goes says 70%." });
    await page.goto(`${base}/r/${id}`);
    const note = page.getByRole("group", { name: "Claude's note 1 on Heading 1 “Risks”" });
    await note.waitFor();
    assert.match(
      await note.innerText(),
      /^Claude\s+\S+\s+This says half; Where the money goes says 70%\.\s+Where: Claude's draft for Heading 1 “Risks”, and Paragraph 4 under “Where the money goes”\./,
    );
    // The link jumps to the other place, opening its section when it is folded.
    await page.getByRole("button", { name: "Collapse Heading 1 “Where the money goes”" }).click();
    await note.getByRole("link", { name: "Paragraph 4 under “Where the money goes”" }).click();
    await page.waitForFunction((b) => document.activeElement?.id === `bk-${b}`, costs);
    await page.locator(`#bk-${costs}.jumped`).waitFor();
    await note.getByRole("button", { name: "Resolve Claude's note 1 on Heading 1 “Risks”" }).click();
    await note.waitFor({ state: "detached" });
    assert.equal(hoop.builds.read(id).notes![0]!.status, "resolved");
    assert.ok(await hasFocus(page.getByRole("button", { name: "Edit Heading 1 “Risks”" })));
  }),
);
