import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findings } from "../scripts/comment-guard.js";

const root = new URL("..", import.meta.url).pathname;
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

test("FR-120: the comment guard refuses a comment that names a change request or a tracker item", () => {
  assert.deepEqual(findings("a.ts", "// Keeps the order (CR-3).\nconst x = 1;\n"), [{ line: 1, name: "CR-3" }]);
  assert.deepEqual(findings("a.ts", "/**\n * Built for T-2.\n */\nexport const x = 1;\n"), [{ line: 2, name: "T-2" }]);
  assert.deepEqual(findings("a.css", "a { color: red; }\n/* B-4: wide tables */\n"), [{ line: 2, name: "B-4" }]);
  assert.deepEqual(findings("a.js", 'const id = "CR-1"; // the first change\n'), []);
  assert.deepEqual(findings("a.ts", "// Covers FR-3 and D-12.\nconst x = 1;\n"), []);
});

test("FR-120: the whole code base passes the comment guard", () => {
  const r = spawnSync(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/comment-guard.ts")], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("FR-119: hook setup runs only in a contributor's own clone", () => {
  const clone = mkdtempSync(join(tmpdir(), "hoop-hooks-clone-"));
  git(clone, "init", "-q");
  mkdirSync(join(clone, "scripts"));
  mkdirSync(join(clone, ".githooks"));
  copyFileSync(join(root, "scripts/setup-hooks.mjs"), join(clone, "scripts/setup-hooks.mjs"));
  const setup = (initCwd: string) => spawnSync(process.execPath, [join(clone, "scripts/setup-hooks.mjs")], { env: { ...process.env, INIT_CWD: initCwd } });

  setup(tmpdir());
  assert.equal(git(clone, "config", "core.hooksPath").stdout.trim(), "", "an install from another folder sets up nothing");
  setup(clone);
  assert.equal(git(clone, "config", "core.hooksPath").stdout.trim(), ".githooks");

  const installed = mkdtempSync(join(tmpdir(), "hoop-hooks-installed-"));
  mkdirSync(join(installed, "scripts"));
  copyFileSync(join(root, "scripts/setup-hooks.mjs"), join(installed, "scripts/setup-hooks.mjs"));
  assert.equal(spawnSync(process.execPath, [join(installed, "scripts/setup-hooks.mjs")], { env: { ...process.env, INIT_CWD: installed } }).status, 0);
});

test("FR-119: the commit hook refuses a type error", { timeout: 120_000 }, () => {
  const tree = mkdtempSync(join(tmpdir(), "hoop-hooks-tree-"));
  rmSync(tree, { recursive: true });
  assert.equal(git(root, "worktree", "add", "--detach", tree, "HEAD").status, 0);
  try {
    symlinkSync(join(root, "node_modules"), join(tree, "node_modules"));
    copyFileSync(join(root, ".githooks/pre-commit"), join(tree, "pre-commit"));
    writeFileSync(join(tree, "src/broken.ts"), 'export const n: number = "not a number";\n');
    git(tree, "add", "src/broken.ts");
    const r = spawnSync("sh", [join(tree, "pre-commit")], { cwd: tree, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /broken\.ts/);
  } finally {
    git(root, "worktree", "remove", "--force", tree);
  }
});

test("FR-121: the push hook refuses when the tests fail", () => {
  const bin = mkdtempSync(join(tmpdir(), "hoop-hooks-bin-"));
  writeFileSync(join(bin, "npm"), "#!/bin/sh\necho failing test >&2\nexit 1\n");
  chmodSync(join(bin, "npm"), 0o755);
  const r = spawnSync("sh", [join(root, ".githooks/pre-push")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /failing test/);
  assert.match(readFileSync(join(root, ".githooks/pre-push"), "utf8"), /npm test/);
});
