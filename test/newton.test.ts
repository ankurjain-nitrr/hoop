import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NEWTON = resolve("newton/bin/newton");

/** Runs newton through a link on PATH, with a fake `claude` that prints its arguments and todo setting. */
function newton(args: string[], installed = true, asClaude = false) {
  const dir = mkdtempSync(join(tmpdir(), "hoop-newton-"));
  const bin = join(dir, "bin");
  const plugins = join(dir, "claude", "plugins");
  mkdirSync(bin);
  mkdirSync(plugins, { recursive: true });
  writeFileSync(join(plugins, "known_marketplaces.json"), installed ? `{"hoop":{}}` : "{}");
  writeFileSync(join(plugins, "installed_plugins.json"), installed ? `{"plugins":{"hoop@hoop":[]}}` : "{}");
  const fake = join(bin, "claude");
  writeFileSync(fake, `#!/bin/sh\necho "todo=$CLAUDE_CODE_ENABLE_TODO_TOOLS args=$*"\n`);
  chmodSync(fake, 0o755);
  symlinkSync(NEWTON, join(bin, "newton"));
  // Ahead of the real claude on PATH: newton linked as claude, and a copy of it named claude.
  const ahead = join(dir, "ahead");
  mkdirSync(ahead);
  if (asClaude) {
    symlinkSync(NEWTON, join(ahead, "claude"));
    mkdirSync(join(dir, "copy"));
    copyFileSync(NEWTON, join(dir, "copy", "claude"));
    chmodSync(join(dir, "copy", "claude"), 0o755);
  }
  const path = asClaude ? `${ahead}:${join(dir, "copy")}:${bin}:/usr/bin:/bin` : `${bin}:/usr/bin:/bin`;
  const env = { ...process.env, PATH: path, CLAUDE_CONFIG_DIR: join(dir, "claude"), NEWTON_CLAUDE: "", CLAUDE_CODE_ENABLE_TODO_TOOLS: "" };
  return spawnSync(join(asClaude ? ahead : bin, asClaude ? "claude" : "newton"), args, { env, encoding: "utf8", timeout: 10_000 });
}

test("newton starts claude with Chrome, its settings and the todo tools, passing arguments through", () => {
  const run = newton(["-p", "hello"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), `todo=1 args=--chrome --settings ${resolve("newton/settings.json")} -p hello`);
  assert.equal(run.stderr, "", "nothing is installed when hoop already is");
});

test("newton's settings turn on hoop and the todo tools", () => {
  const settings = JSON.parse(readFileSync("newton/settings.json", "utf8"));
  assert.equal(settings.enabledPlugins["hoop@hoop"], true);
  assert.equal(settings.env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
});

test("claude's own commands run without the session flags", () => {
  const run = newton(["plugin", "list"]);
  assert.equal(run.stdout.trim(), "todo=1 args=plugin list");
});

test("newton installs the hoop plugin first when it's missing", () => {
  const run = newton(["--version"], false);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stderr.trim().split("\n"), [
    "newton: installing the hoop plugin...",
    "todo=1 args=plugin marketplace add ankurjain-nitrr/hoop",
    "todo=1 args=plugin install hoop@hoop",
  ]);
});

test("linked or copied as claude, newton runs the real claude, not itself", () => {
  const run = newton(["-p", "hi"], true, true);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout.trim(), /^todo=1 args=--chrome --settings \S+ -p hi$/);
});
