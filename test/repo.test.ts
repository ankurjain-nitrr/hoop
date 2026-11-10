import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return files(path);
    return [path];
  });
}

test("src/ and web/ write U+2028 as an escape, never as the raw character", () => {
  // A raw U+2028 inside a regex breaks the page module, and some editors turn the escape into it.
  const raw = [...files("src"), ...files("web")].filter((path) => readFileSync(join(root, path), "utf8").includes("\u2028"));
  assert.deepEqual(raw, [], "write the character as the escape \\u2028");
});

// dist/bin.js is the hoop command. dist/cli.js was until #212's Node check, and global installs
// linked then still point at it, so it stays executable too.
test("npm run build makes dist/bin.js, the hoop command, and dist/cli.js executable", { skip: process.platform === "win32" }, () => {
  const build: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.build;
  // The web modules' declarations are written first; then tsc compiles src, then the step under test.
  const steps = build.split(" && ");
  const at = steps.findIndex((s) => /^tsc /.test(s));
  assert.ok(at >= 0, build);
  const after = steps.slice(at + 1);
  assert.ok(after.length, "the build script runs a step after tsc");
  const dir = mkdtempSync(join(tmpdir(), "hoop-build-"));
  mkdirSync(join(dir, "dist"));
  for (const f of ["dist/bin.js", "dist/cli.js"]) writeFileSync(join(dir, f), "#!/usr/bin/env node\n", { mode: 0o644 });
  execSync(after.join(" && "), { cwd: dir, stdio: "ignore" });
  for (const f of ["dist/bin.js", "dist/cli.js"]) assert.equal(statSync(join(dir, f)).mode & 0o111, 0o111, f);
});
