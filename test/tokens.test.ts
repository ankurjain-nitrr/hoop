import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { BROWSER_SKIP, webSourceLines, withBrowser } from "./helpers.js";
import { parseMarkdown } from "../src/markdown.js";

// docs/DESIGN-LANGUAGE.md, Tokens and Sizes: every font size, spacing step and radius comes from the
// custom properties at the top of web/app.css. A raw px, rem or em size in a font size, a margin, a
// padding, a gap or a radius is a break, unless EXCEPTIONS lists it with its reason.

/** What a declaration that sizes text, spacing or a corner is called. */
const SIZED = /^(font|font-size|border(-[a-z]+)?-radius|margin(-[a-z]+)?|padding(-[a-z]+)?|gap|row-gap|column-gap)$/;

/** A raw length: a number with px, rem, em or pt. Zero needs no token. */
const RAW = /(?<![\w-])-?\d*\.?\d+(px|rem|em|pt)\b/g;
/** A raw text size, which may also be a percentage. A line height after a slash ("14px/1.4") has no unit. */
const RAW_FONT = /(?<![\w-])-?\d*\.?\d+(?:(?:px|rem|em|pt)\b|%)/g;

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
  "code|font-size": "code inside text, relative to it",
  ".fmt code|font-size": "code inside text, relative to it",
  ".text code|font-size": "code inside text, relative to it",
  ".anchor code|font-size": "code inside text, relative to it",
  ".bbody :not(pre) > code|font-size": "code inside text, relative to it",
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
  ".top:has(> .title-row h1.commentable) > .sub|padding-left": "lines up with the title after its gutter",
  ".top:has(> .title-row h1.commentable) > .agent-state|padding-left": "lines up with the title after its gutter",
  ".top:has(> .title-row h1.commentable) > .new-revision|margin-left": "lines up with the title after its gutter",
  "h1.commentable|padding-left": "the comment gutter before a commentable line's text",
  ".item-head.commentable|padding-left": "the comment gutter before a commentable line's text",
  ".tldr.commentable|padding-left": "the comment gutter before a commentable line's text",
  ".subtitle.commentable|padding-left": "the comment gutter before a commentable line's text",
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
  ".undo-line.in|margin-left": "lines up with a block's text after its fold",
  ".bprop-d2|margin-left": "a suggested heading's nesting level",
  ".bprop-d3|margin-left": "a suggested heading's nesting level",
  ".bprop-d4|margin-left": "a suggested heading's nesting level",
  // A glyph's own box, centred on the first line of its text.
  ".outline a .dot|margin-top": "centres a 9px dot on its line",
};

/** The selectors of a group, split at its top-level commas, not those inside :not() or :has(). */
function selectorsOf(group: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < group.length; i++) {
    if (group[i] === "(") depth++;
    else if (group[i] === ")") depth--;
    else if (group[i] === "," && depth === 0) {
      out.push(group.slice(from, i));
      from = i + 1;
    }
  }
  out.push(group.slice(from));
  return out.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/**
 * The declarations in a stylesheet, outside the token definitions, with each selector of the rule
 * they are in, their property, value and line. It reads the sheet by its braces and semicolons, so a
 * rule on one line, a selector group and a value over several lines all count.
 */
function declarations(css: string) {
  const out: { sels: string[]; prop: string; value: string; line: number }[] = [];
  const stack: string[][] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  let buf = "";
  let line = 1;
  let first = 0;
  const flush = () => {
    const m = buf.trim().match(/^([a-z-]+)\s*:\s*([\s\S]*)$/);
    const rule = stack.at(-1);
    const root = stack.some((sels) => sels.some((s) => s.startsWith(":root")));
    if (m && rule?.length && !root) out.push({ sels: rule, prop: m[1]!, value: m[2]!.replace(/\s+/g, " ").trim(), line: first });
    buf = "";
  };
  for (const c of text) {
    if (c === "{") {
      const prelude = buf.trim();
      // An at-rule such as @media holds rules; it isn't a rule of its own.
      stack.push(prelude.startsWith("@") ? [] : selectorsOf(prelude));
      buf = "";
    } else if (c === ";" || c === "}") {
      flush();
      if (c === "}") stack.pop();
    } else {
      if (!buf.trim() && c.trim()) first = line;
      buf += c;
    }
    if (c === "\n") line++;
  }
  return out;
}

/**
 * The raw sizes in stylesheet `css` (called `name`) outside the token definitions and EXCEPTIONS: one
 * problem for each selector of a rule that uses one. The exceptions that apply go into `used`.
 */
