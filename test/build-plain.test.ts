import { test } from "node:test";
import assert from "node:assert/strict";
import { Hoop } from "../src/hoop.js";
import { exportMarkdown, parseMarkdown } from "../src/markdown.js";
import { OPS } from "../src/ops.js";
import { Store } from "../src/store.js";
import { headingText, kindOf, splitBlocks } from "../src/build.js";
import { applyTool, headingSource, TABLE_TOOLS, TOOLS } from "../web/format.js";
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
  assert.equal(tool("numbers", "Intro\nSer[ver]s"), "Intro\n\n[1. Servers]", "only the lines the selection touches");
  assert.equal(tool("table", "Costs."), "Costs.\n\n| [Column] | Column |\n|---|---|\n| Cell | Cell |", "a table is a block of its own");
  assert.equal(tool("table", ""), "| [Column] | Column |\n|---|---|\n| Cell | Cell |");
  assert.equal(tool("code", "Run [npm test] now."), "Run `[npm test]` now.");
  assert.equal(tool("code", "[npm ci\nnpm test]"), "```\n[npm ci\nnpm test]\n```", "lines become a code block");
  assert.equal(headingSource(2, "  Where the   money goes "), "## Where the money goes");
  assert.equal(headingSource(1, "Plan"), "# Plan");
  assert.equal(headingSource(0, "- a\n- b"), "- a\n- b");
});

test("regressions from #243: headings, lists in a paragraph, toggling, backticks, tables", () => {
  // A heading's words that start with # keep the heading's level.
  assert.equal(headingSource(2, "#1 priority"), "## #1 priority");
  assert.equal(headingSource(1, "# of users"), "# # of users");
  assert.equal(kindOf(headingSource(2, "#1 priority")), "h2");

  // A list made from some lines of a paragraph is a block of its own, between paragraphs.
  const made = tool("bullets", "First line\n[second line]\nthird line");
  assert.equal(made, "First line\n\n[- second line]\n\nthird line");
  assert.deepEqual(
    splitBlocks(made.replace("[", "").replace("]", "")).blocks.map((b) => b.kind),
    ["paragraph", "list", "paragraph"],
  );
  assert.equal(tool("numbers", "Intro\n\n[a\nb]"), "Intro\n\n[1. a\n2. b]", "no extra blank line where one is already");

  // Bold, Italic and Code toggle off; spaces stay outside the marks; lines are wrapped one by one.
  assert.equal(tool("bold", "Cut **[compute]** first."), "Cut [compute] first.");
  assert.equal(tool("bold", "Cut [**compute**] first."), "Cut [compute] first.");
  assert.equal(tool("italic", "Cut *[compute]* first."), "Cut [compute] first.");
  assert.equal(tool("italic", "Cut _[compute]_ first."), "Cut [compute] first.");
  assert.equal(tool("italic", "Cut **[compute]** first."), "Cut ***[compute]*** first.", "italic inside bold adds a mark");
  assert.equal(tool("code", "Run `[npm test]` now."), "Run [npm test] now.");
  assert.equal(tool("bold", "Cut[ compute ]first."), "Cut **[compute]** first.");
  assert.equal(tool("bold", "[one\n\n- two]"), "[**one**\n\n- **two**]", "never across a blank line");

  // Backticks inside code get a longer run around them.
  assert.equal(tool("code", "Type [a `b` c] here."), "Type ``[a `b` c]`` here.");
  assert.equal(tool("code", "Type [`b`] here."), "Type `` [`b`] `` here.");
  assert.equal(tool("code", "[~~~\n```js\nx\n```]"), "````\n[~~~\n```js\nx\n```]\n````");
  assert.equal(tool("code", "Intro\n[a\nb]"), "Intro\n\n```\n[a\nb]\n```", "a code block is a block of its own");

  // A table's cells take only inline buttons, and Code stays inline in them.
  assert.deepEqual(TABLE_TOOLS, ["bold", "italic", "link", "code"]);
  const cells = "| a | b |\n|---|---|\n| c | d |";
  assert.equal(applyTool("code", cells, 2, 3, { inline: true }).text, "| `a` | b |\n|---|---|\n| c | d |");
});

/** The kinds of block `text` splits into. */
const kinds = (text: string) => splitBlocks(text).blocks.map((b) => b.kind);

test("in a table, marks go cell by cell and never on the row that sets the columns", () => {
  const cells = "| a | b |\n|---|---|\n| c | d |";
  for (const name of ["bold", "italic", "code"] as const) {
    const out = applyTool(name, cells, 2, cells.length, { inline: true }).text;
    assert.deepEqual(kinds(out), ["table"], `${name} keeps the table: ${out}`);
    assert.match(out, /\n\|---\|---\|\n/, `${name} leaves the row under the header alone`);
  }
  assert.equal(applyTool("bold", cells, 2, cells.length, { inline: true }).text, "| **a** | **b** |\n|---|---|\n| **c** | **d** |");
  assert.equal(applyTool("italic", cells, 2, 7, { inline: true }).text, "| *a* | *b* |\n|---|---|\n| c | d |", "one row, two cells");
});

test("Bold and Italic each toggle their own part of bold italic", () => {
  assert.equal(tool("italic", "***[x]***"), "**[x]**");
  assert.equal(tool("italic", tool("italic", "***[x]***")), "***[x]***");
  assert.equal(tool("bold", "***[x]***"), "*[x]*");
  assert.equal(tool("bold", tool("bold", "***[x]***")), "***[x]***");
  assert.equal(tool("bold", "*[x]*"), "***[x]***");
});

test("Bold doesn't unwrap two bold runs into one broken one", () => {
  assert.equal(tool("bold", "[**a** and **b**]"), "**[**a** and **b**]**");
  assert.notEqual(tool("bold", "[**a** and **b**]"), "[a** and **b]");
});

