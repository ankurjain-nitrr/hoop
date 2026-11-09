import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeBin, hoopCli, tsx } from "./helpers.js";
import { versions } from "../scripts/version.js";

const plugin = new URL("../plugins/hoop/", import.meta.url).pathname;
// The plugin runs the package of its own version, which is package.json's (scripts/version.ts).
const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const SPEC = `@ankurjain-nitrr/hoop@${VERSION}`;
const PATH = "/usr/bin:/bin";

/** A folder with stand-ins for commands: each records its arguments, one call per line, in `<name>.log`. */
function fakes(scripts: Record<string, string>) {
  const bin = mkdtempSync(join(tmpdir(), "hoop-plugin-bin-"));
  for (const [name, body] of Object.entries(scripts)) fakeBin(bin, name, `echo "$*" >> "${bin}/${name}.log"\n${body}`);
  const log = (name: string) => {
    try {
      return readFileSync(join(bin, `${name}.log`), "utf8")
        .trim()
        .split("\n");
    } catch {
      return [];
    }
  };
  return { bin, log };
}

const ALLOW = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"ok"}}`;
const env = (bin: string, extra: Record<string, string> = {}) => {
  const e: Record<string, string> = { ...(process.env as Record<string, string>), PATH: `${bin}:${PATH}`, ...extra };
  delete e.HOOP_BIN;
  delete e.HOOP_PLAN_WAIT_SECONDS;
  return e;
};

test("the plugin holds the MCP server and both hooks, and names the npx package in one place", () => {
  const mcp = JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.hoop, { command: "sh", args: ["$" + "{CLAUDE_PLUGIN_ROOT}/scripts/mcp.sh"] });
  const hooks = JSON.parse(readFileSync(join(plugin, "hooks/hooks.json"), "utf8")).hooks;
  assert.equal(hooks.PreToolUse[0].matcher, "ExitPlanMode");
  assert.equal(hooks.PreToolUse[0].hooks[0].timeout, 600);
  assert.equal(hooks.PostToolUse[0].matcher, "Bash");
  assert.equal(JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8")).name, "hoop");
  const market = JSON.parse(readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
  assert.deepEqual(
    market.plugins.map((p: { name: string; source: string }) => [p.name, p.source]),
    [["hoop", "./plugins/hoop"]],
  );
  const naming = readdirSync(join(plugin, "scripts")).filter((f) => readFileSync(join(plugin, "scripts", f), "utf8").includes("@ankurjain-nitrr/hoop"));
  assert.deepEqual(naming, ["hoop.sh"]);
});

test("without hoop on PATH, the MCP server and the hooks run hoop through npx", () => {
  const { bin, log } = fakes({ npx: `cat >/dev/null; case "$*" in *plan-review*) echo '${ALLOW}' ;; esac` });
  const mcp = spawnSync("sh", [join(plugin, "scripts/mcp.sh")], { input: "", encoding: "utf8", env: env(bin) });
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.deepEqual(log("npx"), [`-y ${SPEC} mcp`]);

  const input = JSON.stringify({ session_id: "s", tool_input: { plan: "# Plan\n" } });
  const plan = spawnSync("sh", [join(plugin, "scripts/plan-review.sh")], { input, encoding: "utf8", env: env(bin) });
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(log("npx").slice(1), [`-y ${SPEC} help`, `-y ${SPEC} plan-review`], "npx builds hoop before the timed review");

  const pr = spawnSync("sh", [join(plugin, "scripts/track-pr.sh")], {
    input: JSON.stringify({ tool_input: { command: "gh pr create --fill" } }),
    encoding: "utf8",
    env: env(bin),
  });
  assert.equal(pr.status, 0);
  assert.deepEqual(log("npx").slice(3), [`-y ${SPEC} pr-hook`]);
});

test("the plan review's wait leaves room for the npx build inside the alarm", () => {
  const { bin } = fakes({
    npx: `cat >/dev/null; case "$*" in *help*) sleep 2 ;; *plan-review*) echo "{\\"permissionDecision\\":\\"$HOOP_PLAN_WAIT_SECONDS\\"}" ;; esac`,
  });
  const run = (extra: Record<string, string>) =>
    spawnSync("sh", [join(plugin, "scripts/plan-review.sh")], { input: "{}", encoding: "utf8", env: env(bin, extra) });
  const waited = Number(JSON.parse(run({ HOOP_PLAN_ALARM: "100" }).stdout).permissionDecision);
  assert.ok(waited <= 68 && waited >= 60, `waits ${waited}s`);
  const short = run({ HOOP_PLAN_ALARM: "61" });
  assert.equal(short.status, 2);
  assert.match(short.stderr, /too little time/);
});

test("with neither hoop nor npx, the plan hook denies, and the MCP server and pull request hook say why or stay quiet", () => {
  const { bin } = fakes({});
  const plan = spawnSync("sh", [join(plugin, "scripts/plan-review.sh")], { input: "{}", encoding: "utf8", env: env(bin) });
  assert.equal(plan.status, 2);
  assert.match(plan.stderr, /neither hoop nor npx is on PATH/);
  const mcp = spawnSync("sh", [join(plugin, "scripts/mcp.sh")], { input: "", encoding: "utf8", env: env(bin) });
  assert.equal(mcp.status, 1);
  assert.match(mcp.stderr, /neither hoop nor npx/);
  const pr = spawnSync("sh", [join(plugin, "scripts/track-pr.sh")], { input: "gh pr create", encoding: "utf8", env: env(bin) });
  assert.equal(pr.status, 0);
  assert.equal(pr.stdout + pr.stderr, "");
});

const init = (bin: string, ...args: string[]) => hoopCli(["init", ...args], { env: { ...process.env, PATH: `${bin}:${PATH}` } });

test("hoop init installs the plugin with claude, in order", () => {
  const { bin, log } = fakes({ claude: "exit 0" });
  const r = init(bin);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(log("claude"), ["--version", "plugin marketplace add ankurjain-nitrr/hoop", "plugin install hoop@hoop"]);
  assert.match(r.stdout, /claude plugin uninstall hoop-plan@hoop/);
});

test("hoop init --print, or without claude, only prints the two commands", () => {
  const { bin, log } = fakes({ claude: "exit 0" });
  for (const r of [init(bin, "--print"), init(fakes({}).bin)]) {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /claude plugin marketplace add ankurjain-nitrr\/hoop\n {2}claude plugin install hoop@hoop\n/);
  }
  assert.deepEqual(log("claude"), []);
  assert.equal(init(bin, "--force").status, 2);
});

test("hoop init stops at a failed step and prints the commands to run", () => {
  const { bin, log } = fakes({ claude: `case "$*" in *marketplace*) exit 1 ;; esac` });
  const r = init(bin);
  assert.equal(r.status, 1);
  assert.deepEqual(log("claude").slice(1), ["plugin marketplace add ankurjain-nitrr/hoop"]);
  assert.match(r.stdout, /that failed \(exit 1\)\. Run these yourself/);
});

test("the plugin's build-document skill has frontmatter and the build-together steps", () => {
  const skill = readFileSync(join(plugin, "skills/build-document/SKILL.md"), "utf8");
  const front = /^---\nname: build-document\ndescription: (.+)\n---\n/.exec(skill);
  assert.ok(front, "frontmatter with name and description");
  assert.match(front[1] ?? "", /help me build a document/);
  for (const step of [/outline/i, /Generate on a section/, /hoop_build_suggest/, /contradicts/, /mermaid/]) assert.match(skill, step);
  // A build starts from its title: no questions first.
  for (const asked of [/## Question:/, /who it's for/i, /how long/i, /hoop_submit/]) assert.doesNotMatch(skill, asked);
});

// Claude Code serves an installed plugin from a cache keyed by its version, and the plugin runs the
// package of that version through npx: one number, in package.json, moves both at a release.
test("the package, its lock file and the plugin carry one version number", () => {
  const all = versions();
  assert.deepEqual(
    all.map((v) => [v.place, v.version]),
    all.map((v) => [v.place, VERSION]),
    "run npm version X.Y.Z --no-git-tag-version, which sets them all (docs/RELEASING.md)",
  );
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test("the version check fails, naming each file, when the plugin's number differs", () => {
  const copy = mkdtempSync(join(tmpdir(), "hoop-version-"));
  for (const f of ["package.json", "package-lock.json", "scripts/version.ts", "plugins/hoop/.claude-plugin/plugin.json"]) {
    mkdirSync(dirname(join(copy, f)), { recursive: true });
    copyFileSync(new URL(`../${f}`, import.meta.url), join(copy, f));
  }
  const check = () => spawnSync(process.execPath, [tsx, join(copy, "scripts/version.ts"), "--check"], { encoding: "utf8" });
  assert.equal(check().status, 0, check().stderr);
  const manifest = join(copy, "plugins/hoop/.claude-plugin/plugin.json");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(`"version": "${VERSION}"`, '"version": "0.0.1"'));
  const failed = check();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /plugins\/hoop\/\.claude-plugin\/plugin\.json: 0\.0\.1/);
  assert.match(failed.stderr, new RegExp(`package\\.json: ${VERSION.replaceAll(".", "\\.")}`));
  assert.match(failed.stderr, /npm version X\.Y\.Z --no-git-tag-version/);
});
