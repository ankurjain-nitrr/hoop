import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClaudeSession, readWork, workEvents, workHook, workView } from "../src/work.js";
import { agentHealth, todoState } from "../web/activity.js";
import { tempHome } from "./helpers.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const AGENT = "a1b2c3d4e5f607182";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });
/** Claude Code's PermissionRequest hook input, as 2.1.310 builds it: the common fields, the tool and its input. */
const permission = (tool: string, extra: Record<string, unknown> = {}) => {
  const { session_id, transcript_path, cwd, permission_mode } = HOOKS["post-taskcreate"];
  return {
    session_id,
    transcript_path,
    cwd,
    permission_mode,
    hook_event_name: "PermissionRequest",
    tool_name: tool,
    tool_input: { command: "npm test" },
    permission_suggestions: [],
    ...extra,
  };
};
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const call = (at: string, id: string, name = "Bash") =>
  line({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name, input: { command: "npm test" } }] } });
const result = (at: string, id: string) =>
  line({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const live =
  (status = "busy"): (() => ClaudeSession[]) =>
  () => [{ session: SESSION, pid: process.pid, status }];

/** A session with work whose transcript is a temp file: one todo running. */
function seeded() {
  const home = tempHome();
  const transcript = join(mkdtempSync(join(tmpdir(), "hoop-prompt-")), `${SESSION}.jsonl`);
  writeFileSync(transcript, "");
  workHook(home, hook("post-taskcreate", { transcript_path: transcript }), ago(120));
  workHook(home, hook("post-taskupdate", { transcript_path: transcript }), ago(110));
  return { home, transcript };
}

test("the hook parser reads a permission prompt, with the subagent it is for", () => {
  assert.deepEqual(workEvents(permission("Bash")), [{ kind: "prompt", tool: "Bash" }]);
  assert.deepEqual(workEvents(permission("Edit", { agent_id: AGENT })), [{ kind: "prompt", tool: "Edit", agent: AGENT }]);
  assert.deepEqual(workEvents(permission("")), []);
  const home = tempHome();
  assert.equal(workHook(home, permission("Bash")), undefined, "a session with no work keeps no record for a prompt");
  assert.equal(existsSync(join(home, "work")), false);
});

test("a permission prompt reads as waiting on you until it is answered, not as running", () => {
  const { home, transcript } = seeded();
  appendFileSync(transcript, call(ago(30), "toolu_1"));
  const state = () => {
    const [s] = workView(home, live());
    return { doing: s!.doing?.waiting, todo: todoState(s!, s!.todos[0]!, Date.now())!.note };
  };
  assert.deepEqual(state(), { doing: undefined, todo: "Running: the session works on it" }, "before the prompt it runs");
  workHook(home, permission("Bash", { transcript_path: transcript }), ago(29));
  assert.equal(readWork(home, SESSION)!.prompt!.tool, "Bash");
  assert.deepEqual(state(), { doing: "permission", todo: "Waiting on you: a permission prompt in Claude Code" });
  // Answered (allowed or denied), the call gets its result: the session runs on.
  appendFileSync(transcript, result(ago(5), "toolu_1"));
  assert.deepEqual(state(), { doing: undefined, todo: "Running: the session works on it" });
  // A later call of the same tool isn't the prompt's.
  appendFileSync(transcript, call(ago(2), "toolu_2"));
  assert.deepEqual(state(), { doing: undefined, todo: "Running: the session works on it" });
});

test("a subagent's permission prompt waits on you as its own, not the session's", () => {
  const { home, transcript } = seeded();
  const agentLog = join(mkdtempSync(join(tmpdir(), "hoop-prompt-agent-")), `agent-${AGENT}.jsonl`);
  writeFileSync(agentLog, call(ago(30), "toolu_a"));
  appendFileSync(transcript, call(ago(40), "toolu_agent", "Agent"));
  workHook(home, hook("subagent-start", { agent_transcript_path: agentLog, transcript_path: transcript }), ago(40));
  workHook(home, permission("Bash", { agent_id: AGENT, transcript_path: transcript }), ago(29));
  const [s] = workView(home, live());
  assert.equal(s!.doing?.waiting, undefined);
  const agent = s!.agents.find((a) => a.id === AGENT)!;
  assert.equal(agent.doing?.waiting, "permission");
  assert.deepEqual(agentHealth(agent, Date.now()), { state: "waiting" });
});

test("a session whose dialog waits on the person reads busy, so an open question still waits on you", () => {
  const { home, transcript } = seeded();
  appendFileSync(transcript, call(ago(30), "toolu_q", "AskUserQuestion"));
  // Claude Code writes status "waiting" (with waitingFor) while a dialog is open.
  const [s] = workView(home, live("waiting"));
  assert.equal(s!.state, "busy");
  assert.equal(todoState(s!, s!.todos[0]!, Date.now())!.note, "Waiting on you: a question in Claude Code");
});

test("the wrapper passes a permission prompt on only for a session with work, in the background", () => {
  const home = tempHome();
  const bin = mkdtempSync(join(tmpdir(), "hoop-work-bin-"));
  const fake = join(bin, "hoop");
  writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\necho "$@" >> "${bin}/ran"\n`, { mode: 0o755 });
  const wrapper = new URL("../plugins/hoop/scripts/track-work.sh", import.meta.url).pathname;
  const run = (input: object) =>
    spawnSync("sh", [wrapper], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, HOOP_HOME: home, HOOP_BIN: fake } });
  // A prompt for a task tool names "Task" too: with no work, it still doesn't start hoop.
  for (const tool of ["Bash", "TaskUpdate"]) assert.equal(run(permission(tool)).status, 0);
  assert.equal(existsSync(join(bin, "ran")), false);
  workHook(home, hook("post-taskcreate"));
  assert.equal(run(permission("Bash")).status, 0);
  assert.equal(readFileSync(join(bin, "ran"), "utf8"), "work-hook\n");
  const hooks = JSON.parse(readFileSync(new URL("../plugins/hoop/hooks/hooks.json", import.meta.url), "utf8")).hooks;
  assert.match(hooks.PermissionRequest[0].hooks[0].command, /track-work\.sh/);
  assert.equal(hooks.PermissionRequest[0].hooks[0].async, true, "it never holds up the prompt");
});
