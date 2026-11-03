import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// The supply-chain rules for the workflows (workflows/ci.yml, workflows/release.yml, workflows/security.yml),
// which code scanning and Scorecard check (#212): every action is pinned to a full commit SHA with
// its tag in a comment, a checkout never leaves its credentials in the workspace, nothing is
// installed globally by name, where no lockfile pins what arrives, and the release runs npm only
// from a tarball it checked against a pinned integrity. Each rule is a function over the file's
// text, tested on the real workflows and on the bad forms it must catch.
const DIR = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((name) => ({ name, text: readFileSync(new URL(name, DIR), "utf8") }));
const release = workflows.find((w) => w.name === "release.yml")!.text;

/** The lines that run or configure something, by line number: comments and blank lines left out. */
const live = (text: string) =>
  text
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line && !line.startsWith("#"));

/** The `uses:` lines not pinned to a full commit SHA with a version tag in a comment. */
const unpinned = (text: string) =>
  live(text)
    .filter(({ line }) => /^(?:- )?uses:/.test(line))
    .filter(({ line }) => !/^(?:- )?uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(?:\.\d+)*$/.test(line))
    .map(({ n }) => n);

/** The checkouts, by line, whose step doesn't set persist-credentials: false. */
function keptCredentials(text: string) {
  const lines = text.split("\n");
  return lines.flatMap((line, i) => {
    if (!/uses: actions\/checkout@/.test(line)) return [];
    // The step's own lines: those indented past its "- uses:", up to the next step.
    const indent = line.indexOf("-");
    const step: string[] = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() && next.search(/\S/) <= indent) break;
      step.push(next.trim());
    }
    return step.includes("persist-credentials: false") ? [] : [i + 1];
  });
}

/** Lines that install a package globally: an install verb and a global flag, in any order. */
const globalInstalls = (text: string) =>
  live(text)
    .filter(({ line }) => /(?:^|[\s;&|])(?:npm|pnpm|yarn)\s/.test(line))
    .filter(({ line }) => /(?:^|\s)(?:install|i|in|add)(?=\s|$)/.test(line))
    .filter(({ line }) => /(?:^|\s)(?:-g|--global|--location[= ]global)(?=\s|$)/.test(line))
    .map(({ n }) => n);

/** Lines that run npx, which can fetch and run a package the lockfile doesn't pin. */
const npxRuns = (text: string) =>
  live(text)
    .filter(({ line }) => /(?:^|[\s;&|:])npx(?=\s|$)/.test(line))
    .map(({ n }) => n);

const PUBLISH = 'node "$RUNNER_TEMP/npm/bin/npm-cli.js" stage publish --access public';

/** What is wrong with how the release gets and runs its npm, in words. */
function releaseNpmProblems(text: string): string[] {
  const out: string[] = [];
  const lines = live(text);
  if (!/^INTEGRITY: sha512-[A-Za-z0-9+/]{86}==$/m.test(lines.map((l) => l.line).join("\n"))) out.push("no pinned sha512 integrity");
  const check = lines.findIndex(({ line }) => line === 'if [ "$actual" != "$INTEGRITY" ]; then');
  const end = lines.findIndex(({ line }, i) => i > check && line === "fi");
  if (check < 0 || end < 0) out.push("no integrity check");
  else if (!lines.slice(check + 1, end).some(({ line }) => line === "exit 1")) out.push("a mismatch doesn't exit 1");
  const publishes = lines.filter(({ line }) => /\bstage publish\b/.test(line));
  if (publishes.length !== 1 || !publishes[0]!.line.endsWith(PUBLISH)) out.push("something other than the checked npm runs stage publish");
  const publish = publishes[0]?.n ?? -1;
  if (check < 0 || publish < 0 || lines[check]!.n > publish) out.push("the integrity check doesn't come before the publish");
  return out;
}

test("there are workflows to check, .yml and .yaml alike", () => {
  assert.deepEqual(
    workflows.map((w) => w.name),
    ["ci.yml", "release.yml", "security.yml"],
  );
  assert.ok(/\.ya?ml$/.test("deploy.yaml"));
});

