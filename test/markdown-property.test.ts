import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { validateReview } from "../src/contract.js";
import { exportMarkdown, parseMarkdown } from "../src/markdown.js";

// A property test (fast-check) of hoop's settled rule that an unedited document exports byte for
// byte: parsing generated markdown and exporting it again gives back exactly the same text. The
// documents have a title, sometimes an italic subtitle, a summary, and sections with headings from
// level 2 to 6, holding:
//   - paragraphs wrapped over several lines (each block's lines join with U+2028 inside hoop);
//   - bullet, numbered and task lists, with continuation lines and nested, indented items;
//   - quotes over several lines;
//   - code fences, ``` or ~~~, plain or named (mermaid among them), whose lines look like markdown
//     (`# x`, `- x`, `| a | b |`, `---`);
//   - tables with alignment rows and escaped pipes in cells;
// with words in non-ASCII scripts as well as ASCII. The seed is fixed so CI runs the same cases
// every time; set HOOP_FC_SEED to a whole number to try others.
const LETTERS = ["a", "z", "é", "ü", "ñ", "ø", "ß", "я", "ж", "日", "本", "語", "한", "α", "ω"];
const word = fc
  .tuple(fc.constantFrom(...LETTERS), fc.array(fc.constantFrom(...LETTERS, "0", "7"), { maxLength: 7 }))
  .map(([first, rest]) => first + rest.join(""));
const words = (min: number, max: number) => fc.array(word, { minLength: min, maxLength: max }).map((w) => w.join(" "));
const sentence = words(1, 8).map((s) => `${s}.`);
/** Lines of text, each starting with a letter, so none reads as another block. */
const lines = (max: number) => fc.array(sentence, { minLength: 1, maxLength: max });

const paragraph = lines(3).map((l) => l.join("\n"));
const bullet = fc.constantFrom("- ", "* ", "- [ ] ", "- [x] ");
/** A list item: its first line, maybe a continuation line, maybe nested items indented under it. */
const item = (marker: fc.Arbitrary<string>) =>
  fc
    .tuple(marker, words(1, 5), fc.option(words(1, 5)), fc.array(fc.tuple(bullet, words(1, 4)), { maxLength: 2 }))
    .map(([m, first, more, nested]) => [`${m}${first}`, ...(more ? [`  ${more}`] : []), ...nested.map(([n, w]) => `  ${n}${w}`)].join("\n"));
const list = fc.array(item(bullet), { minLength: 1, maxLength: 3 }).map((items) => items.join("\n"));
const numbered = fc.array(item(fc.constant("")), { minLength: 1, maxLength: 3 }).map((items) => items.map((i, n) => `${n + 1}. ${i}`).join("\n"));
const quote = lines(3).map((l) => l.map((x) => `> ${x}`).join("\n"));
const fenceLine = fc.oneof(words(0, 4), fc.constantFrom("# x", "- x", "| a | b |", "---", "> x", "1. x", "## Question: x?"));
const fence = fc
  .tuple(fc.constantFrom("```", "~~~"), fc.constantFrom("", "sh", "ts"), fc.array(fenceLine, { minLength: 1, maxLength: 4 }))
  .map(([f, lang, body]) => `${f}${lang}\n${body.join("\n")}\n${f}`);
const mermaid = fc
  .array(fc.tuple(word, word), { minLength: 1, maxLength: 3 })
  .map((edges) => `\`\`\`mermaid\nflowchart TD\n${edges.map(([a, b], i) => `  n${i}a[${a}] --> n${i}b[${b}]`).join("\n")}\n\`\`\``);
const cell = fc.oneof(
  word,
  fc.tuple(word, word).map(([a, b]) => `${a} \\| ${b}`),
);
const table = fc
  .tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 }))
  .chain(([cols, rows]) =>
    fc.tuple(
      fc.array(cell, { minLength: cols, maxLength: cols }),
      fc.array(fc.constantFrom("---", ":---", "---:", ":---:"), { minLength: cols, maxLength: cols }),
      fc.array(fc.array(cell, { minLength: cols, maxLength: cols }), { minLength: rows, maxLength: rows }),
    ),
  )
  .map(([head, align, body]) => [head, align, ...body].map((r) => `| ${r.join(" | ")} |`).join("\n"));
const block = fc.oneof(paragraph, paragraph, list, numbered, quote, fence, mermaid, table);
const section = fc
  .tuple(fc.constantFrom("##", "###", "####", "#####", "######"), words(1, 5), fc.array(block, { maxLength: 3 }))
  .map(([h, title, blocks]) => [`${h} ${title}`, ...blocks]);

/** A whole document: its title, maybe a subtitle, a summary, then sections, each block apart by a blank line. */
const doc = fc
  .tuple(words(1, 6), fc.option(words(1, 8)), paragraph, fc.array(section, { maxLength: 4 }))
  .map(([title, subtitle, summary, sections]) => `${[`# ${title}`, ...(subtitle ? [`*${subtitle}*`] : []), summary, ...sections.flat()].join("\n\n")}\n`);

/** The fixed seed, or HOOP_FC_SEED when it names a whole number. */
function seedOf(value: string | undefined): number {
  if (value === undefined) return 212;
  const n = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n)) throw new Error(`HOOP_FC_SEED must be a whole number, not ${JSON.stringify(value)}`);
  return n;
}

test("any document built from hoop's blocks exports, unedited, byte for byte", () => {
  fc.assert(
    fc.property(doc, (md) => {
      const parsed = parseMarkdown(md);
      const valid = validateReview(parsed);
      assert.ok(valid.ok, `the parsed document isn't a valid review: ${JSON.stringify(valid.ok ? [] : valid.errors)}`);
      assert.equal(exportMarkdown(parsed), md);
      assert.deepEqual(parseMarkdown(exportMarkdown(parsed)), parsed);
    }),
    { seed: seedOf(process.env.HOOP_FC_SEED), numRuns: 300 },
  );
});

test("HOOP_FC_SEED takes a whole number only", () => {
  assert.equal(seedOf(undefined), 212);
  assert.equal(seedOf("7"), 7);
  for (const bad of ["", "x", "1.5", "1e400"]) assert.throws(() => seedOf(bad), /HOOP_FC_SEED must be a whole number/, bad);
});
