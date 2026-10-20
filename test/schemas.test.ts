import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readmeWithTables, schemaFiles } from "../scripts/schemas.js";

test("FR-127: the published schemas and the README's field tables match the contract", () => {
  for (const [path, text] of Object.entries(schemaFiles()))
    assert.equal(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), text, `${path} is out of date; run npx tsx scripts/schemas.ts`);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.equal(readme, readmeWithTables(readme), "the README's field tables are out of date; run npx tsx scripts/schemas.ts");
  for (const name of ["review", "item", "feedback", "comment"]) assert.ok(readme.includes(`<!-- fields:${name} -->`), `the README has the ${name} field table`);
});
