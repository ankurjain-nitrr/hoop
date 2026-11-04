import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { BROWSER_SKIP, webSourceLines, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";

// docs/DESIGN-LANGUAGE.md, Tokens and Sizes: every font size, spacing step and radius comes from the
// custom properties at the top of web/app.css. A raw px, rem or em size in a font size, a margin, a
// padding, a gap or a radius is a break, unless EXCEPTIONS lists it with its reason.

/** What a declaration that sizes text, spacing or a corner is called. */
const SIZED = /^(font-size|border(-[a-z]+)?-radius|margin(-[a-z]+)?|padding(-[a-z]+)?|gap|row-gap|column-gap)$/;

/** A raw length: a number with px, rem or em. Zero needs no token. */
const RAW = /(?<![\w-])-?\d*\.?\d+(px|rem|em)\b/g;

/**
 * Hairlines: 1px and 2px are a tag's or a badge's inner padding, or a nudge that lines a glyph up,
 * and stay below the spacing steps.
 */
const HAIRLINE = new Set(["1px", "2px", "-1px", "-2px"]);

/** Deliberate exceptions, by selector and property: the raw size each keeps, and why. */
const EXCEPTIONS: Record<string, string> = {
  // Two things keep their own text sizes (Sizes).
  ".frame .brand|font-size": "the brand in the top bar",
  ".bbody .bh-h1|font-size": "a document's own headings keep a scale of their own",
  ".bbody .bh-h2|font-size": "a document's own headings keep a scale of their own",
  ".bbody .bh-h3|font-size": "a document's own headings keep a scale of their own",
  // Code inside text is sized against the text around it.
  ".mono|font-size": "code inside text, relative to it",
  ".fmt code|font-size": "code inside text, relative to it",
  ".ln-list|padding-left": "a list's nesting, in em of its text",
  // A table's delimiter row is drawn as a thin rule, not text.
  ".md-table .tdelim-row td|font-size": "a table's delimiter row, drawn as a rule",
  // Layout: page margins, and indents that line a block up with the comment gutter, a list's marker or a
  // nesting level. They are widths, not steps between pieces.
  "body|padding-block": "the page's bottom margin",
  ".ask|padding-block": "the page's bottom margin",
  ".empty|margin": "the empty page's margin",
  ".list|margin": "the list page's top margin",
  ".removed-threads|margin-top": "a part of the page set apart",
  ".top:has(> .title-row h1.commentable) > .tabs|padding-left": "lines up with the title after its gutter",
  ".top:has(> .title-row h1.commentable) > .new-revision|margin-left": "lines up with the title after its gutter",
  ".subtitle.commentable|padding-left": "lines up with the title after its gutter",
  ".item|margin-left": "a section's nesting level",
  ".text|padding": "room for a line's edit button",
  ".qopts|padding": "lines up with the line text after the gutter",
  ".thread|margin": "lines up with the line text after the gutter",
  ".composer|margin": "lines up with the line text after the gutter",
  ".edit-card|margin": "lines up with the line text after the gutter",
  ".trail-list|padding-left": "a list's marker",
  ".work .queued-list|padding-left": "a list's marker",
  ".work .steps|padding-left": "a list's marker",
  ".build-trail ol|padding-left": "a list's marker",
  ".ask-history ul|padding-left": "a list's marker",
  ".berrs|padding-left": "a list's marker",
  ".bfolded|margin": "lines up with a block's text after its fold",
  ".berr.in|margin-left": "lines up with a block's text after its fold",
  ".bprops.in|margin-left": "lines up with a block's text after its fold",
  ".bprop-d2|margin-left": "a suggested heading's nesting level",
  ".bprop-d4|margin-left": "a suggested heading's nesting level",
  // A glyph's own box, centred on the first line of its text.
  ".outline a .dot|margin-top": "centres a 9px dot on its line",
};

/** The declarations in a stylesheet, outside the token definitions, as selector, property, value and line. */
function declarations(css: string) {
  const out: { sel: string; prop: string; value: string; line: number }[] = [];
  const stack: string[] = [];
  css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .split("\n")
    .forEach((raw, i) => {
      const s = raw.trim();
      if (s.endsWith("{")) return stack.push(s.slice(0, -1).trim());
      if (s === "}") return stack.pop();
      const m = s.match(/^([a-z-]+):\s*(.*);$/);
      if (m && !stack.some((x) => x.startsWith(":root"))) out.push({ sel: stack.at(-1) ?? "", prop: m[1]!, value: m[2]!, line: i + 1 });
    });
  return out;
}

test("every font size, spacing step and radius in the pages' stylesheets comes from a token, or is a listed exception", () => {
  const web = new URL("../web/", import.meta.url);
  const problems: string[] = [];
  const used = new Set<string>();
  for (const name of readdirSync(web).filter((n) => n.endsWith(".css"))) {
    for (const d of declarations(readFileSync(new URL(name, web), "utf8"))) {
      if (!SIZED.test(d.prop)) continue;
      const raw = (d.value.match(RAW) ?? []).filter((v) => !(HAIRLINE.has(v) && !d.prop.includes("font")) && !/^-?0(px|rem|em)$/.test(v));
      if (!raw.length) continue;
      const key = `${d.sel}|${d.prop}`;
      if (EXCEPTIONS[key]) used.add(key);
      else problems.push(`web/${name}:${d.line}: ${d.sel} { ${d.prop}: ${d.value} } uses ${raw.join(", ")}; use a size token`);
    }
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(
    Object.keys(EXCEPTIONS).filter((k) => !used.has(k)),
    [],
    "an exception that no longer applies goes from the list",
  );
});

test("no page sets a font size, spacing step or radius in an inline style", () => {
  const inline = /style=["'`][^"'`]*(font-size|margin|padding|gap|border-radius)\s*:|\.style\.(fontSize|margin|padding|gap|borderRadius)\w*\s*=/;
  assert.deepEqual(webSourceLines(inline), []);
});

test("every fold button is one size: a chevron alone fills a 24px square, and one with a label is at least 24px tall", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const doc = hoop.submit(parseMarkdown("# Plan\n\nWhy.\n\n## Steps\n\nA.\n\n### Copy\n\nB.\n\n## Costs\n\nC.\n")).review_id;
    const build = hoop.startBuild("# Cost\n\n## Summary\n\nMost of it is compute.\n").review_id;
    const problems: string[] = [];
    let alone = 0;
    for (const [path, ready] of [
      ["/", ".list h1"],
      [`/r/${doc}`, ".outline .fold-btn"],
      [`/r/${build}`, ".bsec-head > .fold-btn"],
    ] as const) {
      await page.goto(base + path);
      await page.locator(ready).first().waitFor();
      const folds = await page.locator(".fold-btn").evaluateAll((els) =>
        els
          .filter((el) => el.getClientRects().length)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              alone: !el.querySelector(":scope > span"),
              width: Math.round(r.width),
              height: Math.round(r.height),
              label: el.getAttribute("aria-label") ?? el.textContent,
            };
          }),
      );
      for (const f of folds) {
        if (f.alone) alone++;
        if (f.alone ? f.width !== 24 || f.height !== 24 : f.height < 24) problems.push(`${path}: "${f.label}" is ${f.width}x${f.height}`);
      }
    }
    assert.ok(alone >= 2, "the outline's and a build section's chevrons are measured");
    assert.deepEqual(problems, []);
  }),
);
