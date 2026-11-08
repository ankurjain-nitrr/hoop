import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each part that acts inside a session has its own switch: hoop's off list, the file `off` under
// hoop's home, names the parts that are off, one per line. A hook that is off exits at once, without
// starting hoop or node.
const scripts = new URL("../plugins/hoop/scripts/", import.meta.url).pathname;
const SESSION = "off-switch-session";

/** A hoop home, and a stand-in for hoop that records each call and answers `answer`. */
function setup(answer: string) {
  const home = mkdtempSync(join(tmpdir(), "hoop-off-"));
  mkdirSync(join(home, "work"));
  const log = join(home, "hoop.log");
  const bin = join(home, "fake-hoop");
  writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\necho "$*" >> "${log}"\necho '${answer}'\n`, { mode: 0o755 });
  // No node on this PATH: a hook that is off never needs it.
  const env = { PATH: "/usr/bin:/bin", HOME: home, HOOP_HOME: home, HOOP_BIN: bin };
  const run = (script: string, input: object, extra: Record<string, string | undefined> = {}) =>
    spawnSync("sh", [join(scripts, script)], { input: JSON.stringify(input), encoding: "utf8", env: { ...env, ...extra } });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const off = (text: string) => writeFileSync(join(home, "off"), text);
  return { home, run, calls, off };
}

const PARTS: { name: string; script: string; answer: string; ready: (home: string) => object }[] = [
  {
    // The gate before every tool call, with a Work change open for this session's todo tools.
    name: "tool_gate",
    script: "gate-work.sh",
    answer: "{}",
    ready: (home) => {
      writeFileSync(join(home, "work", `${SESSION}.gate`), "");
      return { session_id: SESSION, hook_event_name: "PreToolUse", tool_name: "TaskUpdate", tool_input: { taskId: "1", status: "in_progress" } };
    },
  },
  {
    // The Stop gate, with a Work change the gate hasn't told.
    name: "turn_gates",
    script: "stop-gate.sh",
    answer: "{}",
    ready: (home) => {
      writeFileSync(join(home, "work", `${SESSION}.stop`), "");
      return { session_id: SESSION, hook_event_name: "Stop", stop_hook_active: false };
    },
  },
  {
    // The TaskCompleted gate, for a todo its record lists.
    name: "turn_gates",
    script: "done-gate.sh",
    answer: "{}",
    ready: (home) => {
      writeFileSync(join(home, "work", `${SESSION}.json`), "{}");
      writeFileSync(join(home, "work", `${SESSION}.done`), "7\n");
      return { session_id: SESSION, hook_event_name: "TaskCompleted", task_id: "7" };
    },
  },
  {
    // The plan hook, on leaving plan mode.
    name: "plan_hook",
    script: "plan-review.sh",
    answer: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"ok"}}',
    ready: () => ({ session_id: SESSION, hook_event_name: "PreToolUse", tool_name: "ExitPlanMode", tool_input: { plan: "# Plan\n" } }),
  },
];

for (const part of PARTS) {
  test(`${part.script} starts hoop while "${part.name}" is on, and exits at once without it when off`, () => {
    const on = setup(part.answer);
    const input = part.ready(on.home);
    assert.equal(on.run(part.script, input).status, 0);
    assert.equal(on.calls().length, 1, "on by default: the hook runs hoop");

    on.off("# nothing is off yet\nmermaid\n");
    assert.equal(on.run(part.script, input).status, 0);
    assert.equal(on.calls().length, 2, "a comment, or another part off, leaves it on");

    on.off(`mermaid\n${part.name}\n`);
    const off = on.run(part.script, input);
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.stdout, "", "no decision: Claude Code goes on as without the hook");
    assert.equal(off.stderr, "");
    assert.equal(on.calls().length, 2, "off: hoop isn't started");
  });
}

test('with "tool_gate" off, an agent a person stopped runs on, and a missing hoop no longer refuses it', () => {
  const s = setup("{}");
  writeFileSync(join(s.home, "work", `${SESSION}.agents`), "ag1\tstop\tana\n");
  const input = { session_id: SESSION, agent_id: "ag1", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} };
  const gate = (env: Record<string, string>) =>
    spawnSync("sh", [join(scripts, "gate-work.sh")], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: s.home, HOOP_HOME: s.home, ...env },
    });
  // On, a stopped agent's call with no hoop to ask is refused.
  assert.equal(gate({ HOOP_BIN: join(s.home, "no-such-hoop") }).status, 2);
  s.off("tool_gate\n");
  const off = gate({ HOOP_BIN: join(s.home, "no-such-hoop") });
  assert.equal(off.status, 0, off.stderr);
  assert.equal(off.stderr, "");
});

test("the off list names a part only on a line of its own, read exactly", () => {
  const s = setup("{}");
  const input = PARTS[0]!.ready(s.home);
  const isOff = (text: string, extra: Record<string, string | undefined> = {}) => {
    s.off(text);
    const before = s.calls().length;
    assert.equal(s.run("gate-work.sh", input, extra).status, 0);
    return s.calls().length === before;
  };
  // Off: the name alone on a line, with spaces, a tab or a Windows line end around it.
  assert.equal(isOff("tool_gate"), true, "no line end");
  assert.equal(isOff("plan_hook\ntool_gate\n"), true);
  assert.equal(isOff("\ttool_gate  \n"), true, "a tab and spaces");
  assert.equal(isOff("plan_hook\r\ntool_gate\r\n"), true, "Windows line ends");
  // On: anything else, including what a JSON settings file would hold.
  assert.equal(isOff(""), false, "an empty list");
  assert.equal(isOff("# tool_gate\n"), false, "a comment");
  assert.equal(isOff("// tool_gate\n"), false, "a // comment");
  assert.equal(isOff("tool_gates\ntool_gate_off\nno_tool_gate\n"), false, "a longer or shorter name");
  assert.equal(isOff("tool_gate falsey\n"), false, "more words on the line");
  assert.equal(isOff('{"tool_gate":false}\n'), false, "compact JSON");
  assert.equal(isOff('{\n  "x": { "tool_gate": false }\n}\n'), false, "a nested key");
  assert.equal(isOff('{ "tool_gate": false, "tool_gate": true }\n'), false, "a duplicate key");
  assert.equal(isOff("Tool_Gate\n"), false, "names are exact");
  // A settings.json is never read for switches.
  writeFileSync(join(s.home, "settings.json"), '{ "tool_gate": false }\n');
  assert.equal(isOff(""), false, "settings.json turns nothing off");
  // Without HOOP_HOME, the list is ~/.hoop/off.
  const home = mkdtempSync(join(tmpdir(), "hoop-off-home-"));
  mkdirSync(join(home, ".hoop", "work"), { recursive: true });
  writeFileSync(join(home, ".hoop", "work", `${SESSION}.gate`), "");
  const plain = (text: string) => {
    writeFileSync(join(home, ".hoop", "off"), text);
    const before = s.calls().length;
    assert.equal(s.run("gate-work.sh", input, { HOME: home, HOOP_HOME: undefined }).status, 0);
    return s.calls().length === before;
  };
  assert.equal(plain(""), false);
  assert.equal(plain("tool_gate\n"), true, "$HOME/.hoop/off without HOOP_HOME");
});
