// The push hook: the type check, Biome, and the test files that name what this branch changed since
// it left main, without the browser, starting hoop from a fresh build rather than through tsx. CI
// runs the whole suite with the browser and blocks the merge, so a push stays quick. HOOP_FULL_PUSH=1
// runs the whole suite here instead.
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// A change to one of these can break any test, so it runs them all.
const EVERYTHING = /^(package(-lock)?\.json|tsconfig[^/]*\.json|test\/helpers\.ts|scripts\/pre-push\.mjs)$/;

/** The test files among `tests` ({path: text}) that a change to `changed` reaches. */
export function testsFor(changed, tests) {
  if (changed.some((f) => EVERYTHING.test(f))) return Object.keys(tests);
  const names = changed.flatMap(mentionsOf);
  return Object.keys(tests).filter((t) => changed.includes(t) || names.some((n) => (typeof n === "string" ? tests[t].includes(n) : n.test(tests[t]))));
}

/** How a test names a file: by its path from its folder, as a source or as its import; a fixture by its folder. */
function mentionsOf(file) {
  const parts = file.split("/");
  const name = parts.slice(-2).join("/");
  const found = [name, name.replace(/\.ts$/, ".js")];
  if (parts[0] === "test" && parts[1] === "fixtures") found.push(parts.slice(1, 3).join("/"));
  // Tests run the terminal commands through helpers' `hoopArgs` or `cli`.
  if (file === "src/cli.ts") found.push(/import \{[^}]*\b(cli|hoopArgs)\b[^}]*\} from "\.\/helpers\.js"/);
  return found;
}

function changedFiles() {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  let base;
  try {
    base = git("merge-base", "HEAD", "origin/main");
  } catch {
    return null;
  }
  return git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
}

/**
 * The environment for the checks: git runs this hook with GIT_DIR and the like set to the pushing
 * repository, and a test's own `git` would then commit to it, or set its core.bare.
 */
export function checkEnv(env, extra = {}) {
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("GIT_"))), ...extra };
}

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: checkEnv(process.env, env) });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run("npm", ["run", "--silent", "typecheck"]);
  run("npm", ["run", "--silent", "lint"]);
  // The tests start hoop from this build (HOOP_TEST_BUILT), which starts in half the time tsx takes.
  run("npm", ["run", "--silent", "build"]);
  const built = { HOOP_TEST_BUILT: "1" };
  const changed = process.env.HOOP_FULL_PUSH === "1" ? null : changedFiles();
  if (!changed) {
    run("npm", ["test"], built);
  } else {
    const dir = join(root, "test");
    const tests = Object.fromEntries(
      readdirSync(dir)
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => [`test/${f}`, readFileSync(join(dir, f), "utf8")]),
    );
    const files = testsFor(changed, tests);
    console.log(`hoop: ${files.length} of ${Object.keys(tests).length} test files, no browser; CI runs them all`);
    if (files.length) run(process.execPath, ["node_modules/tsx/dist/cli.mjs", "--test", ...files], { ...built, HOOP_SKIP_BROWSER: "1" });
  }
}
