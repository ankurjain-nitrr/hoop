import { test } from "node:test";
import assert from "node:assert/strict";
import { itemLines, validateFeedback, validateReview } from "../src/contract.js";
import { Hoop } from "../src/hoop.js";
import { exportMarkdown, parseMarkdown } from "../src/markdown.js";
import { Store } from "../src/store.js";
import { mcpClient, tempHome } from "./helpers.js";

const POLICY = `# Remote work policy

Employees may work remotely up to three days a week,
with their manager's agreement.

## Eligibility

All permanent staff are eligible after their probation period.
- Contractors follow their contract.
- Interns work on site.

## Equipment

> The company provides a laptop and one monitor.

### Expenses

Home office costs up to 300 EUR a year are reimbursed.

\`\`\`
claim code: HOME-1
\`\`\`
`;

const J = " ";

test("any markdown becomes a review: title, intro, sections by heading, a line per block", () => {
  const doc = parseMarkdown(POLICY);
  assert.equal(validateReview(doc).ok, true, JSON.stringify(validateReview(doc)));
  assert.equal(doc.kind, "doc");
  assert.equal(doc.title, "Remote work policy");
  assert.equal(doc.slug, "remote-work-policy");
  assert.equal(doc.tldr, "Employees may work remotely up to three days a week, with their manager's agreement.");
  assert.equal(doc.tldr_auto, true);
  assert.deepEqual(
    doc.items.map((i) => [i.id, i.title, i.level]),
    [
      ["S-0", "Introduction", 0],
      ["S-1", "Eligibility", 2],
      ["S-2", "Equipment", 2],
      ["S-3", "Expenses", 3],
    ],
  );
  assert.deepEqual(itemLines(doc.items[0]!), [`Employees may work remotely up to three days a week,${J}with their manager's agreement.`]);
  assert.deepEqual(itemLines(doc.items[1]!), [
    "All permanent staff are eligible after their probation period.",
    "- Contractors follow their contract.",
    "- Interns work on site.",
  ]);
  assert.deepEqual(itemLines(doc.items[3]!), ["Home office costs up to 300 EUR a year are reimbursed.", `\`\`\`${J}claim code: HOME-1${J}\`\`\``]);
});

const TRICKY = `# Field guide

## Using C#

**Note:** this paragraph
wraps onto a second line.
Hard break here  
and after it.

- first item
  wraps here
  - nested item
1. numbered

| a | b |
|---|---|
| 1 | 2 |

    indented code
    more code

\`\`\`js
const a = 1;

const b = 2;
## not a heading
\`\`\`

---

> quoted line
`;

test("export of an unedited document is byte-identical to its source", () => {
  for (const md of [POLICY, TRICKY]) {
    const doc = parseMarkdown(md);
    assert.equal(validateReview(doc).ok, true);
    assert.equal(exportMarkdown(doc), md);
    assert.deepEqual(parseMarkdown(exportMarkdown(doc)), doc);
  }
  const d = parseMarkdown(TRICKY);
  assert.deepEqual(
    d.items.map((i) => i.title),
    ["Using C#"],
  );
  const lines = itemLines(d.items[0]!);
  assert.equal(lines[0], `**Note:** this paragraph${J}wraps onto a second line.${J}Hard break here  ${J}and after it.`);
  assert.equal(lines[1], `- first item${J}  wraps here`);
  assert.equal(lines[2], "- nested item");
  assert.ok(lines.some((l) => l.startsWith("```js") && l.includes(`const a = 1;${J}${J}const b = 2;${J}## not a heading`)));
});

test("setext headings become sections; an empty heading gets a placeholder title", () => {
  const doc = parseMarkdown("Plan\n====\n\nIntro.\n\nGoals\n-----\n\nShip it.\n\n##\n\nEnd.\n");
  assert.equal(doc.title, "Plan");
  assert.deepEqual(
    doc.items.map((i) => [i.title, i.level]),
    [
      ["Introduction", 0],
      ["Goals", 2],
      ["(untitled)", 2],
    ],
  );
  assert.equal(validateReview(doc).ok, true);
  assert.equal(exportMarkdown(doc), "# Plan\n\nIntro.\n\n## Goals\n\nShip it.\n\n## (untitled)\n\nEnd.\n");
});

