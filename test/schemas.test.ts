import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { schemaFiles } from "../scripts/schemas.js";

test("the published schemas match the contract", () => {
  for (const [path, text] of Object.entries(schemaFiles()))
    assert.equal(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), text, `${path} is out of date; run npx tsx scripts/schemas.ts`);
});
