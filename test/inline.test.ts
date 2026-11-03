import { test } from "node:test";
import assert from "node:assert/strict";
import { findTyped, inlineHtml, plainText, renderLine, shownText, titleHtml, widen } from "../web/inline.js";
import type { Block } from "../web/blocks.js";
import { exportMarkdown, parseMarkdown } from "../src/markdown.js";

const P: Block = { kind: "paragraph", indent: 0 };
const J = "\u2028";
/** The rendered text with tags removed and entities decoded, as a reader sees it. */
const seen = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
/** Every source-mapped span must hold exactly the source text at its offset. */
function assertMapped(text: string, html: string) {
  for (const m of html.matchAll(/<span data-s="(\d+)">([^<]*)<\/span>/g)) {
    const s = Number(m[1]),
      raw = seen(m[2]!),
      shown = raw === " " && text[s] === J ? J : raw.replace(/\n/g, J);
    assert.equal(text.slice(s, s + shown.length), shown, `span at ${s}`);
  }
}

test("inline code, bold, italic and links render without their markers", () => {
  const text = "Use `foo()` with **care**, *often* and _rarely_, see [the docs](https://example.com).";
  const html = renderLine(text, [], P);
  assert.match(html, /<code><span data-s="5">foo\(\)<\/span><\/code>/);
  assert.match(html, /<strong><span data-s="\d+">care<\/span><\/strong>/);
  assert.match(html, /<em><span data-s="\d+">often<\/span><\/em>/);
  assert.match(html, /<em><span data-s="\d+">rarely<\/span><\/em>/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"><span data-s="\d+">the docs<\/span><\/a>/);
  assert.equal(seen(html), "Use foo() with care, often and rarely, see the docs.");
  assert.equal(shownText(text, P), "Use foo() with care, often and rarely, see the docs.");
  assertMapped(text, html);
  assert.equal(seen(renderLine("snake_case_name stays", [], P)), "snake_case_name stays", "underscores inside words aren't italic");
});

test("each kind of line shows as its kind, and a table row or an unknown kind shows as written", () => {
  const list = renderLine("- an **item**", [], { kind: "list", indent: 2 });
  assert.match(list, /class="ln-list" style="--indent:2"/);
  assert.match(list, /class="ln-marker nosrc" aria-hidden="true">•</);
  assert.equal(seen(list), "•an item");
  assert.equal(seen(renderLine("2. second", [], { kind: "list", indent: 0 })), "2.second");
  assert.equal(seen(renderLine("> a *quote*", [], { kind: "quote", indent: 0 })), "a quote");
  const fence = "```js" + J + "const a = `b` **c**;" + J + "```";
  const code = renderLine(fence, [], { kind: "code", indent: 0 });
  assert.match(code, /^<code class="ln-code">/);
  assert.equal(seen(code), "const a = `b` **c**;", "no formatting inside code, and no fence lines");
  assertMapped(fence, code);
  assert.equal(seen(renderLine("indented" + J + "    more", [], { kind: "code", indent: 0 })), "indented\nmore");
  // Wrapped prose flows as published markdown does, and each source character keeps its offset.
  const wrapped = "- a list item" + J + "  that wraps";
  const flowed = renderLine(wrapped, [], { kind: "list", indent: 0 });
  assert.equal(seen(flowed), "•a list item that wraps");
  assert.equal(seen(renderLine("> a quote" + J + "> that wraps", [], { kind: "quote", indent: 0 })), "a quote that wraps");
  assert.equal(seen(renderLine("A paragraph" + J + "that wraps", [], P)), "A paragraph that wraps");
  assert.equal(shownText(wrapped, { kind: "list", indent: 0 }), "a list item that wraps");
  assert.match(renderLine("***", [], { kind: "break", indent: 0 }), /^<hr class="ln-break">$/);
  assert.equal(seen(renderLine("| a | **b** |", [], { kind: "table", indent: 0 })), "| a | **b** |");
  assert.equal(seen(renderLine("- **x**", [], { kind: "diagram" as Block["kind"], indent: 0 })), "- **x**");
  assert.equal(seen(renderLine("- **x**", [])), "- **x**", "a line without a block shows as written");
});

test("web addresses written bare or in angle brackets open as links, without trailing punctuation", () => {
  const html = renderLine("See https://github.com/a/b/pull/116. Or <http://localhost:4747/r/rv_1>, and https://x.io/a_b_c (here).", [], P);
  assert.match(html, /<a href="https:\/\/github\.com\/a\/b\/pull\/116" target="_blank"[^>]*>(?:(?!<\/a>).)*<\/a><span data-s="\d+">\. Or /);
  assert.match(html, /<a href="http:\/\/localhost:4747\/r\/rv_1"/);
  assert.match(html, /<a href="https:\/\/x\.io\/a_b_c"/, "underscores in an address aren't italics");
  assert.doesNotMatch(html, /&lt;http/, "the angle brackets don't show");
  assert.equal(shownText("Go to <https://a.io> now", P), "Go to https://a.io now");
  assert.doesNotMatch(renderLine("`https://a.io` and [t](https://b.io)", [], P), /href="https:\/\/a\.io"/, "code spans stay code");
  assert.doesNotMatch(renderLine("ftp://a.io and xhttps://a.io", [], P), /<a /);
});

test("Trust boundary: only escaped text and fixed tags reach the page, and only http and https links open", () => {
  const html = renderLine(`<script>alert(1)</script> **<img src=x onerror=alert(1)>** [x](javascript:alert) [y](https://a"onmouseover="z)`, [], P);
  assert.doesNotMatch(html, /<script|<img|href="javascript/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/a&quot;onmouseover=&quot;z"/, "a quote can't end the attribute");
  assert.equal(
    [...html.matchAll(/<(\w+)/g)].map((m) => m[1]).filter((t) => !["span", "strong", "a", "em", "code", "mark", "del", "ins", "hr"].includes(t!)).length,
    0,
  );
});

test("highlights and tracked changes sit on source positions inside formatted text", () => {
  const text = "the **bold** word";
  const marked = renderLine(text, [{ start: 4, end: 12, mark: true }], P);
  assert.match(marked, /<strong><mark class="hl" data-comment="plain"><span data-s="6">bold<\/span><\/mark><\/strong>/);
  const edited = renderLine(text, [{ start: 13, end: 17, insert: "term" }], P);
  assert.match(edited, /<del class="tc-del" data-comment="plain"><span data-s="13">word<\/span><\/del><ins class="tc-ins" data-comment="hide">term<\/ins>$/);
  const both = renderLine(
    text,
    [
      { start: 13, end: 17, insert: "term" },
      { start: 14, end: 16, mark: true },
    ],
    P,
  );
  assert.doesNotMatch(both, /<mark/, "an edit wins over a highlight it overlaps");
});

test("a selection inside a formatted run widens to the whole run, markers included", () => {
  const text = "a **bold** and `code` and [link](https://x.y) end";
  const at = (w: string) => text.indexOf(w);
  assert.deepEqual(widen(text, P, at("old"), at("old") + 2), { start: at("**bold"), end: at("** and") + 2 });
  assert.deepEqual(widen(text, P, at("ode"), at(" and [")), { start: at("`code"), end: at(" and [") });
  assert.deepEqual(widen(text, P, at("ink"), at(" end")), { start: at("[link"), end: at(" end") });
  assert.deepEqual(widen(text, P, 0, 1), { start: 0, end: 1 }, "plain text doesn't widen");
});

test("an edit on hidden markup shows on the line as written, so every deleted character is visible", () => {
  // Regression: deleted markers and link targets used to be hidden, so the edit read as an insertion.
  const link = "see [t](http://a) now";
  const html = renderLine(link, [{ start: link.indexOf("http"), end: link.indexOf(") now"), insert: "http://b" }], P);
  assert.equal(seen(html), "see [t](http://ahttp://b) now");
  assert.match(
    html,
    /<del class="tc-del" data-comment="plain"><span data-s="\d+">http:\/\/a<\/span><\/del><ins class="tc-ins" data-comment="hide">http:\/\/b<\/ins>/,
  );
  const bold = "a **b** c";
  assert.equal(seen(renderLine(bold, [{ start: 2, end: 7, insert: "b" }], P)), "a **b**b c", "removing bold markers shows them struck");
  assert.match(renderLine(bold, [{ start: 4, end: 5, insert: "x" }], P), /<strong>/, "an edit on shown words keeps the formatting");
});

test("highlights stay on the right words in list items, quotes and wrapped lines", () => {
  const list = "- one **two**" + J + "  three";
  const html = renderLine(list, [{ start: list.indexOf("two") - 2, end: list.length, mark: true }], { kind: "list", indent: 0 });
  assert.equal([...html.matchAll(/<mark class="hl" data-comment="plain"><span data-s="\d+">([^<]*)<\/span><\/mark>/g)].map((m) => m[1]).join(""), "two three");
  assertMapped(list, html);
  const quote = "> said **this**";
  const q = renderLine(quote, [{ start: 2, end: quote.length, mark: true }], { kind: "quote", indent: 0 });
  assert.equal(seen(q), "said this");
  assert.equal((q.match(/<mark/g) ?? []).length, 2);
  // Regression: indented code kept its first line's indent.
  assert.equal(seen(renderLine("    x" + J + "    y", [], { kind: "code", indent: 0 })), "x\ny");
});

test("typed words find the line as shown, across formatting, and give the whole source run", () => {
  const text = "the `foo` value and **bold words** here";
  assert.deepEqual(findTyped(text, P, "the foo value"), { start: 0, end: text.indexOf(" and") });
  assert.deepEqual(findTyped(text, P, "oo"), { start: 4, end: 9 }, "words inside code widen to the whole code span");
  assert.deepEqual(findTyped(text, P, "bold"), { start: text.indexOf("**bold"), end: text.indexOf(" here") });
  assert.deepEqual(findTyped(text, P, "`foo`"), { start: 4, end: 9 }, "typed source text matches too");
  assert.equal(findTyped(text, P, "missing"), null);
  assert.equal(findTyped(text, P, ""), null);
  const wrapped = "- a list item" + J + "  that wraps";
  const found = findTyped(wrapped, { kind: "list", indent: 0 }, "item that")!;
  assert.equal(wrapped.slice(found.start, found.end), "item" + J + "  that", "typed words match across a soft wrap");
});

test("typed words prefer the words a reader sees over hidden link targets", () => {
  // Regression: the raw source was searched first, so "example" matched inside the link's address.
  const text = "See [the site](https://example.com) for an example";
  const found = findTyped(text, P, "example")!;
  assert.equal(text.slice(found.start, found.end), "example");
  assert.equal(found.start, text.lastIndexOf("example"));
  const link = findTyped(text, P, "the site")!;
  assert.equal(text.slice(link.start, link.end), "[the site](https://example.com)", "words in link text widen to the whole link");
});

test("free text renders inline formatting and links, keeps line breaks, and escapes everything else", () => {
  assert.equal(
    inlineHtml("See <b>this</b> at https://example.com/a.\nThen **run** `npm test` or [x](javascript:alert)."),
    'See &lt;b&gt;this&lt;/b&gt; at <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a>.<br>Then <strong>run</strong> <code>npm test</code> or x.',
  );
  // The caller may rename a link and keep it in this tab.
  const link = (href: string, shown: string) => (href.includes("/r/") ? { sameTab: true, ...(shown === href ? { text: "The plan" } : {}) } : {});
  assert.equal(
    inlineHtml("Plan: http://localhost:4747/r/rv_a1 and [plan](http://localhost:4747/r/rv_a1)", link),
    'Plan: <a href="http://localhost:4747/r/rv_a1">The plan</a> and <a href="http://localhost:4747/r/rv_a1">plan</a>',
  );
});

test("#339: a task list item shows a read-only checkbox for its box, never the brackets", () => {
  const open = renderLine("- [ ] Write the docs", [], { kind: "list", indent: 0 });
  assert.match(open, /<input type="checkbox" class="ln-check nosrc" disabled aria-label="Not done">/);
  assert.doesNotMatch(open, /•/, "the box takes the bullet's place");
  assert.equal(seen(open), "Write the docs");
  const done = renderLine("* [x] It is merged into B-16.", [], { kind: "list", indent: 2 });
  assert.match(done, /<input type="checkbox" class="ln-check nosrc" disabled checked aria-label="Done">/);
  assert.equal(seen(done), "It is merged into B-16.");
  assert.match(renderLine("- [X] Upper case too", [], { kind: "list", indent: 0 }), /checked aria-label="Done"/);
  // An ordered item keeps its number, with the box after it.
  const ordered = renderLine("2. [x] Second step", [], { kind: "list", indent: 0 });
  assert.equal(seen(ordered), "2.Second step");
  assert.match(ordered, /ln-body"><input type="checkbox"/);
  // An item that is only its box still shows the checkbox.
  assert.match(renderLine("- [ ]", [], { kind: "list", indent: 0 }), /aria-label="Not done"/);
  // Brackets that aren't a box stay as written.
  assert.equal(seen(renderLine("- [link] text", [], { kind: "list", indent: 0 })), "•[link] text");
  assert.equal(shownText("- [x] It is merged", { kind: "list", indent: 0 }), "It is merged");
  assertMapped("- [x] It is merged", renderLine("- [x] It is merged", [], { kind: "list", indent: 0 }));
});

/** The tags in rendered HTML, in order, without source spans or a link's attributes. */
const tags = (html: string) => html.replace(/<span data-s="\d+">|<\/span>/g, "").replace(/<a [^>]*>/g, "<a>");

test("#385: bold, italic, code and links nest, and no marker shows as text", () => {
  const cases: [string, string, string][] = [
    ["*em with `code`*", "<em>em with <code>code</code></em>", "em with code"],
    ["**bold *nested***", "<strong>bold <em>nested</em></strong>", "bold nested"],
    ["***word***", "<em><strong>word</strong></em>", "word"],
    ["*em **strong***", "<em>em <strong>strong</strong></em>", "em strong"],
    ["**see [docs](https://example.com)**", "<strong>see <a>docs</a></strong>", "see docs"],
    ["[**bold** link](https://example.com)", "<a><strong>bold</strong> link</a>", "bold link"],
    ["_em **strong**_ and __strong *em*__", "<em>em <strong>strong</strong></em> and <strong>strong <em>em</em></strong>", "em strong and strong em"],
  ];
  for (const [text, html, words] of cases) {
    const line = renderLine(text, [], P);
    assert.equal(tags(line), html, text);
    assert.equal(seen(line), words, text);
    assert.equal(shownText(text, P), words, text);
    assertMapped(text, line);
    assert.equal(tags(inlineHtml(text)), html, `free text: ${text}`);
  }
  // Text inside a code span stays literal, wherever the span sits.
  assert.equal(tags(renderLine("*see `**not bold**` here*", [], P)), "<em>see <code>**not bold**</code> here</em>");
  assert.equal(tags(renderLine("`[x](https://a.io)` and ``a ` b``", [], P)), "<code>[x](https://a.io)</code> and <code>a ` b</code>");
  // A link never holds another link, and markers that pair with nothing stay text.
  assert.equal(tags(renderLine("[see https://a.io](https://b.io)", [], P)), "<a>see https://a.io</a>");
  assert.equal(tags(renderLine("*a _b* c_ and 2 * 3 * 4 and ** loose **", [], P)), "<em>a _b</em> c_ and 2 * 3 * 4 and ** loose **");
  assert.equal(tags(renderLine("*unclosed **bold**", [], P)), "*unclosed <strong>bold</strong>");
});

test("#385: a word inside nested formatting keeps its source offsets, highlights and selection", () => {
  const text = "a **bold *nested*** end";
  const at = text.indexOf("nested");
  const html = renderLine(text, [{ start: at, end: at + 6, mark: true }], P);
  assert.match(
    html,
    new RegExp(`<strong><span data-s="4">bold </span><em><mark class="hl" data-comment="plain"><span data-s="${at}">nested</span></mark></em></strong>`),
  );
  assertMapped(text, html);
  // A selection inside nested formatting widens to the innermost run it sits in, so its quote stays balanced.
  const word = { start: at - 1, end: at + 7 };
  const whole = { start: text.indexOf("**"), end: text.indexOf(" end") };
  assert.deepEqual(widen(text, P, at, at + 6), word);
  assert.deepEqual(widen(text, P, at + 1, at + 3), word);
  assert.deepEqual(findTyped(text, P, "nested"), word);
  assert.deepEqual(findTyped(text, P, "bold nested"), whole, "a selection across the inner run's edge takes the outer run");
  assert.deepEqual(widen(text, P, at + 2, text.length), { start: whole.start, end: text.length }, "cut markers widen out to every run they cut");
  // A tracked change on the nested word strikes it in place and keeps the formatting around it.
  const edited = renderLine(text, [{ start: at, end: at + 6, insert: "deep" }], P);
  assert.match(
    edited,
    /<strong><span data-s="4">bold <\/span><em><del class="tc-del" data-comment="plain"><span data-s="\d+">nested<\/span><\/del><ins class="tc-ins" data-comment="hide">deep<\/ins><\/em><\/strong>/,
  );
});

test("#385: the renderer stays linear on long lines of unpaired and deeply nested markers", () => {
  const lines = [
    "*a ".repeat(4000) + "[".repeat(4000) + "<https://".repeat(1000),
    Array.from({ length: 2000 }, (_, i) => "`".repeat((i % 40) + 1) + "a").join(" "),
    "**a ".repeat(4000) + "b**".repeat(4000),
    // Regression: each `[` looked for the target after the one `]` again.
    "[".repeat(20000) + "a](" + "x".repeat(20000),
    // Regression: each link whose target never closed scanned the rest of the line for its end.
    "[](x".repeat(20000),
    "[a](x".repeat(20000),
  ];
  for (const line of lines) {
    const t = performance.now();
    renderLine(line, [], P);
    inlineHtml(line);
    widen(line, P, 5, 6);
    const ms = performance.now() - t;
    assert.ok(ms < 1000, `rendered ${line.length} characters in ${Math.round(ms)} ms`);
  }
});

test("#385 review: bold or italic beside punctuation formats next to letters and CJK text, and spaced markers stay text", () => {
  const cases: [string, string][] = [
    ["**注意：**这个很重要", "<strong>注意：</strong>这个很重要"],
    ["**Note:**text", "<strong>Note:</strong>text"],
    ["**Bold.**Next", "<strong>Bold.</strong>Next"],
    ["中文**（注）**中文", "中文<strong>（注）</strong>中文"],
    ["*（注）*と", "<em>（注）</em>と"],
    ['a**"quoted"**b', 'a<strong>"quoted"</strong>b'],
  ];
  for (const [text, html] of cases) {
    assert.equal(tags(renderLine(text, [], P)).replace(/&quot;/g, '"'), html, text);
    assertMapped(text, renderLine(text, [], P));
  }
  assert.equal(tags(renderLine("** a ** and * b *", [], P)), "** a ** and * b *");
  assert.equal(tags(renderLine("snake_case_name and file_(1)_x", [], P)), "snake_case_name and file_(1)_x");
  // `_` and `__` beside Chinese or Japanese text act as `*` does; between Latin letters they stay text.
  assert.equal(tags(renderLine("中文__强调__中文", [], P)), "中文<strong>强调</strong>中文");
  assert.equal(tags(renderLine("中文_强调_中文", [], P)), "中文<em>强调</em>中文");
  assert.equal(tags(renderLine("x__y__z", [], P)), "x__y__z");
});

test("#385 review: a `*` after a word and before punctuation pairs as italic, as on main", () => {
  // Pinned so a change to it is deliberate: footnote stars read as italic, which main did too.
  assert.equal(tags(renderLine("Terms*. Offer valid*.", [], P)), "Terms<em>. Offer valid</em>.");
  assert.equal(tags(renderLine("Rated 5*, critics gave 4*.", [], P)), "Rated 5<em>, critics gave 4</em>.");
});

/** main's renderer before #385, as a reference: one non-nesting pattern, its matches' markers hidden. */
const MAIN_INLINE =
  /(`+)([^\u2028]+?)\1|\*\*([^*\u2028]+?)\*\*|__([^_\u2028]+?)__|\*([^*\s\u2028](?:[^*\u2028]*?[^*\s\u2028])?)\*|(?<![\p{L}\p{N}_])_([^_\s\u2028](?:[^_\u2028]*?[^_\s\u2028])?)_(?![\p{L}\p{N}_])|\[([^\]\u2028]+)\]\(([^)\s\u2028]+)\)|<(https?:\/\/[^>\s\u2028]+)>|(?<![\p{L}\p{N}_/])(https?:\/\/[^\s<>\u2028]*[^\s<>\u2028.,;:!?)\]'"*_`])/gu;

/** The source offsets main's renderer hid: each match's markers, and a link's target. */
function hiddenOnMain(text: string) {
  const hidden = new Set<number>();
  for (const m of text.matchAll(MAIN_INLINE)) {
    const inner = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[9] ?? m[10]!;
    const open = m[1] ? m[1].length : m[3] !== undefined || m[4] !== undefined ? 2 : m[10] ? 0 : 1;
    for (let i = 0; i < m[0].length; i++) if (i < open || i >= open + inner.length) hidden.add(m.index + i);
  }
  return hidden;
}

/** The source offsets the renderer shows now. */
function shownNow(text: string) {
  const shown = new Set<number>();
  for (const m of renderLine(text, [], P).matchAll(/<span data-s="(\d+)">([^<]*)<\/span>/g)) {
    for (let i = 0; i < seen(m[2]!).length; i++) shown.add(Number(m[1]) + i);
  }
  return shown;
}

test("#385 review: every marker main hid in the fixture documents and the listed cases is still hidden", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("./fixtures/docs/", import.meta.url);
  // A fence line is part of a code block, never prose (main read "```" as a code span of one backtick).
  const lines = readdirSync(dir)
    .flatMap((f) => readFileSync(new URL(f, dir), "utf8").split("\n"))
    .filter((line) => !/^\s*```/.test(line));
  lines.push(
    "**注意：**这个很重要",
    "**Note:**text",
    "**Bold.**Next",
    "中文**（注）**中文",
    "中文__强调__中文",
    "Use `foo()` with **care**, *often* and _rarely_.",
  );
  const shownOnMain = (text: string) => [...hiddenOnMain(text)].some((i) => shownNow(text).has(i));
  assert.deepEqual(lines.filter(shownOnMain), []);
  // Lines main formatted that now show as written, on purpose: `__` inside a word, a closing run
  // after a space, and backticks that don't close as a run of the same length.
  for (const text of ["x__y__z", "**foo **bar", "run `ls -l`` now"]) {
    assert.ok(hiddenOnMain(text).size > 0, `main formatted ${text}`);
    assert.equal(seen(renderLine(text, [], P)), text, `${text} shows as written`);
  }
});

test("#385: a document holding nested formatting exports byte for byte", () => {
  const md =
    "# Nested\n\n*em with `code`* and **bold *nested***.\n\n- ***word*** and *em **strong***\n\n> **see [docs](https://example.com)**\n\n| a | b |\n|---|---|\n| **x *y*** | *z `w`* |\n";
  assert.equal(exportMarkdown(parseMarkdown(md)), md);
});

test("#389: a title reads plain without markers, and as HTML formatted with links showing only their words", () => {
  assert.equal(plainText("Plan with `code` and *emphasis*"), "Plan with code and emphasis");
  assert.equal(plainText("See [the spec](https://example.com) and **ship**"), "See the spec and ship");
  assert.equal(plainText("Plain title"), "Plain title");
  assert.equal(titleHtml("Plan with `code` and *emphasis*"), "Plan with <code>code</code> and <em>emphasis</em>");
  assert.equal(titleHtml("See **[the `spec`](https://example.com)** <b>"), "See <strong>the <code>spec</code></strong> &lt;b&gt;");
  assert.equal(titleHtml("Plain title"), "Plain title");
});
