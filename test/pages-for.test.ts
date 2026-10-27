import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpClient, pagesFor, pagesOn, tempHome } from "./helpers.js";

test("regression #307: a test's pages process refuses a port another store's pages process holds", async () => {
  const taken = await pagesFor(tempHome());
  await assert.rejects(pagesOn(tempHome(), Number(taken.HOOP_PORT)), /serves another hoop store/);
});

test("a session's writes reach the pages process pagesFor started for its folder", async () => {
  const mcp = await mcpClient(await pagesFor(tempHome()));
  try {
    const res = await mcp.call("hoop_submit", { markdown: "# Rename the flag\n\nIt reads better.\n" });
    assert.equal(res.isError, false, JSON.stringify(res.value));
  } finally {
    await mcp.close();
  }
});
