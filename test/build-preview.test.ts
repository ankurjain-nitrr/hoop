import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { OPS } from "../src/ops.js";
import { Store } from "../src/store.js";
import { WRITES } from "../src/writes.js";
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
  assert.throws(() => hoop.buildWriteBlock(id, "b6", "- Servers: 40"), /the person resolved this comment/);
  // Resolving again changes nothing.
  const version = hoop.builds.read(id).version;
  assert.equal(hoop.buildChange(id, { op: "resolve", thread: costs!.thread! }).version, version);
});

test("Claude replies on any open comment, taken or not; a reply never changes the text", () => {
  const { hoop, id } = written();
  hoop.buildChange(id, { op: "comment", block: "b5", comment: "Is this monthly?" });
  const before = hoop.markdownOf(id);
  const thread = hoop.builds.read(id).threads![0]!.id;
  hoop.reply(thread, "Yes, monthly.");
  const build = hoop.builds.read(id);
  assert.equal(hoop.markdownOf(id), before);
  assert.deepEqual([build.requests!.at(-1)!.status, build.threads![0]!.replies.length], ["written", 1], "the reply answers the comment");
  assert.deepEqual(hoop.takeRequests(id), []);
});

test("with two requests taken on one block, a write names the one it answers, and only that one closes", () => {
  const { hoop, id } = written();
  hoop.buildChange(id, { op: "rewrite", block: "b5", note: "shorter" });
  hoop.buildChange(id, { op: "comment", block: "b5", comment: "friendlier" });
  const [rewrite, revise] = hoop.takeRequests(id);
  assert.throws(
    () => hoop.buildWriteBlock(id, "b5", "Hi."),
    new RegExp(`requests ${rewrite!.request} and ${revise!.request} are both taken on block b5: pass request`),
  );
  assert.throws(
    () => run(hoop, "build_write", { review_id: id, block: "b5", request: "g99", markdown: "Hi." }),
    /request g99 isn't a rewrite or comment on block b5/,
  );
  run(hoop, "build_write", { review_id: id, block: "b5", request: revise!.request, markdown: "Hi there, most of it." });
  const requests = hoop.builds.read(id).requests!;
  assert.deepEqual(
    [requests.find((r) => r.id === revise!.request)!.status, requests.find((r) => r.id === rewrite!.request)!.status],
    ["written", "queued"],
    "the other one waits again, with the new text",
  );
});

test("a comment keeps which occurrence of its words it is on, and turns outdated when a rewrite drops them", () => {
  const { hoop, id } = written();
  hoop.buildChange(id, { op: "comment", block: "b6", selection: "Storage", occurrence: 0, comment: "which kind?" });
  const [task] = hoop.takeRequests(id);
  assert.deepEqual([task!.selection, task!.occurrence], ["Storage", 0]);
  hoop.buildWriteBlock(id, "b6", "- Servers\n- Disks");
  assert.equal(hoop.builds.read(id).threads![0]!.outdated, true);
  assert.throws(() => hoop.buildChange(id, { op: "comment", block: "b5", comment: "x".repeat(2001) }), /at most 2000 characters/);
  assert.throws(() => hoop.buildChange(id, { op: "comment", block: "b5", selection: "y".repeat(501), comment: "x" }), /at most 500 characters/);
  assert.throws(() => hoop.buildChange(id, { op: "comment", block: "b5", selection: "most", occurrence: -1, comment: "x" }), /whole number/);
});

test("a comment on a removed block stays open to resolve; Claude can't reply there; Finish waits for every comment", () => {
  const { hoop, id } = written();
  hoop.buildChange(id, { op: "comment", block: "b6", comment: "add costs" });
  const thread = hoop.builds.read(id).threads![0]!.id;
  hoop.buildChange(id, { op: "remove", block: "b6" });
  assert.throws(() => hoop.reply(thread, "Done."), /the block comment .* was on is gone/);
  assert.throws(() => hoop.finishBuild(id), /Resolve 1 open comment first/);
  hoop.buildChange(id, { op: "resolve", thread });
  assert.equal(hoop.finishBuild(id).outcome, "revised");
});