test("a heading whose words end in # keeps them", () => {
  const md = headingSource(2, "Learn C #");
  assert.equal(md, "## Learn C # ##");
  assert.equal(headingText(md), "Learn C #");
  assert.equal(kindOf(md), "h2");
  assert.equal(headingText(headingSource(2, "###")), "###");
  assert.equal(headingSource(2, "C# basics"), "## C# basics", "a # inside the words needs nothing");
});

test("line by line, quote and list markers stay outside the marks; spaces alone get the placeholder", () => {
  assert.equal(tool("bold", "[> one\n> two]"), "[> **one**\n> **two**]");
  assert.equal(tool("italic", "[1. one\n2. two]"), "[1. *one*\n2. *two*]");
  assert.equal(tool("bold", "a[   ]b"), "a**[bold text]**   b");
});

test("Italic leaves the underscores in a snake_case name", () => {
  assert.equal(tool("italic", "snake_[case]_name"), "snake_*[case]*_name");
  assert.equal(tool("italic", "a _[b]_ c"), "a [b] c", "a real _italic_ still comes off");
});

test("Code takes off the code it padded with spaces", () => {
  const on = tool("code", "Type [`b`] here.");
  assert.equal(on, "Type `` [`b`] `` here.");
  assert.equal(tool("code", on), "Type [`b`] here.");
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
    assert.deepEqual(kinds.slice(0, 3), ["Title", "Heading 1", "Heading 2"], "a subtitle goes only right under the title");
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

const EDITED = "# Plan\n\nWhy.\n\n## Goals ##\n\n| a | b |\n|---|---|\n| c | d |\n\n## Costs\n";

test("Save on an unchanged heading keeps its text exactly", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(EDITED);
    await page.goto(`${base}/r/${id}`);
    await page.getByRole("button", { name: "Edit Heading 1 “Goals”" }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Edit Heading 1 “Goals”" }).waitFor();
    assert.match(hoop.markdownOf(id), /\n## Goals ##\n/);
  }),
);

test("heading words that start with # stay a heading at its level", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(EDITED);
    await page.goto(`${base}/r/${id}`);
    await page.getByRole("button", { name: "Edit Heading 1 “Costs”" }).click();
    await page.getByLabel("Text of Heading 1 “Costs”").fill("#1 priority");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Edit Heading 1 “#1 priority”" }).waitFor();
    assert.match(hoop.markdownOf(id), /\n## #1 priority\n$/);
  }),
);

test("a table's toolbar has only inline buttons, and Bold across its rows keeps it a table", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(EDITED);
    await page.goto(`${base}/r/${id}`);
    await page.getByRole("button", { name: "Edit Table 4" }).click();
    const tools = page.getByRole("group", { name: "Formatting for Table 4" }).getByRole("button");
    assert.deepEqual(await tools.allInnerTexts(), ["Bold", "Italic", "Link", "Code"]);
    const box = page.getByLabel("Text of Table 4");
    await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, el.value.length));
    await page.getByRole("button", { name: "Bold in Table 4" }).click();
    const text = await box.inputValue();
    assert.equal(text, "| **a** | **b** |\n|---|---|\n| **c** | **d** |", "the page formats a table cell by cell");
    assert.deepEqual(
      splitBlocks(text).blocks.map((b) => b.kind),
      ["table"],
    );
  }),
);

test("Bold, Italic and Link have their shortcut in their title and aria-keyshortcuts", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(EDITED);
    await page.goto(`${base}/r/${id}`);
    const mac = /Mac|iPhone|iPad/.test(await page.evaluate(() => navigator.platform));
    await page.getByRole("button", { name: "Edit Paragraph 2" }).click();
    const group = page.getByRole("group", { name: "Formatting for Paragraph 2" });
    const shown = await group.getByRole("button").evaluateAll((els) => els.map((el) => [el.getAttribute("title"), el.getAttribute("aria-keyshortcuts")]));
    const [mod, key] = mac ? ["Cmd", "Meta"] : ["Ctrl", "Control"];
    assert.deepEqual(shown.slice(0, 3), [
      [`Bold (${mod}+B)`, `${key}+B`],
      [`Italic (${mod}+I)`, `${key}+I`],
      [`Link (${mod}+K)`, `${key}+K`],
    ]);
    assert.deepEqual(shown[3], ["Bulleted list", null]);
  }),
);

test("Mod+B, Mod+I and Mod+K format in the text box, with Cmd alone on a Mac, and nowhere else", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ hoop, base, page }) => {
    const { review_id: id } = hoop.startBuild(EDITED);
    await page.goto(`${base}/r/${id}`);
    const mac = /Mac|iPhone|iPad/.test(await page.evaluate(() => navigator.platform));
    const [mod, other] = mac ? ["Meta", "Control"] : ["Control", "Meta"];
    await page.getByRole("button", { name: "Edit Paragraph 2" }).click();
    const box = page.getByLabel("Text of Paragraph 2");
    await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 3));
    await page.keyboard.press(`${mod}+b`);
    assert.equal(await box.inputValue(), "**Why**.");
    await page.keyboard.press(`${mod}+i`);
    assert.equal(await box.inputValue(), "***Why***.");
    await page.keyboard.press(`${mod}+k`);
    const linked = "***[Why](https://)***.";
    assert.equal(await box.inputValue(), linked);
    await page.keyboard.press(`${other}+b`);
    assert.equal(await box.inputValue(), linked, `${other}+B is not the shortcut here`);
    // Outside the text box, on its toolbar, the shortcut does nothing.
    await page.getByRole("button", { name: "Italic in Paragraph 2" }).focus();
    await page.keyboard.press(`${mod}+b`);
    assert.equal(await box.inputValue(), linked);
  }),
);
