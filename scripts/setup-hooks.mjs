// Points git at the hooks in .githooks, only in a contributor's own clone. An install of hoop as a
// tool, from npm or into another project's node_modules, sets up nothing, and neither does CI,
// including the release workflow's `npm ci` and `npm publish`.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function contributorClone() {
  if (process.env.CI) return false;
  if (!existsSync(join(root, ".git")) || !existsSync(join(root, ".githooks"))) return false;
  if (process.env.INIT_CWD && realpathSync(process.env.INIT_CWD) !== realpathSync(root)) return false;
  try {
    return realpathSync(git("rev-parse", "--show-toplevel")) === realpathSync(root);
  } catch {
    return false;
  }
}

if (contributorClone()) {
  git("config", "core.hooksPath", ".githooks");
  console.log("hoop: commit hooks set up from .githooks");
}