test("a reply on a build thread is queued under its review", () => {
  assert.equal(WRITES.op!.key({ name: "reply", input: { thread: "bt_abc123_4", body: "x" } }), "rv_abc123");
  assert.equal(WRITES.op!.key({ name: "reply", input: { thread: "th_abc123_4", body: "x" } }), "rv_abc123");
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

test("Preview all never drops a draft whose block Claude replaced meanwhile, and says why", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    hoop.buildWrite(id, "b3", "Compute is most of it.\n\n- Servers\n- Storage");
    await page.goto(`${base}/r/${id}`);
    await page.getByRole("button", { name: "Edit all" }).click();
    await page.getByLabel("Text of List 5").fill("- Servers\n- Storage\n- My egress note");
    await page.getByLabel("Text of Paragraph 2").fill("What this helps decide, today.");
    // While the editors are open, Claude writes "Where the money goes" again, replacing the list.
    hoop.buildChange(id, { op: "generate", block: "b3" });
    hoop.takeRequests(id);
    hoop.buildWrite(id, "b3", "All new text.");
    await page.getByRole("button", { name: "Preview all" }).click();
    await page.locator(".berrs li", { hasText: "A block you were editing is gone" }).waitFor();
    const kept = page.getByLabel("Your unsaved text 1, for a block that is gone");
    assert.equal(await kept.inputValue(), "- Servers\n- Storage\n- My egress note", "the draft is still there, word for word");
    assert.match(hoop.markdownOf(id), /What this helps decide, today\./, "the other edit saved");
    // Escape doesn't throw it away; Discard does.
    await kept.press("Escape");
    assert.equal(await kept.count(), 1);
    await page.getByRole("button", { name: "Discard your unsaved text 1" }).click();
    await kept.waitFor({ state: "detached" });
  }),
);

test("Finish waits for unsaved edits, Claude's changes and open comments, pointing at each", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    hoop.buildWrite(id, "b3", "Compute is most of it.");
    hoop.buildChange(id, { op: "comment", block: "b5", comment: "Is this monthly?" });
    await page.goto(`${base}/r/${id}`);
    await page.getByRole("button", { name: "Edit Paragraph 2" }).click();
    await page.getByLabel("Text of Paragraph 2").fill("Changed, not saved.");
    const finish = page.getByRole("button", { name: "Finish and review" });
    await finish.click();
    await page.locator("#finishErr", { hasText: "Save or cancel your open edits first" }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "bt-b2", "focus goes to the unsaved text");
    await page.getByRole("button", { name: "Cancel editing Paragraph 2" }).click();
    await finish.click();
    await page.locator("#finishErr", { hasText: "Resolve 1 open comment first" }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Resolve Comment 1 on Paragraph 4");
    assert.equal(hoop.store.meta(id).build, "open");
  }),
);

test("a comment on a removed block shows under On removed blocks, with Resolve", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    hoop.buildWrite(id, "b3", "Compute is most of it.");
    hoop.buildChange(id, { op: "comment", block: "b5", comment: "Is this monthly?" });
    hoop.buildChange(id, { op: "remove", block: "b5" });
    await page.goto(`${base}/r/${id}`);
    const removed = page.getByRole("region", { name: "On removed blocks" });
    await removed.getByText("Is this monthly?").waitFor();
    await removed.getByRole("button", { name: "Resolve Comment 1 on a removed block" }).click();
    await removed.waitFor({ state: "detached" });
    assert.equal(hoop.builds.read(id).threads![0]!.status, "resolved");
  }),
);

test("the comment form names what it is on for a screen reader, and a refused comment keeps its text", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    hoop.buildWrite(id, "b3", "Compute is most of it.");
    await page.goto(`${base}/r/${id}`);
    await page.getByRole("button", { name: "Comment on Paragraph 4" }).click();
    const box = page.getByLabel("Comment on Paragraph 4 for Claude");
    assert.match((await box.getAttribute("aria-describedby")) ?? "", /bco-b5/);
    assert.equal(await page.locator("#bco-b5").innerText(), "On the whole block");
    // The block is removed elsewhere before the comment is sent: the comment is refused, its text kept.
    hoop.buildChange(id, { op: "remove", block: "b5" });
    await box.fill("Is this monthly?");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.locator("#bce-b5", { hasText: "no block b5" }).waitFor();
    assert.equal(await box.inputValue(), "Is this monthly?");
  }),
);
