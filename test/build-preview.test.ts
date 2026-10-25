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

test("a comment reaches Claude with the selection; Claude rewrites the block or replies in the thread", async () => {
  const { hoop, id } = written();
  hoop.buildChange(id, { op: "comment", block: "b6", selection: "  Servers ", comment: "Is this all of it?" });
  hoop.buildChange(id, { op: "comment", block: "b5", comment: "make this friendlier" });
  const tasks = hoop.takeRequests(id);
  assert.deepEqual(
    tasks.map((t) => [t.kind, t.block, t.selection, t.comment, t.thread, t.note]),
    [
      ["revise", "b6", "Servers", "Is this all of it?", `bt_${id.slice(3)}_1`, undefined],
      ["revise", "b5", undefined, "make this friendlier", `bt_${id.slice(3)}_2`, undefined],
    ],
  );
  // A question gets a reply in its thread, through hoop_reply, which answers its request.
  const reply = (await run(hoop, "reply", { thread: tasks[0]!.thread, body: "Also egress." })) as { review_id: string; author: string };
  assert.deepEqual([reply.review_id, reply.author], [id, "claude"]);
  // A change request gets the block rewritten, which waits; the thread follows the block.
  run(hoop, "build_write", { review_id: id, block: "b5", markdown: "Most of it is compute." });
  let build = hoop.builds.read(id);
  assert.deepEqual(
    build.threads!.map((t) => [t.block, t.replies.map((r) => r.body)]),
    [
      ["b6", ["Also egress."]],
      ["b7", []],
    ],
  );
  assert.deepEqual(
    build.requests!.map((r) => r.status),
    ["written", "written"],
  );
  assert.throws(() => hoop.finishBuild(id), /Accept or undo Claude's 1 waiting change first/);
  // Undo takes the thread back to the block as it was; Resolve closes the thread.
  hoop.buildChange(id, { op: "undo_change", block: "b7" });
  assert.equal(hoop.builds.read(id).threads![1]!.block, "b5");
  hoop.buildChange(id, { op: "resolve", thread: tasks[0]!.thread! });
  build = hoop.builds.read(id);
  assert.equal(build.threads![0]!.status, "resolved");
  assert.equal(build.steps.at(-1)!.what, "resolved a comment");
});

test("a comment follows the rewrite rules: the person's edit wins, only the taken request answers, and a write needs it", () => {
  const { hoop, id } = written();
  hoop.buildChange(id, { op: "comment", block: "b5", comment: "shorter" });
  assert.throws(() => hoop.buildWriteBlock(id, "b5", "Short."), /no rewrite request open/, "a write needs the request taken");
  const thread = hoop.builds.read(id).threads![0]!.id;
  assert.throws(() => hoop.reply(thread, "Sure."), /take comment .* with hoop_build_wait before replying/);
  const [first] = hoop.takeRequests(id);
  hoop.buildChange(id, { op: "comment", block: "b5", comment: "and friendlier" });
  hoop.buildChange(id, { op: "edit", block: "b5", text: "My own words." });
  assert.throws(() => hoop.buildWriteBlock(id, "b5", "Claude's."), /the person changed block b5 after you took request g\d+/);
  const requests = hoop.builds.read(id).requests!;
  assert.deepEqual(
    requests.map((r) => [r.id === first!.request, r.status, r.overtaken]),
    [
      [true, "written", true],
      [false, "written", true],
    ],
    "both close: the person's text stays",
  );
  // A resolved comment's request closes too, and Claude can't reply to it.
  hoop.buildChange(id, { op: "comment", block: "b6", comment: "add costs" });
  const [costs] = hoop.takeRequests(id);
  hoop.buildChange(id, { op: "resolve", thread: costs!.thread! });
  assert.throws(() => hoop.reply(costs!.thread!, "Done."), /the person resolved comment/);
  assert.throws(() => hoop.buildWriteBlock(id, "b6", "- Servers: 40"), /the person changed block b6/);
});

test("comments are refused where they don't fit", () => {
  const { hoop, id } = written();
  assert.throws(() => hoop.buildChange(id, { op: "comment", block: "b3", comment: "x" }), /a heading takes Generate/);
  assert.throws(() => hoop.buildChange(id, { op: "comment", block: "b5", comment: "  " }), /a comment needs text/);
  assert.throws(() => hoop.buildChange(id, { op: "resolve", thread: "bt_x_9" }), /no comment bt_x_9/);
  assert.throws(() => hoop.reply(`bt_${id.slice(3)}_9`, "hi"), /no comment/);
});

test("on the page: Preview by default, Edit all and Preview all, and comments Claude acts on", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    hoop.buildWrite(id, "b3", "Compute is **most** of it.\n\n- Servers\n- Storage");
    await page.goto(`${base}/r/${id}`);
    // Preview is the default: every block shows formatted, none in an editor.
    await page.locator(".bpara strong", { hasText: "most" }).waitFor();
    assert.equal(await page.locator(".bblock.editing").count(), 0);

    // Edit all and Preview all, from the keyboard; Preview all saves what changed and keeps the rest.
    await page.getByRole("button", { name: "Edit all" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Preview all" }).waitFor();
    assert.equal(await page.locator(".bblock.editing").count(), 6);
    await page.getByLabel("Text of List 5").fill("- Servers\n- Storage\n- Egress");
    await page.getByRole("button", { name: "Preview all" }).press("Enter");
    await page.getByRole("button", { name: "Edit all" }).waitFor();
    assert.equal(await page.locator(".bblock.editing").count(), 0);
    assert.match(hoop.markdownOf(id), /- Storage\n- Egress\n/, "Preview all saved the changed block");
    assert.equal(hoop.builds.read(id).steps.filter((s) => s.what === "edited a block").length, 1, "and only that one");

    // One block's Edit and Preview.
    await page.getByRole("button", { name: "Edit Paragraph 2" }).click();
    await page.getByLabel("Text of Paragraph 2").fill("What this helps **decide**.");
    await page.getByRole("button", { name: "Preview Paragraph 2" }).click();
    await page.locator(".bpara strong", { hasText: "decide" }).waitFor();

    // Selected words, then Comment: Claude gets them with the comment, and replies in the thread.
    await page.locator('[data-block="b5"] .bpara').evaluate((p) => {
      const range = document.createRange();
      range.selectNodeContents(p.querySelector("strong")!);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    });
    await page.getByRole("button", { name: "Comment on Paragraph 4" }).click();
    await page.locator(".bon", { hasText: "On “most”" }).waitFor();
    await page.getByLabel("Comment on Paragraph 4 for Claude").fill("How much is most?");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.locator(".bthread .bquote", { hasText: "most" }).waitFor();
    await page.locator('[data-block="b5"] [role="status"]', { hasText: "Queued: Claude reads your comment" }).waitFor();
    const [asked] = hoop.takeRequests(id);
    assert.deepEqual([asked!.kind, asked!.selection, asked!.comment], ["revise", "most", "How much is most?"]);
    hoop.reply(asked!.thread!, "About 70%.");
    await page.locator(".bthread .breply", { hasText: "About 70%." }).waitFor();

    // A comment on the whole block asking for a change gets a rewrite, which the person accepts.
    await page.getByRole("button", { name: "Comment on List 5" }).click();
    await page.locator(".bon", { hasText: "On the whole block" }).waitFor();
    await page.getByLabel("Comment on List 5 for Claude").fill("add costs");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.locator('.bthread[aria-label="Comment 1 on List 5"]').waitFor();
    const [change] = hoop.takeRequests(id);
    hoop.buildWriteBlock(id, change!.block!, "- Servers: 40\n- Storage: 20");
    await page.getByRole("button", { name: "Accept Claude's change to List 5" }).click();
    await page.locator(".bchange").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Resolve Comment 1 on Paragraph 4" }).click();
    await page.locator(".bthread .breply").waitFor({ state: "detached" });
    assert.match(hoop.markdownOf(id), /- Servers: 40\n- Storage: 20\n/);
  }),
);
