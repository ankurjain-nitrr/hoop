import { test } from "node:test";
import assert from "node:assert/strict";
import { codeDetail } from "../src/detail.js";
import { parseMarkdown } from "../src/markdown.js";
import { mcpClient, pagesFor, tempHome } from "./helpers.js";

const PATHS = `# Split the export into three pull requests

Three pull requests ship the export.

## PR 1

- Add \`src/export.ts\` with \`writeCsv()\` (120 lines)
- Change \`src/ops.ts:88\` to register it
- Test it in test/export.test.ts:12
- Ship on Monday
`;

const PROSE = `# Ship the order export on Monday

Customers download their orders as CSV.

## Behaviour

- A customer downloads every order from the last year in one file.
- The file opens in a spreadsheet with one row per order.
- An empty history gives a file with only the header row.
`;

test("a document whose list items are mostly code paths gets a warning naming a few of them", () => {
  const warning = codeDetail(parseMarkdown(PATHS));
  assert.ok(warning);
  assert.match(warning, /^3 of this document's 4 list items name code, such as `src\/export\.ts`, `writeCsv\(\)`, `src\/ops\.ts:88`\./);
  assert.match(warning, /belong in the pull requests/);
});

test("a prose document, and one with too few list items to judge, get no warning", () => {
  assert.equal(codeDetail(parseMarkdown(PROSE)), undefined);
  assert.equal(codeDetail(parseMarkdown("# Rename the flag\n\nIt reads better.\n\n- Rename `src/flag.ts`\n- Keep the alias\n")), undefined);
});

test("hoop_submit carries the warning and still submits the document", async () => {
  const mcp = await mcpClient(await pagesFor(tempHome()));
  try {
    const paths = await mcp.call("hoop_submit", { markdown: PATHS });
    assert.equal(paths.isError, false, JSON.stringify(paths.value));
    assert.ok(paths.value.review_id);
    assert.equal(paths.value.warnings.length, 1);
    assert.match(paths.value.warnings[0], /name code/);
    const prose = await mcp.call("hoop_submit", { markdown: PROSE });
    assert.equal(prose.isError, false, JSON.stringify(prose.value));
    assert.equal(prose.value.warnings, undefined);
  } finally {
    await mcp.close();
  }
});
