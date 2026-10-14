import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseMarkdown } from "../src/markdown.js";
import { itemBlocks, itemLines } from "../src/contract.js";
import { blockKinds, JOIN, pieceMarker } from "../web/blocks.js";
import { example } from "./helpers.js";
import { withServer } from "./web.test.js";

const root = new URL("..", import.meta.url).pathname;
const markdownFiles = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? markdownFiles(p) : f.endsWith(".md") ? [p] : [];
});
const files = [...markdownFiles(join(root, "docs")), join(root, "README.md"), join(root, "CLAUDE.md")];

test("D-5: blockKinds gives every line of every document in docs/ the kind the parser decided", () => {
  assert.ok(files.length > 20, "the check covers the repo's documents");
  for (const file of files) {
    const parsed: string[] = [];
    const doc = parseMarkdown(readFileSync(file, "utf8"), { onBlock: (k) => parsed.push(k) });
    const kinds = doc.items.flatMap((i) => blockKinds((i.body ?? "").split("\n")).map((b) => b.kind));
    assert.deepEqual(kinds, parsed, file);
  }
});

// The edit engine's structure rule before this change, kept here as the reference.
const OLD = /^\s*(#{1,6}\s|```|~~~|[-*+]\s|\d+[.)]\s|>|\|)/;
const oldShape = (text: string) => text.split(" ").map((l) => l.match(OLD)?.[1]?.trim() ?? "");

test("D-5: pieceMarker gives exactly today's structure markers on every line in docs/", () => {
  let n = 0;
  for (const file of files) {
    for (const item of parseMarkdown(readFileSync(file, "utf8")).items) {
      for (const line of itemLines(item)) {
        assert.deepEqual(pieceMarker(line), oldShape(line), `${file}: ${line}`);
        n++;
      }
    }
  }
  assert.ok(n > 1000);
});

test("D-5: every item has one block per line, for the documents in docs/ and the example review", () => {
  const items = [...files.flatMap((f) => parseMarkdown(readFileSync(f, "utf8")).items), ...example().items];
  for (const item of items) assert.equal(itemBlocks(item).length, itemLines(item).length, item.id);
  const question = example().items.find((i: { type: string }) => i.type === "question");
  assert.ok(itemBlocks(question).every((b) => b.kind === "paragraph"), "choices and checks are paragraphs");
});

test("FR-4: each kind of line gets its kind and a list item its indent", () => {
  const raw = [
    "A paragraph" + JOIN + "that wraps", "", "- a list item", "  - a nested item", "> a quote",
    "```js" + JOIN + "code" + JOIN + "```", "", "    indented code", "", "***", "", "| a | b |", "|---|---|", "| 1 | 2 |",
    "", "A paragraph", "- - -", "", "- - -",
  ];
  assert.deepEqual(blockKinds(raw), [
    { kind: "paragraph", indent: 0 }, { kind: "list", indent: 0 }, { kind: "list", indent: 2 },
    { kind: "quote", indent: 0 }, { kind: "code", indent: 0 }, { kind: "code", indent: 0 }, { kind: "break", indent: 0 },
    { kind: "table", indent: 0 }, { kind: "table", indent: 0 }, { kind: "table", indent: 0 },
    { kind: "paragraph", indent: 0 }, { kind: "list", indent: 0 }, { kind: "break", indent: 0 },
  ]);
  assert.deepEqual(blockKinds(["Text with a | pipe"]), [{ kind: "paragraph", indent: 0 }]);
});

test("D-5: the review view sends each item's blocks, and earlier revisions' blocks beside history", () =>
  withServer(async (base, hoop) => {
    const doc = parseMarkdown("# Title\n\n## One\n\n- an item\n\nText.\n", {});
    const { review_id } = hoop.submit(doc);
    hoop.submit({ ...parseMarkdown("# Title\n\n## One\n\n> a quote\n", {}), review_id });
    const view = await (await fetch(`${base}/api/reviews/${review_id}`)).json();
    assert.deepEqual(view.doc.items[0].blocks, [{ kind: "quote", indent: 0 }]);
    assert.deepEqual(view.previous.items[0].blocks, [{ kind: "list", indent: 0 }, { kind: "paragraph", indent: 0 }]);
    assert.deepEqual(view.history_blocks, { 1: { [view.doc.items[0].id]: [{ kind: "list", indent: 0 }, { kind: "paragraph", indent: 0 }] } });
    assert.equal("blocks" in view.history[1], false, "history keeps its shape");
  }));
