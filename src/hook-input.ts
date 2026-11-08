import { readFileSync } from "node:fs";
import { HoopError, isRecord } from "./util.js";
import { validSession } from "./owner.js";

// A Claude Code hook's input: the JSON object it writes to the hook's stdin. Claude Code always sends
// an object; anything else is refused here, with what was wrong, so each hook decides what that means.

/** A hook's input object, or why the text isn't one. Empty input reads as an empty object. */
export function parseHookInput(text: string): { input: Record<string, unknown> } | { problem: string } {
  if (!text.trim()) return { input: {} };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { problem: "the hook's input isn't valid JSON" };
  }
  if (isRecord(v)) return { input: v };
  return { problem: `the hook's input is ${kindOf(v)}, not a JSON object` };
}

/** What a JSON value that isn't an object is, in words. */
function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  return `a ${typeof v}`;
}

/** The fields hoop reads from a hook's input, each undefined when it is missing or isn't what Claude Code sends. */
export type HookFields = {
  /** `hook_event_name`, such as "PreToolUse". */
  event?: string;
  /** `session_id`, when it is a session ID hoop can use in paths and records. */
  session?: string;
  /** `tool_name`, `tool_input` (an empty object when it isn't one) and `tool_use_id`. */
  tool?: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
  /** `agent_id` and `agent_type`: set when a subagent, not the main agent, made the call. */
  agent?: string;
  agentType?: string;
  transcript?: string;
  cwd?: string;
  promptId?: string;
};

/** A string with something in it, or undefined. */
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** The fields of a hook's input that hoop reads, checked; anything else, such as a value that isn't an object, gives none. */
export function hookFields(input: unknown): HookFields {
  const i = isRecord(input) ? input : {};
  const session = validSession(i.session_id);
  const fields: HookFields = { toolInput: isRecord(i.tool_input) ? i.tool_input : {} };
  if (typeof i.hook_event_name === "string") fields.event = i.hook_event_name;
  if (session) fields.session = session;
  for (const [key, field] of [
    ["tool_name", "tool"],
    ["tool_use_id", "toolUseId"],
    ["agent_id", "agent"],
    ["agent_type", "agentType"],
    ["transcript_path", "transcript"],
    ["cwd", "cwd"],
    ["prompt_id", "promptId"],
  ] as const) {
    const v = text(i[key]);
    if (v) fields[field] = v;
  }
  return fields;
}

/** The hook's input on stdin; throws a HoopError naming the problem when it isn't a JSON object. */
export function readHookInput(): Record<string, unknown> {
  const parsed = parseHookInput(readFileSync(0, "utf8"));
  if ("problem" in parsed) throw new HoopError(parsed.problem);
  return parsed.input;
}
