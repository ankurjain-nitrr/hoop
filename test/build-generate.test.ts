import { test } from "node:test";
import assert from "node:assert/strict";
import { joinBlocks } from "../src/build.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { parseMarkdown } from "../src/markdown.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

const OUTLINE = "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n\nOld guess.\n\n## Options\n";
const run = (hoop: Hoop, name: string, input: Record<string, unknown>) => OPS.find((o) => o.name === name)!.run(hoop, input, { actor: "claude" });

function started() {
  const hoop = new Hoop(new Store(tempHome()));
  return { hoop, id: hoop.startBuild(OUTLINE).review_id };
}

test("Generate queues a request; Claude's session takes it with its section and note, and writes the section", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "generate", block: "b3", note: " focus on compute " });
  assert.deepEqual(
    hoop.builds.read(id).requests?.map((r) => [r.block, r.note, r.status]),
    [["b3", "focus on compute", "queued"]],
  );
  const [task, ...rest] = hoop.takeRequests(id);
  assert.equal(rest.length, 0);
  assert.deepEqual(
    { ...task, markdown: undefined },
    {
      request: "g1",
      kind: "write",
      section: "b3",
      heading: "## Where the money goes",
      note: "focus on compute",
      section_markdown: "Old guess.",
      markdown: undefined,
    },
  );
  assert.equal(task!.markdown, OUTLINE);
  assert.deepEqual(hoop.takeRequests(id), [], "a request is taken once");
  assert.equal(hoop.builds.read(id).requests![0]!.status, "taken");

  // Claude may repeat the heading; it is dropped. Subsections below the section's level are its own.
  const build = hoop.buildWrite(id, "b3", "## Where the money goes\n\nCompute is most of it.\n\n### Compute\n\n- Servers\n- GPUs");
  assert.equal(
    joinBlocks(build),
    "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n\nCompute is most of it.\n\n### Compute\n\n- Servers\n- GPUs\n\n## Options\n",
  );
  const written = build.blocks.slice(3, 6);
  assert.ok(written.every((b) => b.by === "claude" && b.generated));
  assert.equal(build.requests![0]!.status, "written");
  assert.deepEqual(Object.keys(build.undo!), ["b3"]);
});

test("Undo puts back the section as it was before Claude wrote it, and regenerating writes it again", () => {
  const { hoop, id } = started();
  hoop.buildWrite(id, "b3", "First try.");
  let build = hoop.buildWrite(id, "b3", "Second try.");
  assert.match(joinBlocks(build), /Second try\./);
  build = hoop.buildChange(id, { op: "undo", block: "b3" });
  assert.match(joinBlocks(build), /First try\./, "Undo goes back one write");
  assert.equal(build.undo?.b3, undefined);
  assert.throws(() => hoop.buildChange(id, { op: "undo", block: "b3" }), /nothing of Claude's to undo/);
});

test("a person's edit to Claude's text makes it theirs", () => {
  const { hoop, id } = started();
  const block = hoop.buildWrite(id, "b3", "Claude's words.").blocks[3]!;
  const edited = hoop.buildChange(id, { op: "edit", block: block.id, text: "My words." }).blocks[3]!;
  assert.deepEqual([edited.by, edited.generated], ["person", undefined]);
});

test("Claude writes only sections, never the outline, and only in its own build", () => {
  const { hoop, id } = started();
  assert.throws(() => hoop.buildWrite(id, "b1", "Text"), /not a section heading/);
  assert.throws(() => hoop.buildWrite(id, "b2", "Text"), /not a section heading/);
  assert.throws(() => hoop.buildWrite(id, "b3", "Text\n\n## Another section"), /the person owns the outline/);
  assert.throws(() => hoop.buildWrite(id, "b3", "## Where the money goes\n"), /needs text/);
  assert.throws(() => hoop.buildChange(id, { op: "generate", block: "b1" }), /generate on its heading/);
  const other = new Hoop(hoop.store, "other-session-1111");
  assert.throws(() => other.buildWrite(id, "b3", "Text"), /Only the session that submitted/);
  assert.throws(() => other.takeRequests(id), /Only the session that submitted/);
  const review = hoop.submit(parseMarkdown("# A review\n\nText.\n"));
  assert.throws(() => hoop.buildWrite(review.review_id, "b3", "Text"), /not a document being built/);
});

test("a newer Generate replaces a request Claude hasn't taken", () => {
  const { hoop, id } = started();
  hoop.buildChange(id, { op: "generate", block: "b3", note: "one" });
  hoop.buildChange(id, { op: "generate", block: "b3", note: "two" });
  hoop.buildChange(id, { op: "generate", block: "b5" });
  assert.deepEqual(
    hoop.takeRequests(id).map((t) => [t.section, t.note]),
    [
      ["b3", "two"],
      ["b5", undefined],
    ],
  );
});

test("hoop_build_wait returns requests, pending with again, or finished; hoop_build_write writes", async () => {
  const { hoop, id } = started();
  const pending = (await run(hoop, "build_wait", { review_id: id, seconds: 1 })) as { status: string; again: boolean };
  assert.deepEqual([pending.status, pending.again], ["pending", true]);
  setTimeout(() => hoop.buildChange(id, { op: "generate", block: "b5" }), 300);
  const got = (await run(hoop, "build_wait", { review_id: id, seconds: 60 })) as { status: string; requests: { section: string }[] };
  assert.equal(got.status, "requests");
  assert.equal(got.requests[0]!.section, "b5");
  const wrote = run(hoop, "build_write", { review_id: id, section: "b5", markdown: "Two options." }) as { markdown: string };
  assert.match(wrote.markdown, /## Options\n\nTwo options\.\n$/);
  hoop.store.update(id, { build: undefined });
  const done = (await run(hoop, "build_wait", { review_id: id, seconds: 1 })) as { status: string };
  assert.equal(done.status, "finished");
});

test("on the page, Generate with a note queues the section, then shows Claude writing and its text, which Undo removes", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    await page.addInitScript(() => Object.assign(window, { HOOP_BUILD_MS: 200 }));
    await page.goto(`${base}/r/${id}`);
    await page.getByRole("button", { name: "Generate Heading 1 “Options”" }).click();
    const note = page.getByLabel("Note for Claude on Heading 1 “Options” (optional)");
    assert.equal(await note.evaluate((el) => el === document.activeElement), true, "the note field has focus");
    await note.fill("two at most");
    await page.keyboard.press("Enter");
    await page.locator(".bstatus", { hasText: "Queued" }).waitFor();
    assert.equal(hoop.builds.read(id).requests![0]!.note, "two at most");

    hoop.takeRequests(id);
    await page.locator(".bstatus", { hasText: "Claude is writing" }).waitFor();
    hoop.buildWrite(id, "b5", "Rightsize the servers.");
    await page.locator(".bblock.generated", { hasText: "Rightsize the servers." }).waitFor();
    assert.equal(await page.locator(".bstatus").count(), 0);
    await page.getByRole("button", { name: "Undo Claude's text in Heading 1 “Options”" }).click();
    await page.locator(".bblock.generated").waitFor({ state: "detached" });
    assert.equal(hoop.markdownOf(id), OUTLINE);
    // Escape closes the note without asking.
    await page.getByRole("button", { name: "Generate Heading 1 “Options”" }).click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".bgen").count(), 0);
    assert.equal(hoop.builds.read(id).requests!.length, 1);
  }),
);