test("a document without headings is one untitled section; an explicit title and TL;DR win", () => {
  const doc = parseMarkdown("Dear team,\n\nWe move offices on Friday.", { title: "Office move", tldr: "Move on Friday" });
  assert.equal(doc.title, "Office move");
  assert.equal(doc.tldr, "Move on Friday");
  assert.equal(doc.tldr_auto, undefined);
  assert.deepEqual(
    doc.items.map((i) => [i.id, i.level, itemLines(i).length]),
    [["S-0", 0, 2]],
  );
});

test("section IDs survive a revision that inserts a section, so heading comments keep their scope", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const v1 = "# Doc\n\n## Alpha\n\nA text.\n\n## Beta\n\nB text must stay.\n";
  const { review_id } = hoop.submit(parseMarkdown(v1));
  const beta = hoop.store.revision(review_id).items.find((i) => i.title === "Beta")!.id;
  const t = hoop.review(review_id, { verdict: "comment", comments: [{ item: beta, line: 0, body: "softer" }] }).comments[0]!.thread!;
  hoop.submit({ ...parseMarkdown("# Doc\n\n## New\n\nN text.\n\n## Alpha\n\nA text.\n\n## Beta\n\nB text must stay.\n"), review_id });
  const items = hoop.store.revision(review_id).items;
  assert.deepEqual(
    items.map((i) => [i.title, i.id]),
    [
      ["New", "S-3"],
      ["Alpha", "S-1"],
      ["Beta", "S-2"],
    ],
  );
  const { proposals } = hoop.proposeEdits(review_id, t, [{ item: beta, line: 1, find: "must stay", replace: "should stay" }]);
  assert.equal(proposals[0]!.item, "S-2");
  assert.throws(
    () => hoop.proposeEdits(review_id, t, [{ item: "S-1", line: 1, find: "A text", replace: "x" }]),
    (err: any) => err.errors[0].message.includes("covers section S-2"),
  );
});

test("an approved document exports as clean markdown with the accepted edits in it", () => {
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(parseMarkdown(POLICY));
  const t = hoop.review(review_id, { verdict: "comment", comments: [{ item: "S-0", line: 1, body: "two days, not three" }] }).comments[0]!.thread!;
  const { proposals } = hoop.proposeEdits(review_id, t, [{ item: "S-0", line: 1, find: "three days", replace: "two days" }]);
  assert.throws(() => hoop.proposeEdits(review_id, t, [{ item: "DOC", line: 2, find: "three", replace: "two" }]), /invalid edits/);
  hoop.decideEdit(review_id, proposals[0]!.id, "accept");
  hoop.review(review_id, { verdict: "approved" });
  assert.equal(exportMarkdown(hoop.store.revision(review_id)), POLICY.replace("three days", "two days"));
});

test("hoop_submit_markdown and hoop_export over MCP", async () => {
  const mcp = await mcpClient({ HOOP_HOME: tempHome() });
  try {
    const sub = await mcp.call("hoop_submit_markdown", { markdown: POLICY, tldr: "Remote work: who, how often, what we pay for" });
    assert.equal(sub.isError, false);
    const out = await mcp.call("hoop_export", { review_id: sub.value.review_id });
    assert.equal(out.value.markdown, exportMarkdown(parseMarkdown(POLICY, { tldr: "Remote work: who, how often, what we pay for" })));
    assert.equal(out.value.revision, 1);
  } finally {
    await mcp.close();
  }
});

// Blank lines around headings
const spaced = (n: number) => {
  const gap = "\n".repeat(n + 1);
  return `# Doc${gap}Intro.${gap}## One${gap}First.${gap}### Two${gap}- a\n- b${gap}## Three${gap}Last.\n`;
};

test("0, 1, 2 and 10 blank lines around headings export exactly", () => {
  for (const n of [0, 1, 2, 10]) {
    const md = spaced(n);
    const doc = parseMarkdown(md);
    assert.equal(doc.spacing, "exact");
    assert.equal(exportMarkdown(doc), md, `n=${n}`);
  }
  const lldStyle =
    "# hoop: LLD\n\nStatus: approved\n\n## Contract (`src/contract.ts`)\n- Responsibility: the shape.\n- Data model: zod.\n\n## Edit engine\n- Responsibility: one span.\n";
  assert.equal(exportMarkdown(parseMarkdown(lldStyle)), lldStyle);
});

