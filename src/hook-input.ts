import { readFileSync } from "node:fs";
import { HoopError, isRecord } from "./util.js";

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

/** The hook's input on stdin; throws a HoopError naming the problem when it isn't a JSON object. */
export function readHookInput(): Record<string, unknown> {
  const parsed = parseHookInput(readFileSync(0, "utf8"));
  if ("problem" in parsed) throw new HoopError(parsed.problem);
  return parsed.input;
}
