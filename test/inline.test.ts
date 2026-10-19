import { test } from "node:test";
import assert from "node:assert/strict";
import { findTyped, renderLine, shownText, widen } from "../web/inline.js";
import type { Block } from "../web/blocks.js";

const P: Block = { kind: "paragraph", indent: 0 };
const J = " ";
/** The rendered text with tags removed and entities decoded, as a reader sees it. */
const seen = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/** Every source-mapped span must hold exactly the source text at its offset. */
function assertMapped(text: string, html: string) {
  for (const m of html.matchAll(/<span data-s="(\d+)">([^<]*)<\/span>/g)) {
    const s = Number(m[1]), raw = seen(m[2]!), shown = raw === " " && text[s] === J ? J : raw.replace(/\n/g, J);
    assert.equal(text.slice(s, s + shown.length), shown, `span at ${s}`);
  }
}

test("FR-4: inline code, bold, italic and links render without their markers", () => {
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

test("FR-4: each kind of line shows as its kind, and a table row or an unknown kind shows as written", () => {
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

test("Trust boundary: only escaped text and fixed tags reach the page, and only http and https links open", () => {
  const html = renderLine(`<script>alert(1)</script> **<img src=x onerror=alert(1)>** [x](javascript:alert(1)) [y](https://a"onmouseover="z)`, [], P);
  assert.doesNotMatch(html, /<script|<img|href="javascript/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/a&quot;onmouseover=&quot;z"/, "a quote can't end the attribute");
  assert.equal([...html.matchAll(/<(\w+)/g)].map((m) => m[1]).filter((t) => !["span", "strong", "a", "em", "code", "mark", "del", "ins", "hr"].includes(t!)).length, 0);
});

test("FR-5: highlights and tracked changes sit on source positions inside formatted text", () => {
  const text = "the **bold** word";
  const marked = renderLine(text, [{ start: 4, end: 12, mark: true }], P);
  assert.match(marked, /<strong><mark class="hl" data-comment="plain"><span data-s="6">bold<\/span><\/mark><\/strong>/);
  const edited = renderLine(text, [{ start: 13, end: 17, insert: "term" }], P);
  assert.match(edited, /<del class="tc-del" data-comment="plain"><span data-s="13">word<\/span><\/del><ins class="tc-ins" data-comment="hide">term<\/ins>$/);
  const both = renderLine(text, [{ start: 13, end: 17, insert: "term" }, { start: 14, end: 16, mark: true }], P);
  assert.doesNotMatch(both, /<mark/, "an edit wins over a highlight it overlaps");
});

test("FR-5: a selection inside a formatted run widens to the whole run, markers included", () => {
  const text = "a **bold** and `code` and [link](https://x.y) end";
  const at = (w: string) => text.indexOf(w);
  assert.deepEqual(widen(text, P, at("old"), at("old") + 2), { start: at("**bold"), end: at("** and") + 2 });
  assert.deepEqual(widen(text, P, at("ode"), at(" and [")), { start: at("`code"), end: at(" and [") });
  assert.deepEqual(widen(text, P, at("ink"), at(" end")), { start: at("[link"), end: at(" end") });
  assert.deepEqual(widen(text, P, 0, 1), { start: 0, end: 1 }, "plain text doesn't widen");
});

test("FR-5: an edit on hidden markup shows on the line as written, so every deleted character is visible", () => {
  // Regression: deleted markers and link targets used to be hidden, so the edit read as an insertion.
  const link = "see [t](http://a) now";
  const html = renderLine(link, [{ start: link.indexOf("http"), end: link.indexOf(") now"), insert: "http://b" }], P);
  assert.equal(seen(html), "see [t](http://ahttp://b) now");
  assert.match(html, /<del class="tc-del" data-comment="plain"><span data-s="\d+">http:\/\/a<\/span><\/del><ins class="tc-ins" data-comment="hide">http:\/\/b<\/ins>/);
  const bold = "a **b** c";
  assert.equal(seen(renderLine(bold, [{ start: 2, end: 7, insert: "b" }], P)), "a **b**b c", "removing bold markers shows them struck");
  assert.match(renderLine(bold, [{ start: 4, end: 5, insert: "x" }], P), /<strong>/, "an edit on shown words keeps the formatting");
});

test("FR-5: highlights stay on the right words in list items, quotes and wrapped lines", () => {
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

test("FR-5a: typed words find the line as shown, across formatting, and give the whole source run", () => {
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

test("FR-5a: typed words prefer the words a reader sees over hidden link targets", () => {
  // Regression: the raw source was searched first, so "example" matched inside the link's address.
  const text = "See [the site](https://example.com) for an example";
  const found = findTyped(text, P, "example")!;
  assert.equal(text.slice(found.start, found.end), "example");
  assert.equal(found.start, text.lastIndexOf("example"));
  const link = findTyped(text, P, "the site")!;
  assert.equal(text.slice(link.start, link.end), "[the site](https://example.com)", "words in link text widen to the whole link");
});
