import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// The supply-chain rules for the workflows (workflows/ci.yml, workflows/release.yml, workflows/security.yml),
// which code scanning and Scorecard check (#212): every action is pinned to a full commit SHA with
// its tag in a comment, a checkout never leaves its credentials in the workspace, and nothing is
// installed globally by name, where no lockfile pins what arrives.
const DIR = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(DIR)
  .filter((f) => f.endsWith(".yml"))
  .map((name) => ({ name, lines: readFileSync(new URL(name, DIR), "utf8").split("\n") }));

test("there are workflows to check", () => {
  assert.deepEqual(
    workflows.map((w) => w.name),
    ["ci.yml", "release.yml", "security.yml"],
  );
});

test("every action a workflow uses is pinned to a full commit SHA, with its tag in a comment", () => {
  const loose = workflows.flatMap(({ name, lines }) =>
    lines
      .map((line, i) => ({ line: line.trim(), at: `${name}:${i + 1}` }))
      .filter(({ line }) => /^(?:- )?uses:/.test(line))
      .filter(({ line }) => !/^(?:- )?uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(?:\.\d+)*$/.test(line))
      .map(({ line, at }) => `${at}: ${line}`),
  );
  assert.deepEqual(loose, []);
});

test("every checkout sets persist-credentials: false", () => {
  const kept = workflows.flatMap(({ name, lines }) =>
    lines.flatMap((line, i) => {
      if (!/uses: actions\/checkout@/.test(line)) return [];
      // The step's own lines: those indented past its "- uses:", up to the next step.
      const indent = line.indexOf("-");
      const step: string[] = [];
      for (const next of lines.slice(i + 1)) {
        if (next.trim() && next.search(/\S/) <= indent) break;
        step.push(next.trim());
      }
      return step.includes("persist-credentials: false") ? [] : [`${name}:${i + 1}`];
    }),
  );
  assert.deepEqual(kept, []);
});

test("no workflow installs a package globally by name", () => {
  const adhoc = workflows.flatMap(({ name, lines }) =>
    lines.flatMap((line, i) => (/\bnpm (?:install|i) (?:-g|--global)\b/.test(line) ? [`${name}:${i + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(adhoc, []);
});

test("the release's npm is checked against a pinned integrity before it runs", () => {
  const release = readFileSync(new URL("release.yml", DIR), "utf8");
  assert.match(release, /INTEGRITY: sha512-[A-Za-z0-9+/]{86}==/);
  assert.match(release, /if \[ "\$actual" != "\$INTEGRITY" \]; then/);
  assert.match(release, /node "\$RUNNER_TEMP\/npm\/bin\/npm-cli\.js" stage publish --access public/);
});
