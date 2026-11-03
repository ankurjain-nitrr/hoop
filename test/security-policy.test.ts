import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// SECURITY.md is the one place that says how to report a vulnerability (#212); the README points to it.
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("SECURITY.md says to report privately through GitHub's private vulnerability reporting", () => {
  const policy = read("SECURITY.md");
  assert.match(policy, /\(https:\/\/github\.com\/ankurjain-nitrr\/hoop\/security\/advisories\/new\)/);
  assert.match(policy, /not in a public issue/);
  for (const heading of ["## Reporting a vulnerability", "## Supported versions", "## What hoop guards"]) assert.ok(policy.includes(`\n${heading}\n`), heading);
});

test("the README's Security section points to SECURITY.md instead of repeating it", () => {
  const section = read("README.md").split("\n## Security\n")[1]!.split("\n## ")[0]!;
  assert.match(section, /\[`SECURITY\.md`\]\(SECURITY\.md\)/);
  assert.doesNotMatch(section, /advisories\/new/);
});