function sizeProblems(css: string, name: string, used = new Set<string>()): string[] {
  const problems: string[] = [];
  for (const d of declarations(css)) {
    if (!SIZED.test(d.prop)) continue;
    const font = d.prop.startsWith("font");
    const raw = (d.value.match(font ? RAW_FONT : RAW) ?? []).filter((v) => !(HAIRLINE.has(v) && !font) && !/^-?0[a-z%]*$/.test(v));
    if (!raw.length) continue;
    for (const sel of d.sels) {
      const key = `${sel}|${d.prop}`;
      if (EXCEPTIONS[key]) used.add(key);
      else problems.push(`${name}:${d.line}: ${sel} { ${d.prop}: ${d.value} } uses ${raw.join(", ")}; use a size token`);
    }
  }
  return problems;
}

test("every font size, spacing step and radius in the pages' stylesheets comes from a token, or is a listed exception", () => {
  const web = new URL("../web/", import.meta.url);
  const problems: string[] = [];
  const used = new Set<string>();
  for (const name of readdirSync(web).filter((n) => n.endsWith(".css")))
    problems.push(...sizeProblems(readFileSync(new URL(name, web), "utf8"), `web/${name}`, used));
  assert.deepEqual(problems, []);
  assert.deepEqual(
    Object.keys(EXCEPTIONS).filter((k) => !used.has(k)),
    [],
    "an exception that no longer applies goes from the list",
  );
});

test("the size check finds a raw size however the rule is written, and passes tokens", () => {
  const caught = {
    "a rule on one line": ".x { padding: 6px; }",
    "a selector beside an excepted one": ".frame .brand, .x { font-size: 18px; }",
    "a value over several lines": ".x {\n  margin:\n    6px\n    8px;\n}",
    "the font shorthand": ".x { font: 600 14px/1.4 var(--font-body); }",
    "a size in points": ".x { font-size: 10pt; }",
    "a size in percent": ".x { font-size: 90%; }",
    "a rule inside a media query": "@media (max-width: 600px) { .x { gap: 10px; } }",
  };
  for (const [what, css] of Object.entries(caught)) {
    const found = sizeProblems(css, "probe.css");
    assert.equal(found.length, 1, `${what}: ${found.join("; ") || "not caught"}`);
    assert.match(found[0]!, /^probe\.css:\d+: \.x /, `${what}: the problem names the selector that uses it`);
  }
  const fine = [
    ".x { font-size: var(--text-body); padding: 0 var(--space-1); border-radius: var(--radius-card); }",
    ".x { font: inherit; margin: 0 auto; padding: 1px var(--space-2); }",
    ":root { --space-1: 4px; } @media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { --text-body: 15px; } }",
    ".frame .brand { font-size: 18px; }",
  ];
  for (const css of fine) assert.deepEqual(sizeProblems(css, "probe.css"), [], css);
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

test("every icon-only control on the pages, as they render, is at least a 24px square", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const doc = hoop.submit(parseMarkdown("# Plan\n\nWhy.\n\n## Steps\n\nA.\n\n### Copy\n\nB.\n")).review_id;
    const build = hoop.startBuild("# Cost\n\nNotes.\n\n## Summary\n\nMost of it is compute.\n\n- Servers\n").review_id;
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const [path, ready] of [
      ["/", ".list h1"],
      [`/r/${doc}`, ".top h1"],
      [`/r/${build}`, ".bblock"],
    ] as const) {
      await page.goto(base + path);
      await page.locator(ready).first().waitFor();
      const sizes = await page.evaluate(() =>
        [...document.querySelectorAll("button")]
          .filter((el) => {
            // An icon-only control: an icon, or one character such as "+", named by its aria-label.
            const words = (el.textContent ?? "").trim();
            return el.getClientRects().length && el.hasAttribute("aria-label") && (el.querySelector("svg") ? words === "" : words.length === 1);
          })
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { cls: el.className, label: el.getAttribute("aria-label") ?? "", width: Math.round(r.width), height: Math.round(r.height) };
          }),
      );
      for (const s of sizes) {
        seen.add(s.cls);
        if (s.width < 24 || s.height < 24) problems.push(`${path}: "${s.label}" (${s.cls}) is ${s.width}x${s.height}`);
      }
    }
    assert.ok(
      [...seen].some((c) => c.includes("btool")),
      "the build page's Edit, Move and Remove are measured",
    );
    assert.ok(
      [...seen].some((c) => c.includes("add-block")),
      "the build page's + is measured",
    );
    assert.deepEqual(problems, []);
    // A review line's + and its edit button, and Home's rename, are measured too.
    for (const c of ["add-btn", "edit-btn", "rename-btn"])
      assert.ok(
        [...seen].some((x) => x.split(/\s+/).includes(c)),
        `${c} is measured`,
      );
  }),
);
