import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hookFields, parseHookInput } from "../src/hook-input.js";
import { TEST_SESSION } from "./helpers.js";

/** Every recorded hook input in test/fixtures/hook-inputs, by file and name. */
function recorded(): [string, Record<string, unknown>][] {
  const dir = new URL("./fixtures/hook-inputs/", import.meta.url).pathname;
  return readdirSync(dir).flatMap((f) =>
    Object.entries(JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>)
      .filter(([name]) => name !== "_note")
      .map(([name, input]): [string, Record<string, unknown>] => [`${f} ${name}`, input as Record<string, unknown>]),
  );
}

test("hookFields reads each recorded hook input's event, session, tool and agent as Claude Code sent them", () => {
  const inputs = recorded();
  assert.ok(inputs.length >= 30, `${inputs.length} recorded inputs`);
  for (const [name, input] of inputs) {
    const f = hookFields(input);
    assert.equal(f.event, input.hook_event_name, name);
    assert.equal(f.session, TEST_SESSION, name);
    assert.equal(f.tool, input.tool_name, name);
    assert.deepEqual(f.toolInput, input.tool_input ?? {}, name);
    assert.equal(f.toolUseId, input.tool_use_id, name);
    assert.equal(f.agent, input.agent_id, name);
    assert.equal(f.agentType, input.agent_type, name);
    assert.equal(f.transcript, input.transcript_path, name);
    assert.equal(f.cwd, input.cwd, name);
    assert.equal(f.promptId, input.prompt_id, name);
  }
});

test("hookFields gives nothing for what Claude Code never sends: a non-object, a bad session ID, empty or non-string fields", () => {
  for (const v of [null, undefined, "text", 3, ["PreToolUse"]]) assert.deepEqual(hookFields(v), { toolInput: {} }, String(v));
  assert.deepEqual(hookFields({ session_id: "../other", hook_event_name: 7, tool_name: "", agent_id: "  ", tool_input: ["x"], cwd: 1, transcript_path: {} }), {
    toolInput: {},
  });
});

test("parseHookInput reads an object, empty input as an empty object, and names what else it got", () => {
  assert.deepEqual(parseHookInput('{"session_id":"s"}'), { input: { session_id: "s" } });
  assert.deepEqual(parseHookInput("  \n"), { input: {} });
  assert.deepEqual(parseHookInput("{ not json"), { problem: "the hook's input isn't valid JSON" });
  assert.deepEqual(parseHookInput("null"), { problem: "the hook's input is null, not a JSON object" });
  assert.deepEqual(parseHookInput("[1]"), { problem: "the hook's input is a list, not a JSON object" });
  assert.deepEqual(parseHookInput('"x"'), { problem: "the hook's input is a string, not a JSON object" });
});
