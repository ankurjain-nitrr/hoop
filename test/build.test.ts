import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { joinBlocks, kindOf, splitBlocks } from "../src/build.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { reviewStatus } from "../src/rules.js";
import { BROWSER_SKIP, example, tempHome, withBrowser } from "./helpers.js";
import type { AddressInfo } from "node:net";
import { createWebServer } from "../src/web.js";

const DOCS = new URL("./fixtures/docs/", import.meta.url).pathname;
const OUTLINE = "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n\n## Options\n";
const exportOp = OPS.find((o) => o.name === "export")!;

const newHoop = () => new Hoop(new Store(tempHome()));

async function withServer(fn: (base: string, hoop: Hoop) => Promise<void>) {
  const hoop = newHoop();
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, hoop);
  } finally {
    server.close();
  }
}

test("markdown splits into blocks and joins back byte for byte", () => {
  const samples = [
    ...readdirSync(DOCS).map((f) => readFileSync(join(DOCS, f), "utf8")),
    OUTLINE,
    "# T\nText right under the heading\n\n\n\nafter three blank lines   \n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n- a\n- b",
    "\n\n# Leading blank lines\n\nno newline at the end",
    "",
    "```\nan unclosed fence\n\nstill code",
  ];
  for (const md of samples) assert.equal(joinBlocks(splitBlocks(md)), md);
  const { blocks } = splitBlocks("# T\nText\n\n```js\na\n\nb\n```\n");
  assert.deepEqual(
    blocks.map((b) => [b.kind, b.text]),
    [
      ["h1", "# T"],
      ["paragraph", "Text"],
      ["code", "```js\na\n\nb\n```"],
    ],
    "a heading is its own block, and a fence keeps its blank lines",
  );
});

test("each block has the kind its first lines give it", () => {
  assert.equal(kindOf("# A"), "h1");
  assert.equal(kindOf("## A"), "h2");
  assert.equal(kindOf("#### A"), "h3");
  assert.equal(kindOf("- a\n- b"), "list");
  assert.equal(kindOf("1. a"), "list");
  assert.equal(kindOf("| a | b |\n|---|---|"), "table");
  assert.equal(kindOf("```ts\nx\n```"), "code");
  assert.equal(kindOf("```mermaid\nflowchart LR\n```"), "diagram");
  assert.equal(kindOf("Some | pipe"), "paragraph");
});

test("Claude starts a build: an open review owned by the session, building, that exports its markdown exactly", () => {
  const hoop = newHoop();
  const started = hoop.startBuild(OUTLINE);
  const meta = hoop.store.meta(started.review_id);
  assert.equal(meta.build, "open");
  assert.equal(meta.title, "Cutting cloud cost");
  assert.equal(meta.owner?.session, hoop.session);
  assert.deepEqual(reviewStatus(hoop.store, meta), { status_key: "building" });
  assert.match(started.url, new RegExp(`/r/${started.review_id}$`));
  const out = exportOp.run(hoop, { review_id: started.review_id }, { actor: "claude" }) as { markdown: string; building: boolean };
  assert.equal(out.building, true);
  assert.equal(out.markdown, OUTLINE);
  assert.deepEqual(
    hoop.builds.read(started.review_id).blocks.map((b) => [b.id, b.kind, b.by]),
    [
      ["b1", "h1", "claude"],
      ["b2", "paragraph", "claude"],
      ["b3", "h2", "claude"],
      ["b4", "h2", "claude"],
    ],
  );
});

test("a build takes no review actions until it is finished", () => {
  const hoop = newHoop();
  const { review_id } = hoop.startBuild(OUTLINE);
  assert.throws(() => hoop.submit({ ...example(), review_id }), /being built on the page/);
  assert.throws(() => hoop.review(review_id, { verdict: "approved", reviewer: "p" }), /being built on the page/);
  const other = hoop.submit(example()).review_id;
  assert.throws(() => hoop.buildChange(other, { op: "remove", block: "b1" }), /not a document being built/);
});

test("the person adds, edits, moves and removes blocks, and each change is a step with its own snapshot", () => {
  const hoop = newHoop();
  const { review_id: id } = hoop.startBuild(OUTLINE);
  hoop.buildChange(id, { op: "add", kind: "paragraph", after: "b3" });
  let build = hoop.buildChange(id, { op: "edit", block: "b5", text: "Compute is most of it." });
  assert.equal(
    joinBlocks(build),
    "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n\nCompute is most of it.\n\n## Options\n",
  );
  // Text with a blank line in it becomes two blocks; the first keeps the ID.
  build = hoop.buildChange(id, { op: "edit", block: "b5", text: "Compute is most of it.\n\n- Servers\n- Storage" });
  assert.deepEqual(
    build.blocks.map((b) => [b.id, b.kind]),
    [
      ["b1", "h1"],
      ["b2", "paragraph"],
      ["b3", "h2"],
      ["b5", "paragraph"],
      ["b6", "list"],
      ["b4", "h2"],
    ],
  );
  // A heading moves with its section.
  build = hoop.buildChange(id, { op: "move", block: "b4", to: "up" });
  assert.deepEqual(
    build.blocks.map((b) => b.id),
    ["b1", "b2", "b4", "b3", "b5", "b6"],
  );
  build = hoop.buildChange(id, { op: "remove", block: "b2" });
  assert.equal(joinBlocks(build), "# Cutting cloud cost\n\n## Options\n\n## Where the money goes\n\nCompute is most of it.\n\n- Servers\n- Storage\n");
  assert.equal(hoop.store.meta(id).title, "Cutting cloud cost");
  hoop.buildChange(id, { op: "edit", block: "b1", text: "# Cutting cloud spend" });
  assert.equal(hoop.store.meta(id).title, "Cutting cloud spend", "the title follows the # block");

  build = hoop.builds.read(id);
  assert.deepEqual(
    build.steps.map((s) => [s.n, s.by, s.what]),
    [
      [1, "claude", "started the build"],
      [2, "person", "added a paragraph"],
      [3, "person", "edited a block"],
      [4, "person", "edited a block"],
      [5, "person", 'moved the heading "Options" before "Where the money goes"'],
      [6, "person", "removed a block"],
      [7, "person", "edited a block"],
    ],
  );
  // Every step can be read back, and each block's text is stored once.
  assert.equal(joinBlocks(hoop.builds.at(id, 1)), OUTLINE);
  assert.equal(joinBlocks(hoop.builds.at(id, 7)), joinBlocks(build));
  const texts = readdirSync(join(hoop.store.dirOf(id), "blocks"));
  const distinct = new Set((Array.from({ length: 7 }, (_, n) => hoop.builds.at(id, n + 1).blocks.map((b) => b.text)) as string[][]).flat());
  assert.equal(texts.length, distinct.size);
});