test("blank lines don't change commentable lines or their numbers", () => {
  const tight = parseMarkdown(spaced(0)),
    loose = parseMarkdown(spaced(10));
  assert.deepEqual(
    tight.items.map((i) => itemLines(i)),
    loose.items.map((i) => itemLines(i)),
  );
  assert.deepEqual(
    tight.items.map((i) => i.id),
    loose.items.map((i) => i.id),
  );
});

test("a document stored before this change exports as it did", () => {
  const stored = parseMarkdown(spaced(1));
  delete (stored as { spacing?: string }).spacing;
  for (const item of stored.items) item.body = item.body?.replace(/^\n+|\n+$/g, "");
  assert.equal(exportMarkdown(stored), spaced(1));
  const tight = parseMarkdown(spaced(0));
  delete (tight as { spacing?: string }).spacing;
  assert.equal(exportMarkdown(tight), spaced(1)); // old layout: one blank line around headings
});

test("blank lines before the title, no title heading, and checks in exact documents", () => {
  assert.equal(exportMarkdown(parseMarkdown("\n\n# D\n\nx\n\n## A\nb\n")), "# D\n\nx\n\n## A\nb\n");
  const untitled = parseMarkdown("Just text\n\nmore\n");
  assert.equal(untitled.spacing, undefined);
  assert.equal(exportMarkdown(untitled), "# Untitled document\n\nJust text\n\nmore\n");
  const doc = parseMarkdown("# D\n\n## A\n\nb\n");
  doc.items[0]!.check = "reviewed";
  doc.items[0]!.choices = [{ id: "a", label: "yes" }];
  assert.equal(exportMarkdown(doc), "# D\n\n## A\n\nb\n\n_Check: reviewed_\n", "a section's options are its own list items, never written twice");
});

const ASK = [
  "# Plan",
  "",
  "## Question: Should approving save the text?",
  "",
  "It decides where the approved text lives.",
  "",
  "- A. Nothing is written (recommended)",
  "- B. Write back to the source file",
  "- C. Keep `decisions/`",
  "",
  "## Next steps",
  "",
  "- Ship the skill.",
  "- Close the old pull request.",
  "",
].join("\n");

test("a section headed Question: is answerable: its list items are the options, one marked (recommended)", () => {
  const doc = parseMarkdown(ASK);
  const [q, next] = doc.items;
  assert.deepEqual(q!.choices, [
    { id: "a", label: "Nothing is written", recommended: true },
    { id: "b", label: "Write back to the source file" },
    { id: "c", label: "Keep `decisions/`" },
  ]);
  assert.equal(next!.choices, undefined, "a list under any other heading stays a list");
  assert.equal(itemLines(q!).length, 4, "the options stay lines to comment on, and aren't added twice");
  assert.equal(exportMarkdown(doc), ASK, "the document exports byte for byte");
});

test("options without letters take a, b, c in order", () => {
  const doc = parseMarkdown("# Plan\n\n### Question: When do we ship?\n\n- Now\n- Next week\n");
  assert.deepEqual(
    doc.items[0]!.choices!.map((c) => [c.id, c.label]),
    [
      ["a", "Now"],
      ["b", "Next week"],
    ],
  );
});

test("an answer to a markdown question is checked against its options", () => {
  const doc = parseMarkdown(ASK);
  const fb = (choice: string) => ({
    schema: "hoop/feedback@0",
    review_id: "rv_1",
    revision: 1,
    reviewer: "priya",
    at: "2026-10-23T00:00:00.000Z",
    verdict: "comment",
    answers: [{ item: "S-1", choice }],
  });
  assert.equal(validateFeedback(fb("b"), doc).ok, true);
  assert.deepEqual(validateFeedback(fb("z"), doc), { ok: false, errors: [{ path: "answers.0", message: "S-1 has no choice z" }] });
});

test("an answer can be the reviewer's own words: choice other with text", () => {
  const doc = parseMarkdown(ASK);
  const fb = (answer: Record<string, string>) => ({
    schema: "hoop/feedback@0",
    review_id: "rv_1",
    revision: 1,
    reviewer: "priya",
    at: "2026-10-23T00:00:00.000Z",
    verdict: "comment",
    answers: [{ item: "S-1", ...answer }],
  });
  assert.equal(validateFeedback(fb({ choice: "other", text: "Save it next to the source file." }), doc).ok, true);
  assert.deepEqual(validateFeedback(fb({ choice: "other" }), doc), {
    ok: false,
    errors: [{ path: "answers.0.text", message: "write the answer, or pick one of S-1's options" }],
  });
});
