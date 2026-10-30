import { statSync } from "node:fs";
import { basename } from "node:path";
import { record, tailLines } from "./activity.js";
import { readJson } from "./util.js";
import { REVIEW_ID_PATTERN } from "./ids.js";

// Which subagents a person cares about, and what each came to, in plain words. Claude Code keeps
// short-lived helper transcripts (summaries, titles, classifiers) beside the agents an Agent call
// starts; only the latter show on the Work page. hoop only reads the transcripts.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** What Claude Code's `agent-<id>.meta.json` beside a transcript says about the agent an Agent call started. */
export type AgentMeta = { type?: string; description?: string; call?: string };

/** Reads a file once per change of its size and time. */
function cached<T>(cache: Map<string, { key: string; value: T | undefined }>, path: string, read: () => T | undefined): T | undefined {
  let key: string;
  try {
    const st = statSync(path);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return undefined;
  }
  const hit = cache.get(path);
  if (hit?.key === key) return hit.value;
  let value: T | undefined;
  try {
    value = read();
  } catch {
    value = undefined;
  }
  if (cache.size > 500) cache.clear();
  cache.set(path, { key, value });
  return value;
}

const metas = new Map<string, { key: string; value: AgentMeta | undefined }>();

/** The meta file beside an agent's transcript, when it names an agent type; undefined otherwise. */
export function agentMeta(transcript: string | undefined): AgentMeta | undefined {
  if (!transcript?.endsWith(".jsonl")) return undefined;
  const path = `${transcript.slice(0, -".jsonl".length)}.meta.json`;
  return cached(metas, path, () => {
    const v = obj(readJson(path));
    const type = str(v?.agentType);
    if (!type) return undefined;
    return { type, ...(str(v?.description) ? { description: str(v?.description) } : {}), ...(str(v?.toolUseId) ? { call: str(v?.toolUseId) } : {}) };
  });
}

/**
 * Whether an agent is one an Agent call started: hoop saw the call, its description or its type, or
 * Claude Code's meta file names its type. Helper transcripts have none of these.
 */
export const isRealAgent = (a: { call?: string; description?: string; type?: string }, meta?: AgentMeta) => Boolean(a.call || a.description || a.type || meta);

/** How an agent's transcript ends: its final report, the error it failed on, or a person's interruption. */
export type AgentEnd = { report?: string; error?: string; interrupted?: boolean };

/** How much of an agent's transcript is read for how it ended. */
const END_BYTES = 256 * 1024;
const ends = new Map<string, { key: string; value: AgentEnd | undefined }>();

const texts = (content: unknown[]) =>
  content
    .map((p) => obj(p))
    .filter((p) => p?.type === "text" && str(p.text))
    .map((p) => String(p!.text))
    .join("\n")
    .trim();

/**
 * How an agent's transcript ends, from its last assistant entries: the message it handed back
 * (SubagentHandback) or its last words, else the API error its last entry is.
 */
export function agentEnd(transcript: string | undefined): AgentEnd | undefined {
  if (!transcript) return undefined;
  return cached(ends, transcript, () => readEnd(transcript));
}

/** Whether a user entry's content is a person's interruption. */
const interrupts = (content: unknown) => (Array.isArray(content) ? texts(content) : str(content))?.startsWith("[Request interrupted") === true;

/** `agentEnd` from the transcript's file, read from its end. */
function readEnd(transcript: string): AgentEnd {
  let interrupted = false;
  for (const line of tailLines(transcript, END_BYTES).reverse()) {
    const v = record(line);
    const content = obj(v?.message)?.content;
    if (v?.type === "user") {
      interrupted ||= interrupts(content);
      continue;
    }
    if (v?.type !== "assistant" || !Array.isArray(content)) continue;
    const end = assistantEnd(v, content, interrupted ? { interrupted } : {});
    if (end) return end;
  }
  return interrupted ? { interrupted } : {};
}

/** How an agent ended, if its assistant entry `v` (latest first) says: an API error, its handback, or its last words. */
function assistantEnd(v: Obj, content: unknown[], done: AgentEnd): AgentEnd | undefined {
  if (v.isApiErrorMessage || v.error) return { error: texts(content) || String(v.error), ...done };
  const uses = content.map((p) => obj(p)).filter((p) => p?.type === "tool_use");
  const handback = uses.find((p) => p?.name === "SubagentHandback");
  if (handback) return { ...(str(obj(handback.input)?.message) ? { report: String(obj(handback.input)!.message) } : {}), ...done };
  if (uses.length) return done;
  const said = texts(content);
  return said ? { report: said, ...done } : undefined;
}

