import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { nodeTooOld } from "../src/node-floor.js";
import { tempHome, tsx } from "./helpers.js";

// hoop needs Node.js 22.12 or later (#212). The `hoop` command (src/bin.ts) checks it before it loads
// anything else, and the plugin's scripts (plugins/hoop/scripts/hoop.sh) check the node on PATH
// before they run hoop; both say the same one line and stop.
const OLD = "18.20.6";
const LINE = nodeTooOld(OLD)!;
const root = new URL("../", import.meta.url).pathname;
const plugin = join(root, "plugins/hoop/scripts");

test("the floor is 22.12, and the line says what is running and what to install", () => {
  for (const old of ["18.20.6", "v18.20.6", "15.14.0", "20.19.0", "22.11.0", "22.0.0"]) assert.ok(nodeTooOld(old), old);
  for (const fine of ["22.12.0", "22.12.1", "22.20.0", "23.0.0", "24.3.0", "100.0.0"]) assert.equal(nodeTooOld(fine), undefined, fine);
  assert.equal(nodeTooOld("not a version"), undefined, "a version it can't read doesn't block");
  assert.equal(
    LINE,
    "hoop needs Node.js 22.12 or later, and this is Node.js 18.20.6. Install Node.js 22 or later from https://nodejs.org (or run nvm install 22), then try again.",
  );
});

/** Runs the `hoop` command, with `claude` on PATH a stand-in that records any call, as init would make. */
function hoopOn(node: string, args: string[], nodeOptions = "") {
  const bin = mkdtempSync(join(tmpdir(), "hoop-node-bin-"));
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$*" >> "${bin}/claude.log"\n`, { mode: 0o755 });
  const built = join(root, "dist/bin.js");
  const entry = process.env.HOOP_TEST_BUILT === "1" ? [built] : [tsx, join(root, "src/bin.ts")];
  const home = tempHome();
  const r = spawnSync(node, [...entry, ...args], {
    input: "{}",
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOOP_HOME: home,
      HOOP_CLAUDE_DIR: mkdtempSync(join(tmpdir(), "hoop-node-claude-")),
      HOOP_PORT: "4797",
      // Through the environment, so tsx's own child process takes it too.
      ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    },
  });
  return { ...r, claude: existsSync(join(bin, "claude.log")) ? readFileSync(join(bin, "claude.log"), "utf8") : "", home };
}

// The process says it runs Node.js 18 before hoop loads: the check reads process.versions.node.
const asOld = () => {
  const file = join(mkdtempSync(join(tmpdir(), "hoop-node-old-")), "old.mjs");
  writeFileSync(file, `Object.defineProperty(process.versions, "node", { value: "${OLD}" });\n`);
  return `--import=${file}`;
};

