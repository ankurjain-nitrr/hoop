import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClaudeSession, inputDigest, MAIN, readWork, workEvents, workHook, workView } from "../src/work.js";
import { agentHealth, todoState } from "../web/activity.js";
import { tempHome } from "./helpers.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const AGENT = "a1b2c3d4e5f607182";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });
const common = () => {
  const { session_id, transcript_path, cwd, permission_mode } = HOOKS["post-taskcreate"];
  return { session_id, transcript_path, cwd, permission_mode };
};
/** Claude Code's PermissionRequest hook input, as 2.1.310 builds it: the common fields, the tool and its input. */
const permission = (tool: string, extra: Record<string, unknown> = {}) => ({
  ...common(),
  hook_event_name: "PermissionRequest",
  tool_name: tool,
  tool_input: { command: "npm test" },
  permission_suggestions: [],
  ...extra,
});
/** Its Notification hook input once the dialog shows. */
const shown = (tool: string, extra: Record<string, unknown> = {}) => ({
  ...common(),
  hook_event_name: "Notification",
  message: `Claude needs your permission to use ${tool}`,
  notification_type: "permission_prompt",
  ...extra,
});
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const call = (at: string, id: string, name = "Bash", input: Record<string, unknown> = { command: "npm test" }) =>
  line({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (at: string, id: string) =>
  line({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const live =
  (status = "busy", more: Partial<ClaudeSession> = {}): (() => ClaudeSession[]) =>
  () => [{ session: SESSION, pid: process.pid, status, ...more }];

/** A session with work whose transcript is a temp file: one todo running. */
function seeded() {
  const home = tempHome();
  const transcript = join(mkdtempSync(join(tmpdir(), "hoop-prompt-")), `${SESSION}.jsonl`);
  writeFileSync(transcript, "");
  workHook(home, hook("post-taskcreate", { transcript_path: transcript }), ago(120));
  workHook(home, hook("post-taskupdate", { transcript_path: transcript }), ago(110));
  return { home, transcript, at: { transcript_path: transcript } };
}
const stateOf = (home: string, sessions = live()) => {
  const [s] = workView(home, sessions);
  return { doing: s!.doing?.waiting, todo: todoState(s!, s!.todos[0]!, Date.now())?.note };
};
const RUNNING = { doing: undefined, todo: "Running: the session works on it" };
const WAITING = { doing: "permission", todo: "Waiting on you: a permission prompt in Claude Code" };

test("the hook parser reads a permission prompt, with its input and subagent, and the notification that its dialog showed", () => {
  assert.deepEqual(workEvents(permission("Bash")), [{ kind: "prompt", tool: "Bash", input: inputDigest({ command: "npm test" }) }]);
  assert.deepEqual(workEvents(permission("Edit", { agent_id: AGENT, tool_input: {} })), [{ kind: "prompt", tool: "Edit", input: {}, agent: AGENT }]);
  assert.deepEqual(workEvents(permission("")), []);
  assert.deepEqual(workEvents(shown("Bash")), [{ kind: "prompt-shown", tool: "Bash" }]);
  assert.deepEqual(workEvents(shown("Bash", { notification_type: "idle_prompt" })), []);
  const home = tempHome();
  assert.equal(workHook(home, permission("Bash")), undefined, "a session with no work keeps no record for a prompt");
  assert.equal(workHook(home, shown("Bash")), undefined);
  assert.equal(existsSync(join(home, "work")), false);
});

test("a permission prompt reads as waiting on you once its dialog showed, until it is answered", () => {
  const { home, transcript, at } = seeded();
  appendFileSync(transcript, call(ago(30), "toolu_1"));
  assert.deepEqual(stateOf(home), RUNNING, "before the prompt it runs");
  workHook(home, permission("Bash", at), ago(29));
  // A hook or a headless session may decide the call: no dialog, no wait.
  assert.deepEqual(stateOf(home), RUNNING, "no dialog yet");
  workHook(home, shown("Bash", at), ago(23));
  assert.deepEqual(stateOf(home), WAITING);
  // Answered (allowed or denied), the call gets its result: the session runs on.
  appendFileSync(transcript, result(ago(5), "toolu_1"));
  assert.deepEqual(stateOf(home), RUNNING);
  // A later call of the same tool isn't the prompt's.
  appendFileSync(transcript, call(ago(2), "toolu_2"));
  assert.deepEqual(stateOf(home), RUNNING);
});

test("a prompt waits only on the call with its input, not another call of its tool", () => {
  const { home, transcript, at } = seeded();
  appendFileSync(transcript, call(ago(30), "toolu_1", "Bash", { command: "ls", description: "List files" }));
  workHook(home, permission("Bash", { ...at, tool_input: { command: "rm -rf build" } }), ago(29));
  workHook(home, shown("Bash", at), ago(23));
  assert.deepEqual(stateOf(home), RUNNING);
  // The hook may fill in defaults: the fields both name must agree.
  workHook(home, permission("Bash", { ...at, tool_input: { command: "ls", description: "List files", timeout: 120000 } }), ago(22));
  workHook(home, shown("Bash", at), ago(21));
  assert.deepEqual(stateOf(home), WAITING);
});

test("a subagent's permission prompt waits on you as its own, and doesn't replace the session's", () => {
  const { home, transcript, at } = seeded();
  const agentLog = join(mkdtempSync(join(tmpdir(), "hoop-prompt-agent-")), `agent-${AGENT}.jsonl`);
  writeFileSync(agentLog, call(ago(30), "toolu_a", "Edit", { file_path: "a.ts" }));
  appendFileSync(transcript, call(ago(40), "toolu_1"));
  workHook(home, hook("subagent-start", { agent_transcript_path: agentLog, ...at }), ago(40));
  workHook(home, permission("Bash", at), ago(35));
  workHook(home, permission("Edit", { agent_id: AGENT, tool_input: { file_path: "a.ts" }, ...at }), ago(29));
  workHook(home, shown("Bash", at), ago(28));
  workHook(home, shown("Edit", at), ago(27));
  assert.deepEqual(Object.keys(readWork(home, SESSION)!.prompts!).sort(), [AGENT, MAIN]);
  const [s] = workView(home, live());
  assert.equal(s!.doing?.waiting, "permission", "the session's own prompt still waits");
  const agent = s!.agents.find((a) => a.id === AGENT)!;
  assert.equal(agent.doing?.waiting, "permission");
  assert.deepEqual(agentHealth(agent, Date.now()), { state: "waiting" });
});

test("a session whose dialog waits on the person reads busy only while a call runs, and says it waits on the dialog", () => {
  const { home, transcript } = seeded();
  // Claude Code writes status "waiting", with waitingFor, while a dialog is open.
  const dialog = live("waiting", { waitingFor: "dialog open" });
  const [idle] = workView(home, dialog);
  assert.equal(idle!.state, "idle", "a dialog between turns, such as a slash command's, isn't a turn");
  appendFileSync(transcript, call(ago(30), "toolu_1"));
  assert.equal(workView(home, dialog)[0]!.state, "busy");
  assert.deepEqual(stateOf(home, dialog), { doing: "dialog", todo: "Waiting on you: a dialog in Claude Code" });
  appendFileSync(transcript, result(ago(20), "toolu_1"));
  appendFileSync(transcript, call(ago(19), "toolu_q", "AskUserQuestion", { questions: [] }));
  assert.deepEqual(stateOf(home, live("waiting", { waitingFor: "input needed" })), { doing: "question", todo: "Waiting on you: a question in Claude Code" });
});

test("the wrapper passes a permission prompt and its notification on only for a session with work, in the background", () => {
  const home = tempHome();
  const bin = mkdtempSync(join(tmpdir(), "hoop-work-bin-"));
  const fake = join(bin, "hoop");
  writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\necho "$@" >> "${bin}/ran"\n`, { mode: 0o755 });
  const wrapper = new URL("../plugins/hoop/scripts/track-work.sh", import.meta.url).pathname;
  const run = (input: object) =>
    spawnSync("sh", [wrapper], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, HOOP_HOME: home, HOOP_BIN: fake } });
  // A prompt for a task tool names "Task" too: with no work, it still doesn't start hoop.
  for (const input of [permission("Bash"), permission("TaskUpdate"), shown("Bash")]) assert.equal(run(input).status, 0);
  assert.equal(existsSync(join(bin, "ran")), false);
  workHook(home, hook("post-taskcreate"));
  assert.equal(run(permission("Bash")).status, 0);
  assert.equal(run(shown("Bash")).status, 0);
  assert.equal(readFileSync(join(bin, "ran"), "utf8"), "work-hook\nwork-hook\n");
  const hooks = JSON.parse(readFileSync(new URL("../plugins/hoop/hooks/hooks.json", import.meta.url), "utf8")).hooks;
  assert.match(hooks.PermissionRequest[0].hooks[0].command, /track-work\.sh/);
  assert.equal(hooks.PermissionRequest[0].hooks[0].async, true, "it never holds up the prompt");
  assert.equal(hooks.Notification[0].matcher, "permission_prompt");
  assert.equal(hooks.Notification[0].hooks[0].async, true);
});