/** A link an agent's report names: a pull request, an issue, or a hoop review. */
export type AgentLink = { label: string; url: string };

const GITHUB = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/(\d+)/g;
const REVIEW = new RegExp(`https?://(?:localhost|127\\.0\\.0\\.1)(?::\\d+)?/r/${REVIEW_ID_PATTERN}`, "g");
/**
 * A path a person doesn't need to read: absolute, home-relative, or a file in a folder. Each needs a
 * letter in its first part, so a date such as 10/25/2026 stays.
 */
const PATH = /(?:~|\.{0,2})?\/(?=[\w.@~+-]*[A-Za-z])[\w.@~+-]+(?:\/[\w.@~+-]*)+|\b(?=[\w-]*[A-Za-z])[\w-]+(?:\/[\w.-]+)+\.\w{1,6}\b/g;

/** The links in a report, at most five, each once. */
export function reportLinks(report: string): AgentLink[] {
  const out = new Map<string, string>();
  for (const m of report.matchAll(GITHUB)) out.set(m[0], `${m[1] === "pull" ? "PR" : "Issue"} #${m[2]}`);
  for (const m of report.matchAll(REVIEW)) out.set(m[0], "Review");
  return [...out].slice(0, 5).map(([url, label]) => ({ label, url }));
}

/** At most this many characters of a report show as its outcome, and of an error as its reason. */
const OUTCOME_MAX = 240;
const REASON_MAX = 160;

/** Text cut to `max` characters at a space, never mid-word, with an ellipsis. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/**
 * Text in plain words, on one line: a markdown link as its words, a pull request's or issue's link
 * as "PR #214", a review's as "the review", any other as "a link", a path as the file's name, and
 * no markdown marks.
 */
function plainWords(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(GITHUB, (_m, kind: string, n: string) => `${kind === "pull" ? "PR" : "issue"} #${n}`)
    .replace(/\b(?:PR|pull request|issue)\s+(PR|issue) #/gi, "$1 #")
    .replace(REVIEW, "the review")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(PATH, (p) => basename(p))
    .replace(/^#+\s*|^[-*>]\s+|\*\*|__|`/gm, "")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Its sentences: one ends at . ! or ? and a space, but not at "e.g." or "i.e.". */
const sentencesOf = (text: string) => text.split(/(?<=[.!?])(?<!\b(?:e\.g|i\.e|etc|vs)\.)\s+/);

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * A report's first one or two sentences in plain words. Code blocks, tables and headings are
 * skipped; a list reads as its first item.
 */
export function outcomeOf(report: string): string | undefined {
  const paras = report
    .replace(/```[\s\S]*?(?:```|$)/g, "\n\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^(?:\s*#+\s[^\n]*(?:\n|$))+/, "").trim());
  const para = paras.find((p) => /[A-Za-z]/.test(p) && !p.startsWith("|"));
  if (!para) return undefined;
  const first = LIST_ITEM.test(para) ? para.split("\n")[0]!.replace(LIST_ITEM, "") : para;
  const plain = plainWords(first);
  if (!plain) return undefined;
  const sentences = sentencesOf(plain);
  let out = sentences[0]!;
  if (sentences[1] && out.length + sentences[1].length < OUTCOME_MAX) out = `${out} ${sentences[1]}`;
  return cap(out, OUTCOME_MAX);
}

/**
 * Why an agent failed, from the API error its transcript ends in: the error's message when the text
 * holds JSON, else its first sentence, in plain words.
 */
export function failReason(error: string): string {
  let text = error.replace(/^API Error:\s*(?:\d{3}\s*)?/, "");
  const at = text.indexOf("{");
  if (at >= 0) {
    try {
      const v = obj(JSON.parse(text.slice(at)));
      const message = str(obj(v?.error)?.message) ?? str(v?.message);
      if (message) text = message;
    } catch {
      /* not JSON */
    }
  }
  const words = plainWords(sentencesOf(text.trim())[0] ?? "");
  return `Failed: ${cap(words || "the subagent hit an error", REASON_MAX)}`;
}

/**
 * A running agent's step when it reads in plain words: a test run as "running tests", and none that
 * names a file, a path, a raw command, a search pattern or a tool by its name.
 */
export function plainStep(what: string | undefined): string | undefined {
  if (!what) return undefined;
  if (/^running tests\b/.test(what)) return "running tests";
  if (/[/\\]|\b\w+\.[a-z]{1,5}\b|^running:|^searching for |^finding files|^[A-Z]\w+$|Handback|mcp__/.test(what)) return undefined;
  return what;
}