test("a change the build can't take is refused with the reason", () => {
  const hoop = newHoop();
  const { review_id: id } = hoop.startBuild(OUTLINE);
  assert.throws(() => hoop.buildChange(id, { op: "edit", block: "b1", text: "  \n" }), /needs text; remove it instead/);
  assert.throws(() => hoop.buildChange(id, { op: "remove", block: "b99" }), /no block b99/);
  assert.throws(() => hoop.buildChange(id, { op: "add", kind: "poem" as never }), /a block is one of/);
  assert.throws(() => hoop.buildChange(id, { op: "move", block: "b1", to: "left" } as never), /up" or "down/);
  assert.throws(() => hoop.buildChange(id, { op: "rename" } as never), /expected op/);
  // Moving the first block up changes nothing.
  assert.equal(hoop.buildChange(id, { op: "move", block: "b1", to: "up" }).version, 1);
});

test("the pages API serves a build and takes the person's changes", () =>
  withServer(async (base, hoop) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    const view = await (await fetch(`${base}/api/reviews/${id}`)).json();
    assert.equal(view.status_key, "building");
    assert.equal(view.build.markdown, OUTLINE);
    const post = (body: unknown) =>
      fetch(`${base}/api/reviews/${id}/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const added = await post({ op: "add", kind: "list", after: "b4" });
    assert.equal(added.status, 201);
    assert.equal((await added.json()).markdown, `${OUTLINE}\n- First point\n- Second point\n`);
    assert.equal((await post({ op: "edit", block: "b9", text: "x" })).status, 400);
    const now = await (await fetch(`${base}/api/reviews/${id}/build`)).json();
    assert.equal(now.version, 2);
    assert.equal((await fetch(`${base}/build.js`)).status, 200);
    const list = await (await fetch(`${base}/api/reviews`)).json();
    assert.equal(list[0].status_key, "building");
  }));

test("hoop_build starts a build from the outline", () => {
  const hoop = newHoop();
  const op = OPS.find((o) => o.name === "build")!;
  const result = op.run(hoop, { markdown: OUTLINE }, { actor: "claude" }) as { review_id: string; outcome: string };
  assert.equal(result.outcome, "created");
  assert.ok(existsSync(join(hoop.store.dirOf(result.review_id), "build.json")));
});

test("on the build page the person adds, edits, moves and removes blocks from the keyboard", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(OUTLINE);
    await page.goto(`${base}/r/${id}`);
    await page.locator(".bblock").first().waitFor();
    assert.equal(await page.locator(".bblock").count(), 4);
    assert.equal(await page.locator("h1").textContent(), "Cutting cloud cost");

    // + after "Where the money goes", then Paragraph: the new block opens for editing.
    await page.getByRole("button", { name: "Add a block after Heading 1 “Where the money goes”" }).click();
    await page.getByRole("button", { name: "Paragraph", exact: true }).click();
    const box = page.getByLabel("Text of Paragraph 4");
    await box.waitFor();
    assert.equal(await box.evaluate((el) => el === document.activeElement), true, "the new block's text box has focus");
    await box.fill("Compute is **most** of it.");
    await page.keyboard.press("Control+Enter");
    await page.locator(".bpara strong", { hasText: "most" }).waitFor();
    assert.equal(
      await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute("aria-label")),
      "Edit Paragraph 4",
      "focus returns to the block's Edit button",
    );

    // Move Options above it, with its section, then remove the purpose paragraph.
    await page.getByRole("button", { name: "Move Heading 1 “Options” up" }).click();
    await page.getByRole("button", { name: "Remove Paragraph 2" }).click();
    await page.locator(".bblock").nth(3).locator(".bpara").waitFor();
    // Escape leaves an edit without saving.
    await page.getByRole("button", { name: "Edit Title “Cutting cloud cost”" }).click();
    await page.getByLabel("Text of Title “Cutting cloud cost”").fill("# Something else");
    await page.keyboard.press("Escape");
    assert.equal(hoop.markdownOf(id), "# Cutting cloud cost\n\n## Options\n\n## Where the money goes\n\nCompute is **most** of it.\n");

    // A change made elsewhere shows without a reload.
    hoop.buildChange(id, { op: "add", kind: "table", after: "b5" });
    await page.locator(".md-table").waitFor();
  }),
);