test("on an older Node.js, every hoop command says what to install, runs nothing and exits 1", () => {
  for (const args of [["init", "--yes"], ["serve"], ["mcp"], ["plan-review"], ["work-gate"], ["help"], []]) {
    const r = hoopOn(process.execPath, args, asOld());
    assert.equal(r.status, 1, `hoop ${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stderr, `${LINE}\n`, `hoop ${args.join(" ")}`);
    assert.equal(r.stdout, "", `hoop ${args.join(" ")} writes nothing else`);
    assert.equal(r.claude, "", `hoop ${args.join(" ")} runs no claude`);
    assert.deepEqual(readdirSync(r.home), [], `hoop ${args.join(" ")} writes no hoop files`);
  }
});

test("on Node.js 22.12 or later, the hoop command runs hoop", () => {
  const r = hoopOn(process.execPath, ["help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Usage: hoop <command>/);
});

// The real case: this machine's default node is 18. Set HOOP_OLD_NODE to an old node to run it
// elsewhere; without one, it is skipped. Only the built command runs on it, as tsx may not.
const oldNode =
  process.env.HOOP_OLD_NODE ??
  (() => {
    const dir = join(homedir(), ".nvm/versions/node");
    const found = existsSync(dir) ? readdirSync(dir).find((v) => /^v18\./.test(v)) : undefined;
    return found ? join(dir, found, "bin/node") : undefined;
  })();
test("on a real Node.js 18, hoop init says what to install and changes nothing", {
  skip: !oldNode || process.env.HOOP_TEST_BUILT !== "1" ? "needs an old node and HOOP_TEST_BUILT=1" : false,
}, () => {
  const version = spawnSync(oldNode!, ["-p", "process.versions.node"], { encoding: "utf8" }).stdout.trim();
  for (const args of [["init", "--yes"], ["serve"]]) {
    const r = hoopOn(oldNode!, args);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, `${nodeTooOld(version)}\n`);
    assert.equal(r.claude, "", "init runs no claude");
  }
});

/** Runs a plugin script with `node` on PATH a stand-in that says `version`, and `hoop` one that records its calls. */
function script(name: string, input: string, version: string, home = tempHome()) {
  const bin = mkdtempSync(join(tmpdir(), "hoop-node-plugin-"));
  writeFileSync(join(bin, "node"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  writeFileSync(join(bin, "hoop"), `#!/bin/sh\necho "$*" >> "${bin}/hoop.log"\ncat >/dev/null\necho '{}'\n`, { mode: 0o755 });
  const { HOOP_BIN: _b, ...env } = process.env as Record<string, string>;
  const r = spawnSync("sh", [join(plugin, `${name}.sh`)], {
    input,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...env, PATH: `${bin}:/usr/bin:/bin`, HOOP_HOME: home },
  });
  return { ...r, hoop: existsSync(join(bin, "hoop.log")) ? readFileSync(join(bin, "hoop.log"), "utf8") : "" };
}

const SESSION = "11111111-2222-3333-4444-555555555555";
/** A hoop folder in which each hook below has something to check, so each gets as far as running hoop. */
function busyHome() {
  const home = tempHome();
  mkdirSync(join(home, "work"), { recursive: true });
  for (const f of ["json", "gate", "stop"]) writeFileSync(join(home, "work", `${SESSION}.${f}`), "{}");
  return home;
}
const HOOKS: [string, string][] = [
  ["mcp", ""],
  ["plan-review", `{"session_id":"${SESSION}","tool_input":{"plan":"# Plan"}}`],
  ["gate-work", `{"session_id":"${SESSION}","tool_name":"TodoWrite","tool_input":{}}`],
  ["track-pr", `{"session_id":"${SESSION}","tool_input":{"command":"gh pr create"}}`],
  ["track-work", `{"session_id":"${SESSION}","tool_name":"TodoWrite","tool_input":{}}`],
  ["session-start", `{"session_id":"${SESSION}","hook_event_name":"SessionStart","source":"resume"}`],
  ["stop-gate", `{"session_id":"${SESSION}","hook_event_name":"Stop"}`],
];

test("on an older node, every plugin script says the same line once and doesn't run hoop", () => {
  for (const [name, input] of HOOKS) {
    const r = script(name, input, OLD, busyHome());
    assert.equal(r.stderr.split("\n")[0], LINE, name);
    assert.equal(r.stderr.split(LINE).length, 2, `${name} says it once`);
    assert.equal(r.hoop, "", `${name} runs no hoop`);
  }
  // The MCP server doesn't start; the plan isn't let through unreviewed.
  assert.equal(script("mcp", "", OLD).status, 1);
  const plan = script("plan-review", HOOKS[1]![1], OLD);
  assert.equal(plan.status, 2);
  assert.match(plan.stderr, /this Node\.js is too old to run hoop.*The plan wasn't reviewed/);
});

test("on node 22.12 or later, the plugin scripts run hoop", () => {
  for (const version of ["22.12.0", "24.3.0"]) {
    const r = script("track-pr", HOOKS[3]![1], version, busyHome());
    assert.equal(r.stderr, "", version);
    assert.equal(r.hoop.trim(), "pr-hook", version);
  }
});
