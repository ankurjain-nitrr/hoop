import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeSettings, todoToolsOn } from "./init.js";

/**
 * Whether a session has Claude Code's todo tools, as the Work page explains a session without todos:
 * `on`, `off` (the setup hint), or `restart` (the setting is on, but the session started without it).
 */
export type TodoTools = "on" | "off" | "restart";

/** The todo tools' names; one listed or called means the session has them. */
const NAMES = ["TaskCreate", "TodoWrite"];
const CALLED = new Set([...NAMES, "TaskUpdate"]);

/**
 * What a transcript says: `on` once a tool list names a todo tool or the agent calls one, `off` when
 * it lists tools (Claude Code's `deferred_tools_delta` entries) without one, undefined when it lists none.
 */
type Seen = "on" | "off" | undefined;

function seenIn(line: string): Seen {
  const named = [...CALLED].some((n) => line.includes(`"${n}"`));
  if (!named && !line.includes('"deferred_tools_delta"')) return undefined;
  let o: { type?: string; attachment?: { type?: string; addedNames?: unknown }; message?: { content?: unknown } };
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (o.type === "attachment" && o.attachment?.type === "deferred_tools_delta") {
    const added = Array.isArray(o.attachment.addedNames) ? o.attachment.addedNames : [];
    return NAMES.some((n) => added.includes(n)) ? "on" : "off";
  }
  if (o.type === "assistant" && Array.isArray(o.message?.content)) {
    const called = o.message.content.some((b: { type?: string; name?: string }) => b?.type === "tool_use" && CALLED.has(b.name ?? ""));
    if (called) return "on";
  }
  return undefined;
}

/** Each transcript's verdict so far and how far it was read, so a poll reads only what was appended. */
const cache = new Map<string, { offset: number; seen: Seen; rest: string }>();
const CHUNK = 1 << 20;

/** What a session's transcript says about its todo tools, read incrementally. */
export function transcriptTodoTools(path: string): Seen {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return undefined;
  }
  let c = cache.get(path);
  if (!c || c.offset > size) c = { offset: 0, seen: undefined, rest: "" };
  if (c.seen !== "on" && c.offset < size) {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return c.seen;
    }
    try {
      const buf = Buffer.alloc(CHUNK);
      while (c.offset < size && c.seen !== "on") {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, size - c.offset), c.offset);
        if (!n) break;
        c.offset += n;
        const lines = (c.rest + buf.toString("utf8", 0, n)).split("\n");
        c.rest = lines.pop() ?? "";
        for (const line of lines) {
          const s = seenIn(line);
          if (s === "on" || (s === "off" && !c.seen)) c.seen = s;
          if (c.seen === "on") break;
        }
      }
    } finally {
      closeSync(fd);
    }
  }
  if (cache.size > 200) cache.clear();
  cache.set(path, c);
  return c.seen;
}

/** Whether Claude Code's settings turn the todo tools on: the user's, or the project's in `cwd`. */
export function settingsTodoTools(cwd?: string): boolean {
  const project = cwd ? ["settings.json", "settings.local.json"].map((f) => join(cwd, ".claude", f)) : [];
  return [claudeSettings(), ...project].some((p) => todoToolsOn(p));
}

/** A session's todo tools: its transcript first, then Claude Code's settings. */
export function todoTools(transcript: string | undefined, cwd?: string): TodoTools {
  const seen = transcript ? transcriptTodoTools(transcript) : undefined;
  if (seen === "on") return "on";
  const set = settingsTodoTools(cwd);
  if (seen === "off") return set ? "restart" : "off";
  return set ? "on" : "off";
}
