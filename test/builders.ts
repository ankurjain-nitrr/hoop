// Builders for what tests hand to hoop: Claude Code sessions, transcript lines and transcript files.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeSession } from "../src/work.js";
import { TEST_SESSION } from "./helpers.js";

/** A time `s` seconds into a fixed minute, 2026-10-23 12:00 UTC, as an ISO string. */
export const atSecond = (s: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();

/** The time `s` seconds ago, as an ISO string. */
export const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();

/** One JSONL line: `v` as JSON and a newline. */
export const jsonLine = (v: unknown) => `${JSON.stringify(v)}\n`;

/** JSONL text: each entry on its own line, as JSON, or as it is when it is already a string. */
export const jsonl = (entries: unknown[]) => `${entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n")}\n`;

/** A transcript entry: Claude calls tool `name` (call `id`) with `input` at `at`. */
export const toolUse = (at: string, id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: "assistant",
  timestamp: at,
  message: { content: [{ type: "tool_use", id, name, input }] },
});

/** A transcript entry: the result of tool call `id` at `at`. */
export const toolResult = (at: string, id: string) => ({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id }] } });

/**
 * Writes `text` as session `session`'s transcript in project folder `project` of the test's Claude
 * Code folder (`HOOP_CLAUDE_DIR`), and returns its path.
 */
export function writeTranscript(session: string, text: string, project = "-tmp-proj"): string {
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "projects", project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${session}.jsonl`);
  writeFileSync(path, text);
  return path;
}

/** The test's Claude Code session, idle, as Claude Code lists it, with `extra` fields. */
export const idleSession = (extra: Partial<ClaudeSession> = {}): ClaudeSession => ({ session: TEST_SESSION, pid: 1, status: "idle", ...extra });
