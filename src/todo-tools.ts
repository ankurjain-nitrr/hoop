import { join } from "node:path";
import { claudeSettings, todoToolsOn } from "./init.js";
import { follow } from "./transcript.js";

/** Whether a session has Claude Code's todo tools: `off` gets the Work page's setup hint. */
export type TodoTools = "on" | "off";

/** The todo tools' names: one listed means the session has them, one called too. */
const LISTED = ["TaskCreate", "TodoWrite"];
const CALLED = new Set([...LISTED, "TaskUpdate"]);

/**
 * What a transcript says: `on` once a tool list adds a todo tool or the agent calls one, `off` when
 * it lists tools (Claude Code's `deferred_tools_delta` entries) without one or removes them, and
 * undefined when it lists none.
 */
type Seen = { tools?: TodoTools };

type Entry = {
  type?: string;
  attachment?: { type?: string; addedNames?: unknown; removedNames?: unknown };
  message?: { content?: unknown };
};

const names = (v: unknown) => (Array.isArray(v) ? LISTED.some((n) => v.includes(n)) : false);

function readLine(seen: Seen, line: string): void {
  if (!line.includes('"deferred_tools_delta"') && ![...CALLED].some((n) => line.includes(`"${n}"`))) return;
  let o: Entry;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (o.type === "attachment" && o.attachment?.type === "deferred_tools_delta") {
    if (names(o.attachment.addedNames)) seen.tools = "on";
    else if (names(o.attachment.removedNames)) seen.tools = "off";
    else seen.tools ??= "off";
  } else if (o.type === "assistant" && Array.isArray(o.message?.content)) {
    if (o.message.content.some((b: { type?: string; name?: string }) => b?.type === "tool_use" && CALLED.has(b.name ?? ""))) seen.tools = "on";
  }
}

/** What a session's transcript says about its todo tools, read with the shared forward reader. */
export const transcriptTodoTools = (path: string): TodoTools | undefined => follow(path, "todo-tools", 0, (): Seen => ({}), readLine)?.tools;

/** Whether Claude Code's settings turn the todo tools on: the user's, or the project's in `cwd`. */
export function settingsTodoTools(cwd?: string): boolean {
  const project = cwd ? ["settings.json", "settings.local.json"].map((f) => join(cwd, ".claude", f)) : [];
  return [claudeSettings(), ...project].some((p) => todoToolsOn(p));
}

/**
 * A session's todo tools: on when its transcript shows them, or when Claude Code's settings turn them
 * on, since a running session picks the setting up on its next turn.
 */
export const todoTools = (transcript: string | undefined, cwd?: string): TodoTools =>
  (transcript && transcriptTodoTools(transcript) === "on") || settingsTodoTools(cwd) ? "on" : "off";
