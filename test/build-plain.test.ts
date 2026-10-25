import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { exportMarkdown, parseMarkdown } from "../src/markdown.js";
import { OPS } from "../src/ops.js";
import { Store } from "../src/store.js";
import { applyTool, headingSource, TOOLS } from "../web/format.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

/** Applies a tool to `text`, with `[` and `]` marking the selection (absent: the cursor at the end). */
function tool(name: Parameters<typeof applyTool>[0], marked: string) {
  const start = marked.includes("[") ? marked.indexOf("[") : marked.length;
  const end = marked.includes("]") ? marked.indexOf("]") - 1 : start;
  const text = marked.replace("[", "").replace("]", "");
  const out = applyTool(name, text, start, end);
  return `${out.text.slice(0, out.start)}[${out.text.slice(out.start, out.end)}]${out.text.slice(out.end)}`;
}

test("each formatting button writes the markdown for it, and selects what to type next", () => {
  assert.deepEqual(
    TOOLS.map(([, label]) => label),
    ["Bold", "Italic", "Link", "Bulleted list", "Numbered list", "Table", "Code"],
  );
  assert.equal(tool("bold", "Cut [compute] first."), "Cut **[compute]** first.");
  assert.equal(tool("bold", "Cut "), "Cut **[bold text]**");
  assert.equal(tool("italic", "Cut [compute] first."), "Cut *[compute]* first.");
  assert.equal(tool("link", "See [the docs]."), "See [the docs]([https://]).");
  assert.equal(tool("bullets", "[Servers\nStorage]"), "[- Servers\n- Storage]");
  assert.equal(tool("bullets", "[- Servers\n- Storage]"), "[Servers\nStorage]", "a second press makes them plain lines again");
  assert.equal(tool("numbers", "[- Servers\n- Storage]"), "[1. Servers\n2. Storage]", "a bulleted list becomes numbered");
  assert.equal(tool("numbers", "Intro\nSer[ver]s"), "Intro\n[1. Servers]", "only the lines the selection touches");
  assert.equal(tool("table", "Costs."), "Costs.\n\n| [Column] | Column |\n|---|---|\n| Cell | Cell |", "a table is a block of its own");
  assert.equal(tool("table", ""), "| [Column] | Column |\n|---|---|\n| Cell | Cell |");
  assert.equal(tool("code", "Run [npm test] now."), "Run `[npm test]` now.");
  assert.equal(tool("code", "[npm ci\nnpm test]"), "```\n[npm ci\nnpm test]\n```", "lines become a code block");
  assert.equal(headingSource(2, "  Where the   money goes "), "## Where the money goes");
  assert.equal(headingSource(1, "Plan"), "# Plan");
  assert.equal(headingSource(2, "### Typed"), "### Typed", "typed markdown still works");
  assert.equal(headingSource(0, "- a\n- b"), "- a\n- b");
});

test("a document made only with buttons is valid markdown and exports byte for byte", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id: id } = hoop.startBuild("# Cutting cloud cost\n\nWhat this helps decide.\n");
  const press = (text: string, ...tools: Parameters<typeof applyTool>[0][]) => tools.reduce((t, name) => applyTool(name, t, 0, t.length).text, text);
  hoop.buildChange(id, { op: "add", kind: "h2", after: "b2" });
  hoop.buildChange(id, { op: "edit", block: "b3", text: headingSource(2, "Where the money goes") });
  hoop.buildChange(id, { op: "add", kind: "paragraph", after: "b3" });
  hoop.buildChange(id, { op: "edit", block: "b4", text: `${press("Compute", "bold")} is most of it.` });
  hoop.buildChange(id, { op: "add", kind: "list", after: "b4" });
  hoop.buildChange(id, { op: "edit", block: "b5", text: press("Servers\nStorage", "numbers") });
  hoop.buildChange(id, { op: "add", kind: "paragraph", after: "b5" });
  hoop.buildChange(id, { op: "edit", block: "b6", text: applyTool("table", "Shares:", 7, 7).text });
  const built = hoop.markdownOf(id);
  assert.equal(
    built,
    "# Cutting cloud cost\n\nWhat this helps decide.\n\n## Where the money goes\n\n**Compute** is most of it.\n\n1. Servers\n2. Storage\n\nShares:\n\n| Column | Column |\n|---|---|\n| Cell | Cell |\n",
  );
  assert.equal(exportMarkdown(parseMarkdown(built)), built, "the markdown parses and exports as written");
  hoop.finishBuild(id);
  const exported = OPS.find((o) => o.name === "export")!.run(hoop, { review_id: id }, { actor: "claude" }) as { markdown: string };
  assert.equal(exported.markdown, built);
});

test("the builder speaks in plain words: Heading 1 and 2, no sections and no markdown shown", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(
      "# Cutting cloud cost\n\nWhat this helps decide.\n\n## Where the money goes\n\n### Compute\n\n- **Servers**\n- Storage\n",
    );
    hoop.buildChange(id, { op: "suggest", block: "b3", kind: "subsections" });
    hoop.buildSuggest(id, "g1", [{ heading: "### Storage" }]);
    await page.goto(`${base}/r/${id}`);
    await page.locator(".bprop").waitFor();
    // Nothing the person reads or hears says "section" or shows a markdown mark.
    const names = await page.$$eval("main [aria-label], main [title]", (els) =>
      els.flatMap((el) => [el.getAttribute("aria-label") ?? "", el.getAttribute("title") ?? ""]),
    );
    const visible = await page.locator("main").innerText();
    for (const words of [visible, ...names]) {
      assert.doesNotMatch(words, /section/i, words);
      assert.doesNotMatch(words, /#|\*\*|markdown/i, words);
    }
    assert.equal(await page.getByRole("button", { name: "Edit Heading 1 “Where the money goes”" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Edit Heading 2 “Compute”" }).count(), 1);
    assert.equal(await page.locator(".bprop-h").innerText(), "Heading 2 Storage");

    // A heading edits as its words; Enter saves it at its level.
    await page.getByRole("button", { name: "Edit Heading 1 “Where the money goes”" }).click();
    const words = page.getByLabel("Text of Heading 1 “Where the money goes”");
    assert.equal(await words.inputValue(), "Where the money goes");
    await words.fill("Where it goes");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Edit Heading 1 “Where it goes”" }).waitFor();

    // The + menu names headings plainly.
    await page.getByRole("button", { name: "Add a block at the top" }).click();
    const kinds = await page.locator(".kinds button").allInnerTexts();
    assert.deepEqual(kinds.slice(0, 3), ["Title", "Heading 1", "Heading 2"]);
    await page.keyboard.press("Escape");

    // The toolbar formats the selection, from the keyboard, and the block shows formatted.
    await page.getByRole("button", { name: "Edit Paragraph 2" }).click();
    const box = page.getByLabel("Text of Paragraph 2");
    await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 9));
    await page.getByRole("button", { name: "Bold in Paragraph 2" }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await box.inputValue(), "What **this** helps decide.");
    assert.equal(await box.evaluate((el) => el === document.activeElement), true, "focus goes back to the text");
    await page.keyboard.press("Control+Enter");
    await page.locator(".bpara strong", { hasText: "this" }).waitFor();
    assert.match(hoop.markdownOf(id), /^# Cutting cloud cost\n\nWhat \*\*this\*\* helps decide\.\n\n## Where it goes\n/);
  }),
);