test("every action a workflow uses is pinned to a full commit SHA, with its tag in a comment", () => {
  assert.deepEqual(
    workflows.flatMap(({ name, text }) => unpinned(text).map((n) => `${name}:${n}`)),
    [],
  );
  for (const bad of [
    "      - uses: actions/checkout@v7",
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "      - uses: actions/checkout@3d3c42e # v7.0.1",
  ])
    assert.deepEqual(unpinned(bad), [1], bad);
});

test("every checkout sets persist-credentials: false", () => {
  assert.deepEqual(
    workflows.flatMap(({ name, text }) => keptCredentials(text).map((n) => `${name}:${n}`)),
    [],
  );
  const step = (withLines: string) => `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n${withLines}      - run: npm ci\n`;
  assert.deepEqual(keptCredentials(step("")), [1], "a checkout with no with: block");
  assert.deepEqual(keptCredentials(step("        with:\n          fetch-depth: 2\n")), [1], "a with: block without it");
  assert.deepEqual(keptCredentials(step("        with:\n          persist-credentials: false\n")), []);
});

test("no workflow installs a package globally by name", () => {
  assert.deepEqual(
    workflows.flatMap(({ name, text }) => globalInstalls(text).map((n) => `${name}:${n}`)),
    [],
  );
  for (const bad of [
    "- run: npm install -g npm@11.21.0",
    "- run: npm i --global npm",
    "- run: npm install npm@11 -g",
    "- run: npm install -D -g npm",
    "- run: npm add -g npm",
    "- run: npm in -g npm",
    "- run: npm install --location=global npm",
    "- run: npm install --location global npm",
    "- run: npm ci && npm install -g npm",
  ])
    assert.deepEqual(globalInstalls(bad), [1], bad);
  assert.deepEqual(globalInstalls("- run: npm ci\n# npm install -g npm is gone"), [], "a comment isn't an install");
});

test("the release runs no npx", () => {
  assert.deepEqual(npxRuns(release), []);
  for (const bad of ["- run: npx -y npm@11.21.0 stage publish", "- run: npx tsx scripts/e2e-local.ts", "  run: npm ci && npx publint"])
    assert.deepEqual(npxRuns(bad), [1], bad);
});

test("the release's npm is checked against a pinned integrity before it runs stage publish, and only that npm does", () => {
  assert.deepEqual(releaseNpmProblems(release), []);
  const mutations: [string, string, string][] = [
    ["no pinned sha512 integrity", /INTEGRITY: sha512-\S+/.exec(release)![0], "INTEGRITY: sha512-short=="],
    [
      "a mismatch doesn't exit 1",
      "            echo \"::error::npm's tarball doesn't match its pinned integrity\"\n            exit 1\n",
      "            echo \"::error::npm's tarball doesn't match its pinned integrity\"\n",
    ],
    ["something other than the checked npm runs stage publish", PUBLISH, "npm stage publish --access public"],
    [
      "something other than the checked npm runs stage publish",
      `      - run: ${PUBLISH}\n`,
      `      - run: ${PUBLISH}\n      - run: npm stage publish --access public\n`,
    ],
  ];
  for (const [problem, from, to] of mutations) {
    assert.ok(release.includes(from), `the release has ${JSON.stringify(from.slice(0, 40))}`);
    assert.ok(releaseNpmProblems(release.replace(from, to)).includes(problem), problem);
  }
  // The publish moved above the integrity check.
  const publishLine = `      - run: ${PUBLISH}\n`;
  const checkStep = "      - name: Fetch npm 11.21.0 and check its integrity\n";
  assert.ok(release.includes(publishLine) && release.includes(checkStep));
  const moved = release.replace(publishLine, "").replace(checkStep, publishLine + checkStep);
  assert.ok(releaseNpmProblems(moved).includes("the integrity check doesn't come before the publish"));
});
