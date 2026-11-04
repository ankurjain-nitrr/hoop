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

// Regressions: claims a review found wrong. There is no `hoop --version`; hoop reaches the network
// through `npm view` and the plugin's `npx` too; 0.1.0 was published by hand; and a verdict from any
// local process counts, so "only people approve" isn't a boundary SECURITY.md can promise.
test("SECURITY.md claims only what hoop does", () => {
  const policy = read("SECURITY.md");
  assert.doesNotMatch(policy, /hoop --version/);
  assert.match(policy, /npm ls -g @ankurjain-nitrr\/hoop/);
  for (const network of ["Mermaid", "`gh`", "`npm view`", "`npx -y @ankurjain-nitrr/hoop@<version>`"]) assert.ok(policy.includes(network), network);
  assert.match(policy, /Every release since 0\.1\.1/);
  assert.doesNotMatch(policy, /Only people approve/);
  assert.match(policy, /trusts the local processes that run as you/);
  assert.match(policy, /guards against other web pages and other machines/);
});

test("the README's Security section points to SECURITY.md instead of repeating it", () => {
  const section = read("README.md").split("\n## Security\n")[1]!.split("\n## ")[0]!;
  assert.match(section, /\[`SECURITY\.md`\]\(SECURITY\.md\)/);
  assert.doesNotMatch(section, /advisories\/new/);
});
