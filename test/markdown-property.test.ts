import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { validateReview } from "../src/contract.js";
import { exportMarkdown, parseMarkdown } from "../src/markdown.js";

// A property test (fast-check) of hoop's settled rule that an unedited document exports byte for
// byte: for markdown built from the blocks hoop parses (headings, paragraphs, lists, quotes, code
// fences and tables), parsing it and exporting it again gives back exactly the same text. The seed
// is fixed so CI runs the same cases every time; set HOOP_FC_SEED to try others.
const word = fc.stringMatching(/^[A-Za-z][a-z0-9]{0,8}$/);
const words = (min: number, max: number) => fc.array(word, { minLength: min, maxLength: max }).map((w) => w.join(" "));
const sentence = words(1, 10).map((s) => `${s[0]!.toUpperCase()}${s.slice(1)}.`);

const paragraph = fc.array(sentence, { minLength: 1, maxLength: 3 }).map((s) => s.join(" "));
const list = fc.array(words(1, 6), { minLength: 1, maxLength: 4 }).map((items) => items.map((i) => `- ${i}`).join("\n"));
const numbered = fc.array(words(1, 6), { minLength: 1, maxLength: 4 }).map((items) => items.map((i, n) => `${n + 1}. ${i}`).join("\n"));
const quote = sentence.map((s) => `> ${s}`);
const fence = fc.array(words(0, 5), { minLength: 1, maxLength: 3 }).map((lines) => `\`\`\`\n${lines.join("\n")}\n\`\`\``);
const table = fc
  .tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 }))
  .chain(([cols, rows]) =>
    fc
      .array(fc.array(word, { minLength: cols, maxLength: cols }), { minLength: rows + 1, maxLength: rows + 1 })
      .map((cells) => [cells[0]!, cells[0]!.map(() => "---"), ...cells.slice(1)].map((r) => `| ${r.join(" | ")} |`).join("\n")),
  );
const block = fc.oneof(paragraph, paragraph, list, numbered, quote, fence, table);
const section = fc
  .tuple(fc.constantFrom("##", "###"), words(1, 5), fc.array(block, { maxLength: 3 }))
  .map(([h, title, blocks]) => [`${h} ${title}`, ...blocks]);

/** A whole document: its title, a summary paragraph, then sections of blocks, each block apart by a blank line. */
const doc = fc
  .tuple(words(1, 6), paragraph, fc.array(section, { maxLength: 4 }))
  .map(([title, summary, sections]) => `${[`# ${title}`, summary, ...sections.flat()].join("\n\n")}\n`);

const seed = process.env.HOOP_FC_SEED ? Number(process.env.HOOP_FC_SEED) : 212;

test("any document built from hoop's blocks exports, unedited, byte for byte", () => {
  fc.assert(
    fc.property(doc, (md) => {
      const parsed = parseMarkdown(md);
      assert.equal(validateReview(parsed).ok, true);
      assert.equal(exportMarkdown(parsed), md);
      assert.deepEqual(parseMarkdown(exportMarkdown(parsed)), parsed);
    }),
    { seed, numRuns: 300 },
  );
});
