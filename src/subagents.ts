import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { tailLines } from "./activity.js";

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
    const v = obj(JSON.parse(readFileSync(path, "utf8")));
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
  return cached(ends, transcript, () => {
    let interrupted = false;
    for (const line of tailLines(transcript, END_BYTES).reverse()) {
      if (!line.trim()) continue;
      let v: Obj | undefined;
      try {
        v = obj(JSON.parse(line));
      } catch {
        continue;
      }
      const content = obj(v?.message)?.content;
      if (v?.type === "user") {
        const said = Array.isArray(content) ? texts(content) : str(content);
        if (said?.startsWith("[Request interrupted")) interrupted = true;
        continue;
      }
      if (v?.type !== "assistant" || !Array.isArray(content)) continue;
      const done = interrupted ? { interrupted } : {};
      if (v.isApiErrorMessage || v.error) return { error: texts(content) || String(v.error), ...done };
      const uses = content.map((p) => obj(p)).filter((p) => p?.type === "tool_use");
      const handback = uses.find((p) => p?.name === "SubagentHandback");
      if (handback) return { ...(str(obj(handback.input)?.message) ? { report: String(obj(handback.input)!.message) } : {}), ...done };
      if (uses.length) return done;
      const said = texts(content);
      if (said) return { report: said, ...done };
    }
    return interrupted ? { interrupted } : {};
  });
}

/** A link an agent's report names: a pull request, an issue, or a hoop review. */
export type AgentLink = { label: string; url: string };

const GITHUB = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/(\d+)/g;
const REVIEW = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/r\/rv_[a-z0-9]+/g;
/** A path a person doesn't need to read: absolute, home-relative, or a file in a folder. */
const PATH = /(?:~|\.{0,2})?\/[\w.@~+-]+(?:\/[\w.@~+-]*)+|\b[\w-]+(?:\/[\w.-]+)+\.\w{1,6}\b/g;

/** The links in a report, at most five, each once. */
export function reportLinks(report: string): AgentLink[] {
  const out = new Map<string, string>();
  for (const m of report.matchAll(GITHUB)) out.set(m[0], `${m[1] === "pull" ? "PR" : "Issue"} #${m[2]}`);
  for (const m of report.matchAll(REVIEW)) out.set(m[0], "Review");
  return [...out].slice(0, 5).map(([url, label]) => ({ label, url }));
}

/** At most this many characters of a report show as its outcome. */
const OUTCOME_MAX = 240;

/**
 * A report's first one or two sentences, without markdown, links or paths: a pull request's link
 * reads as "PR #214", any other link and a path as the file's name.
 */
export function outcomeOf(report: string): string | undefined {
  const para =
    report
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => /[A-Za-z]/.test(p) && !p.startsWith("```") && !/^#+\s[^\n]*$/.test(p)) ?? "";
  const plain = para
    .replace(GITHUB, (_m, kind: string, n: string) => `${kind === "pull" ? "PR" : "issue"} #${n}`)
    .replace(/\b(?:PR|pull request|issue)\s+(PR|issue) #/gi, "$1 #")
    .replace(REVIEW, "the review")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(PATH, (p) => basename(p))
    .replace(/^#+\s*|^[-*>]\s+|\*\*|__|`/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  const sentences = plain.split(/(?<=[.!?])\s+/);
  let out = sentences[0]!;
  if (sentences[1] && out.length + sentences[1].length < OUTCOME_MAX) out = `${out} ${sentences[1]}`;
  return out.length > OUTCOME_MAX ? `${out.slice(0, OUTCOME_MAX - 1)}…` : out;
}

/**
 * A running agent's step when it reads in plain words: none that names a file, a path or a raw
 * command, or a tool by its name.
 */
export function plainStep(what: string | undefined): string | undefined {
  if (!what) return undefined;
  if (/[/\\]|\b\w+\.[a-z]{1,5}\b|^running:|^[A-Z]\w+$|Handback|mcp__/.test(what)) return undefined;
  return what;
}
