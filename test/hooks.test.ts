import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error: a plain script, without types.
import { checkEnv, testsFor } from "../scripts/pre-push.mjs";

const root = new URL("..", import.meta.url).pathname;
// A git hook sets GIT_DIR, GIT_INDEX_FILE and the like; passed on, they point git in these tests at
// the repository running the hook, which once set core.bare there and staged src/broken.ts in it.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", env });

test("hook setup runs only in a contributor's own clone", () => {
  const { CI: _ci, ...noCi } = env;
  const clone = mkdtempSync(join(tmpdir(), "hoop-hooks-clone-"));
  git(clone, "init", "-q");
  mkdirSync(join(clone, "scripts"));
  mkdirSync(join(clone, ".githooks"));
  copyFileSync(join(root, "scripts/setup-hooks.mjs"), join(clone, "scripts/setup-hooks.mjs"));
  const setup = (initCwd: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(clone, "scripts/setup-hooks.mjs")], { env: { ...noCi, INIT_CWD: initCwd, ...extra } });

  setup(clone, { CI: "true" });
  assert.equal(git(clone, "config", "core.hooksPath").stdout.trim(), "", "CI, publishing included, sets up nothing");
  setup(tmpdir());
  assert.equal(git(clone, "config", "core.hooksPath").stdout.trim(), "", "an install from another folder sets up nothing");
  setup(clone);
  assert.equal(git(clone, "config", "core.hooksPath").stdout.trim(), ".githooks");

  const installed = mkdtempSync(join(tmpdir(), "hoop-hooks-installed-"));
  mkdirSync(join(installed, "scripts"));
  copyFileSync(join(root, "scripts/setup-hooks.mjs"), join(installed, "scripts/setup-hooks.mjs"));
  assert.equal(spawnSync(process.execPath, [join(installed, "scripts/setup-hooks.mjs")], { env: { ...noCi, INIT_CWD: installed } }).status, 0);
});

test("the commit hook refuses a type error", { timeout: 120_000 }, () => {
  const tree = mkdtempSync(join(tmpdir(), "hoop-hooks-tree-"));
  rmSync(tree, { recursive: true });
  assert.equal(git(root, "worktree", "add", "--detach", tree, "HEAD").status, 0);
  try {
    symlinkSync(join(root, "node_modules"), join(tree, "node_modules"));
    copyFileSync(join(root, ".githooks/pre-commit"), join(tree, "pre-commit"));
    writeFileSync(join(tree, "src/broken.ts"), 'export const n: number = "not a number";\n');
    git(tree, "add", "src/broken.ts");
    const r = spawnSync("sh", [join(tree, "pre-commit")], { cwd: tree, encoding: "utf8", env });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /broken\.ts/);
  } finally {
    git(root, "worktree", "remove", "--force", tree);
    rmSync(tree, { recursive: true, force: true });
    // The broken file belongs only in the temporary tree; never leave it in this checkout.
    if (existsSync(join(root, "src/broken.ts"))) {
      git(root, "rm", "-q", "--cached", "--ignore-unmatch", "src/broken.ts");
      rmSync(join(root, "src/broken.ts"), { force: true });
    }
  }
});

test("the push hook refuses when the checks fail", () => {
  const bin = mkdtempSync(join(tmpdir(), "hoop-hooks-bin-"));
  writeFileSync(join(bin, "npm"), "#!/bin/sh\necho failing check >&2\nexit 1\n");
  chmodSync(join(bin, "npm"), 0o755);
  const r = spawnSync("sh", [join(root, ".githooks/pre-push")], { cwd: root, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /failing check/);
});

const tests = {
  "test/store.test.ts": 'import { Store } from "../src/store.js";',
  "test/web.test.ts": 'import { createWebServer } from "../src/web.js";\nreadFileSync("web/app.js");',
  "test/cli.test.ts": 'import { cli, tsx } from "./helpers.js";',
  "test/wait.test.ts": 'import { example, hoopArgs } from "./helpers.js";',
  "test/interface.test.ts": 'new URL("./fixtures/interface.json", import.meta.url);',
  "test/build.test.ts": 'new URL("./fixtures/docs/", import.meta.url);',
  "test/blocks.test.ts": 'join(root, "README.md")',
};

test("the push hook runs the tests that name what the branch changed", () => {
  assert.deepEqual(testsFor(["src/store.ts"], tests), ["test/store.test.ts"]);
  assert.deepEqual(testsFor(["web/app.js"], tests), ["test/web.test.ts"]);
  assert.deepEqual(testsFor(["src/cli.ts"], tests), ["test/cli.test.ts", "test/wait.test.ts"]);
  assert.deepEqual(testsFor(["test/fixtures/interface.json"], tests), ["test/interface.test.ts"]);
  assert.deepEqual(testsFor(["test/fixtures/docs/tables.md"], tests), ["test/build.test.ts"]);
  assert.deepEqual(testsFor(["README.md"], tests), ["test/blocks.test.ts"]);
  assert.deepEqual(testsFor(["test/build.test.ts", "docs/notes.txt"], tests), ["test/build.test.ts"]);
  assert.deepEqual(testsFor([".github/workflows/ci.yml"], tests), []);
});

test("the push hook runs every test when the setup they share changes", () => {
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", "test/helpers.ts", "scripts/pre-push.mjs"])
    assert.deepEqual(testsFor([file], tests), Object.keys(tests), file);
});

test("the push hook's checks run without git's hook variables, so a test's git can't touch the pushing repo", () => {
  const env = checkEnv(
    { GIT_DIR: "/repo/.git", GIT_INDEX_FILE: "/repo/.git/index", GIT_WORK_TREE: "/repo", PATH: "/bin", GITHUB_TOKEN: "t" },
    { HOOP_TEST_BUILT: "1" },
  );
  assert.deepEqual(env, { PATH: "/bin", GITHUB_TOKEN: "t", HOOP_TEST_BUILT: "1" });
});
