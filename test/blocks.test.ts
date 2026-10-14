import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseMarkdown } from "../src/markdown.js";
import { itemBlocks, itemLines } from "../src/contract.js";
import { blockKinds, JOIN, pieceMarker } from "../web/blocks.js";
import { example } from "./helpers.js";

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

test("D-5: blockKinds follows the parser's open block, across lists, code, tables and breaks", () => {
  // Regression: each line used to be judged alone, so a line after an open list item, indented
  // code or table row could get a kind the parser never gave it.
  const inputs = [
    "- item\n---", "- item\n___", "    code\n***", "- a | b\nc | d", "    a | b\nc | d",
    "| a |\n|---|\n| 1 |\nplain\nmore | pipe", "\t- a\n\tcode", "A paragraph\n- - -", "text\n\n- - -",
    "> quote | pipe\nnext | x", "```\nfenced\n```\n    after a fence", "| a | b |\n|---|---|\n\n| c |",
    "1. one\n   continued\n2. two", "- a\n  - nested\n    deeper text",
  ];
  for (const md of inputs) {
    const parsed: string[] = [];
    const doc = parseMarkdown(md, { onBlock: (k) => parsed.push(k) });
    assert.deepEqual(doc.items.flatMap((i) => blockKinds((i.body ?? "").split("\n")).map((b) => b.kind)), parsed, JSON.stringify(md));
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
  // The example review's bodies are prose, so its lines are paragraphs or list items.
  for (const item of example().items) assert.ok(itemBlocks(item).every((b) => b.kind === "paragraph" || b.kind === "list"), item.id);
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
