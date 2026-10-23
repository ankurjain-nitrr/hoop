import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { schemaFiles, withTables } from "../scripts/schemas.js";

test("the published schemas and the field tables in docs/FORMATS.md match the contract", () => {
  for (const [path, text] of Object.entries(schemaFiles()))
    assert.equal(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), text, `${path} is out of date; run npx tsx scripts/schemas.ts`);
  const formats = readFileSync(new URL("../docs/FORMATS.md", import.meta.url), "utf8");
  assert.equal(formats, withTables(formats), "the field tables in docs/FORMATS.md are out of date; run npx tsx scripts/schemas.ts");
  for (const name of ["review", "item", "feedback", "comment"])
    assert.ok(formats.includes(`<!-- fields:${name} -->`), `docs/FORMATS.md has the ${name} field table`);
});
