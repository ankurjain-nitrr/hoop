import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each part that acts inside a session has its own switch in hoop's settings: `"<name>": false` in
// settings.json under hoop's home. A hook that is off exits at once, without starting hoop or node.
const scripts = new URL("../plugins/hoop/scripts/", import.meta.url).pathname;
const SESSION = "off-switch-session";

/** A hoop home, and a stand-in for hoop that records each call and answers `answer`. */
function setup(answer: string) {
  const home = mkdtempSync(join(tmpdir(), "hoop-off-"));
  mkdirSync(join(home, "work"));
  const log = join(home, "hoop.log");
  const bin = join(home, "fake-hoop");
  writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\necho "$*" >> "${log}"\necho '${answer}'\n`, { mode: 0o755 });
  const run = (script: string, input: object) =>
    spawnSync("sh", [join(scripts, script)], {
      input: JSON.stringify(input),
      encoding: "utf8",
      // No node on this PATH: a hook that is off never needs it.
      env: { PATH: "/usr/bin:/bin", HOME: home, HOOP_HOME: home, HOOP_BIN: bin },
    });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const settings = (s: object) => writeFileSync(join(home, "settings.json"), `${JSON.stringify(s, null, 2)}\n`);
  return { home, run, calls, settings };
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

    on.settings({ [part.name]: true, other: false });
    assert.equal(on.run(part.script, input).status, 0);
    assert.equal(on.calls().length, 2, "true, or another part off, leaves it on");

    on.settings({ mermaid: true, [part.name]: false });
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
  s.settings({ tool_gate: false });
  const off = gate({ HOOP_BIN: join(s.home, "no-such-hoop") });
  assert.equal(off.status, 0, off.stderr);
  assert.equal(off.stderr, "");
});
