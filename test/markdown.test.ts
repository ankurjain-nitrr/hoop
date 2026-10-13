import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { itemLines, validateReview } from "../src/contract.js";
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

test("any markdown becomes a review: title, intro, sections by heading, lines by paragraph or list item", () => {
  const doc = parseMarkdown(POLICY);
  assert.equal(validateReview(doc).ok, true, JSON.stringify(validateReview(doc)));
  assert.equal(doc.kind, "doc");
  assert.equal(doc.title, "Remote work policy");
  assert.equal(doc.slug, "remote-work-policy");
  assert.equal(doc.tldr, "Employees may work remotely up to three days a week, with their manager's agreement.");
  assert.deepEqual(doc.items.map((i) => [i.id, i.title, i.level]), [
    ["S-0", "Introduction", 0], ["S-1", "Eligibility", 2], ["S-2", "Equipment", 2], ["S-3", "Expenses", 3],
  ]);
  assert.deepEqual(itemLines(doc.items[1]!), [
    "All permanent staff are eligible after their probation period.", "- Contractors follow their contract.", "- Interns work on site.",
  ]);
  assert.deepEqual(itemLines(doc.items[3]!), ["Home office costs up to 300 EUR a year are reimbursed.", "```", "claim code: HOME-1", "```"]);
});

test("export gives clean markdown back, and parsing it again gives the same review", () => {
  const doc = parseMarkdown(POLICY);
  const md = exportMarkdown(doc);
  assert.doesNotMatch(md, /S-\d/);
  assert.match(md, /## Eligibility\n\nAll permanent staff are eligible after their probation period.\n\n- Contractors follow their contract.\n- Interns work on site./);
  assert.match(md, /### Expenses\n\nHome office costs up to 300 EUR a year are reimbursed.\n\n```\nclaim code: HOME-1\n```/);
  assert.deepEqual(parseMarkdown(md), doc);
});

test("a document without headings is one untitled section; an explicit title and TL;DR win", () => {
  const doc = parseMarkdown("Dear team,\n\nWe move offices on Friday.", { title: "Office move", tldr: "Move on Friday" });
  assert.equal(doc.title, "Office move");
  assert.equal(doc.tldr, "Move on Friday");
  assert.deepEqual(doc.items.map((i) => [i.id, i.level, itemLines(i).length]), [["S-0", 0, 2]]);
});

test("an approved document is written back as clean markdown with the accepted edits in it", () => {
  const repo = tempHome();
  process.env.HOOP_REPO_DIR = repo;
  const hoop = new Hoop(new Store(tempHome()));
  const { review_id } = hoop.submit(parseMarkdown(POLICY));
  const t = hoop.review(review_id, { verdict: "comment", comments: [{ item: "S-0", line: 1, body: "two days, not three" }] }).comments[0]!.thread!;
  const { proposals } = hoop.proposeEdits(review_id, t, [{ item: "S-0", line: 1, find: "three days", replace: "two days" }]);
  hoop.decideEdit(review_id, proposals[0]!.id, "accept");
  hoop.review(review_id, { verdict: "approved" });
  const md = readFileSync(join(repo, "decisions", "remote-work-policy.md"), "utf8");
  assert.equal(md, exportMarkdown(parseMarkdown(POLICY)).replace("three days", "two days"));
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
