import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSettings, enableTodoTools, init, todoToolsStep } from "../src/init.js";
import { hoopArgs } from "./helpers.js";

/** A settings file path in a new temp folder, with `text` in it when given. */
function settingsFile(text?: string) {
  const path = join(mkdtempSync(join(tmpdir(), "hoop-settings-")), "settings.json");
  if (text !== undefined) writeFileSync(path, text);
  return path;
}
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("turning on the todo tools merges into the settings, keeps a backup, and is idempotent", () => {
  const old = `{\n  "model": "opus",\n  "env": { "FOO": "bar" },\n  "permissions": { "allow": ["Bash(ls)"] }\n}\n`;
  const path = settingsFile(old);
  assert.deepEqual(enableTodoTools(path), { state: "changed", backup: `${path}.hoop-backup` });
  assert.deepEqual(read(path), { model: "opus", env: { FOO: "bar", CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" }, permissions: { allow: ["Bash(ls)"] } });
  assert.equal(readFileSync(`${path}.hoop-backup`, "utf8"), old, "the backup is the old file, byte for byte");
  const after = readFileSync(path, "utf8");
  assert.deepEqual(enableTodoTools(path), { state: "on" });
  assert.equal(readFileSync(path, "utf8"), after, "a second run changes nothing");

  // A missing file (and folder) is created, with nothing to back up.
  const fresh = join(mkdtempSync(join(tmpdir(), "hoop-settings-")), "claude", "settings.json");
  assert.deepEqual(enableTodoTools(fresh), { state: "changed" });
  assert.deepEqual(read(fresh), { env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } });
  // A value other than "1" is replaced.
  const off = settingsFile(`{"env":{"CLAUDE_CODE_ENABLE_TODO_TOOLS":"0"}}`);
  assert.equal(enableTodoTools(off).state, "changed");
  assert.equal(read(off).env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");

  // A file hoop can't merge into is left alone.
  for (const text of ["{ not json", "[1]", `{"env": "x"}`, `{"env": [1]}`]) {
    const bad = settingsFile(text);
    assert.equal(enableTodoTools(bad).state, "refused", text);
    assert.equal(readFileSync(bad, "utf8"), text);
    assert.equal(existsSync(`${bad}.hoop-backup`), false);
  }
});

test("the init step asks once on a terminal, takes --yes and --no, and otherwise only says how", async () => {
  // `yes` is the person's answer to the question.
  const run = async (opts: Partial<Parameters<typeof todoToolsStep>[0]> & { yes?: boolean }, text?: string) => {
    const settings = settingsFile(text);
    let out = "";
    const asked: string[] = [];
    const code = await todoToolsStep({
      settings,
      out: (s) => void (out += s),
      ask: async (q) => {
        asked.push(q);
        return Boolean(opts.yes);
      },
      ...opts,
    });
    let on = false;
    try {
      on = read(settings).env?.CLAUDE_CODE_ENABLE_TODO_TOOLS === "1";
    } catch {
      /* missing or broken */
    }
    return { code, out, asked, settings, on };
  };
  const yes = await run({ tty: true, yes: true }, "{}");
  assert.deepEqual([yes.code, yes.asked.length, yes.on], [0, 1, true]);
  assert.match(
    yes.asked[0]!,
    /Turn on Claude Code's todo tools\? This will set "env": \{"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"\} in .*settings\.json\. \[y\/N\] $/,
  );
  assert.match(yes.out, /set CLAUDE_CODE_ENABLE_TODO_TOOLS=1 under "env" in .*settings\.json \(the old file is at .*settings\.json\.hoop-backup\)/);
  assert.match(yes.out, /Codex: hoop's Work view doesn't read Codex's plan yet/);

  const no = await run({ tty: true }, "{}");
  assert.deepEqual([no.code, no.asked.length, no.on], [0, 1, false]);
  assert.match(no.out, /left the todo tools off/);
  assert.equal(readFileSync(no.settings, "utf8"), "{}");

  const flagYes = await run({ answer: "yes", tty: true });
  assert.deepEqual([flagYes.asked.length, flagYes.on], [0, true]);
  const flagNo = await run({ answer: "no", tty: true }, "{}");
  assert.deepEqual([flagNo.asked.length, flagNo.on], [0, false]);

  const quiet = await run({ tty: false }, "{}");
  assert.deepEqual([quiet.code, quiet.asked.length, quiet.on], [0, 0, false]);
  assert.match(quiet.out, /To turn them on, run hoop init --yes, or set "env": \{"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"\} in /);

  const already = await run({ tty: true }, `{"env":{"CLAUDE_CODE_ENABLE_TODO_TOOLS":"1"}}`);
  assert.deepEqual([already.asked.length, already.code], [0, 0]);
  assert.match(already.out, /already on/);

  const broken = await run({ answer: "yes" }, "{ nope");
  assert.equal(broken.code, 1);
  assert.match(broken.out, /isn't a JSON object, so hoop left it alone/);

  // --print only prints, and writes nothing (and never runs claude).
  const settings = settingsFile("{}");
  let out = "";
  assert.equal(await init({ print: true, todo: "yes", settings, out: (s) => void (out += s) }), 0);
  assert.match(out, /To turn them on: hoop init --yes/);
  assert.equal(readFileSync(settings, "utf8"), "{}");
});

test("hoop init reads Claude Code's settings from its folder, and takes --yes or --no but not both", () => {
  const dir = mkdtempSync(join(tmpdir(), "hoop-claude-init-"));
  const env = { ...process.env, HOOP_CLAUDE_DIR: dir, PATH: `${mkdtempSync(join(tmpdir(), "hoop-nobin-"))}:/usr/bin:/bin` };
  const hoop = (...args: string[]) => spawnSync(process.execPath, [...hoopArgs, "init", ...args], { encoding: "utf8", env });
  assert.equal(claudeSettings(), join(process.env.HOOP_CLAUDE_DIR!, "settings.json"));
  const quiet = hoop();
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stdout, /claude isn't on PATH/);
  assert.match(quiet.stdout, /To turn them on, run hoop init --yes/);
  assert.equal(existsSync(join(dir, "settings.json")), false, "without a terminal or a flag, nothing changes");
  assert.equal(hoop("--no").status, 0);
  assert.equal(existsSync(join(dir, "settings.json")), false);
  const yes = hoop("--yes");
  assert.equal(yes.status, 0, yes.stderr);
  assert.deepEqual(read(join(dir, "settings.json")), { env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } });
  assert.match(hoop("--yes").stdout, /already on/);
  assert.equal(hoop("--yes", "--no").status, 2);
});
