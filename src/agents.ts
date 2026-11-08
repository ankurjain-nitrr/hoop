// `hoop init`'s other-agents step: finds the MCP agent tools on this machine that docs/using/other-agents.md
// covers (Codex CLI, Cursor, OpenCode, Gemini CLI) by their user config folders, and adds hoop's MCP
// server to each one's user config only after the person says yes. It never writes without that, keeps
// the old file as `<file>.hoop-backup`, and leaves alone a file it can't merge into.
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeAtomic } from "./util.js";

/** The command every agent starts hoop's MCP server with, as docs/using/other-agents.md gives it. */
const NPX = ["npx", "-y", "@ankurjain-nitrr/hoop", "mcp"] as const;

/**
 * `HOOP_AGENTS_HOME`, when set, stands for the home folder of every agent, and CODEX_HOME and
 * XDG_CONFIG_HOME are then ignored; tests set it so that no real agent config is ever read.
 */
const agentsHome = () => process.env.HOOP_AGENTS_HOME;

type Json = Record<string, unknown>;

/** An agent tool: where its user config is, and how hoop's entry goes into it. */
export type Agent = {
  name: string;
  /** The folder whose presence says the tool is installed here. */
  dir: string;
  /** Its user config file, which may not exist yet. */
  file: string;
  /** What adding hoop does to the file, in words, for the question. */
  change: string;
  /** Whether the config's text already names hoop's server. */
  has: (text: string) => boolean;
  /** Why hoop can't add itself to this config, or undefined when it can. */
  refuse: (text: string) => string | undefined;
  /** Adds hoop's server to the config, calling `backup` once it has read the file again and it still takes hoop. */
  add: (backup: () => void) => void;
};

const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Where the configs are, for a file hoop leaves for the person to change by hand. */
const DOCS = "https://github.com/ankurjain-nitrr/hoop/blob/main/docs/using/other-agents.md";

/** A JSON config's text parsed: `{}` for an empty file, undefined when it isn't plain JSON (such as JSONC with comments). */
function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Why hoop can't put `key.hoop` into this JSON text, or undefined when it can. */
function jsonRefusal(text: string, file: string, key: string): string | undefined {
  const v = parseJson(text);
  if (v === undefined) return `${file} can't be read as plain JSON (it may have comments)`;
  if (!isObject(v)) return `${file} isn't a JSON object`;
  if (v[key] !== undefined && !isObject(v[key])) return `"${key}" in ${file} isn't an object`;
  return undefined;
}

/**
 * `value` as JSON laid out like `text` was: its indentation (a tab or so many spaces, 2 for a new
 * file), on one line when it was on one line, and with a final newline when it had one.
 */
function asLaidOut(value: unknown, text: string): string {
  const end = !text || text.endsWith("\n") ? "\n" : "";
  if (text.trim() && !text.trim().includes("\n")) return `${JSON.stringify(value)}${end}`;
  const indent = /\n([ \t]+)\S/.exec(text)?.[1];
  const unit = indent?.startsWith("\t") ? "\t" : (indent?.length ?? 2);
  const out = `${JSON.stringify(value, null, unit)}${end}`;
  // A file with Windows line endings keeps them.
  return text.includes("\r\n") ? out.replace(/\n/g, "\r\n") : out;
}

/** A JSON config that keeps its servers under `key`: hoop goes in as `key.hoop`, with every other key kept. */
function jsonAgent(name: string, dir: string, file: string, key: string, entry: Json): Agent {
  return {
    name,
    dir,
    file,
    change: `add "hoop" under "${key}" in ${file}`,
    has: (text) => {
      const v = parseJson(text);
      return isObject(v) && isObject(v[key]) && "hoop" in v[key];
    },
    refuse: (text) => jsonRefusal(text, file, key),
    add: (backup) => {
      // Read again: the file may have changed while the person was asked. One hoop can't merge into now stays as it is.
      const exists = existsSync(file);
      const text = exists ? readFileSync(file, "utf8") : "";
      const why = jsonRefusal(text, file, key);
      const settings = parseJson(text);
      if (why || !isObject(settings)) throw new Error(`${why ?? `${file} isn't a JSON object`} now, so hoop left it alone`);
      backup();
      const servers = isObject(settings[key]) ? settings[key] : {};
      // The file keeps its mode, such as 0600 for one only its owner may read, whatever the umask.
      const mode = exists ? statSync(file).mode & 0o777 : undefined;
      writeAtomic(file, asLaidOut({ ...settings, [key]: { ...servers, hoop: entry } }, text), mode);
      if (mode !== undefined) chmodSync(file, mode);
    },
  };
}

// Codex's config is TOML. hoop reads only as much of it as it must to tell whether hoop's server is in
// it, and appends a [mcp_servers.hoop] table when it isn't; a file it can't read with certainty is
// left for the person.
const CODEX_TABLE = `[mcp_servers.hoop]\ncommand = "npx"\nargs = ["-y", "@ankurjain-nitrr/hoop", "mcp"]\nstartup_timeout_sec = 60\n`;
const KEY = String.raw`(?:[A-Za-z0-9_-]+|"[^"\n]*"|'[^'\n]*')`;
const DOTTED = String.raw`${KEY}(?:\s*\.\s*${KEY})*`;
const HEADER = new RegExp(String.raw`^\[\s*(${DOTTED})\s*\]\s*(?:#.*)?$`);
const ARRAY_HEADER = new RegExp(String.raw`^\[\[\s*(${DOTTED})\s*\]\]\s*(?:#.*)?$`);
const KEY_LINE = new RegExp(String.raw`^(${DOTTED})\s*=(.*)$`);
const keyParts = (dotted: string) => [...dotted.matchAll(new RegExp(KEY, "g"))].map((m) => m[0].replace(/^["']|["']$/g, ""));
// A string in a value, closed or running to the line's end: one pass, so an unterminated quote can't make it slow.
const STRINGS = /"(?:[^"\\]|\\.)*(?:"|$)|'[^']*(?:'|$)/g;
/** How many more `[` than `]` a value opens, outside its strings: a multi-line array runs on until it closes. */
const opens = (value: string) => {
  const bare = value.replace(STRINGS, "").replace(/#.*$/, "");
  return (bare.match(/\[/g)?.length ?? 0) - (bare.match(/\]/g)?.length ?? 0);
};

/** One line of TOML as hoop reads it: a table header, an array-of-tables header, a key and its value, or none of these; `raw` is its key as written. */
function tomlLine(
  line: string,
): { kind: "table" | "array"; keys: string[]; raw: string } | { kind: "key"; keys: string[]; raw: string; value: string } | undefined {
  const array = ARRAY_HEADER.exec(line);
  if (array) return { kind: "array", keys: keyParts(array[1]!), raw: array[1]! };
  const header = HEADER.exec(line);
  if (header) return { kind: "table", keys: keyParts(header[1]!), raw: header[1]! };
  const kv = KEY_LINE.exec(line);
  return kv ? { kind: "key", keys: keyParts(kv[1]!), raw: kv[1]!, value: kv[2]! } : undefined;
}

/** The multi-line string delimiter a line leaves open (an odd count of it), if any. */
function opensMultiline(line: string): string | undefined {
  return ['"""', "'''"].find((d) => line.split(d).length % 2 === 0);
}

/**
 * What a Codex config says about hoop: whether its server is in it (a `[mcp_servers.hoop]` table,
 * `hoop = …` or `hoop.command = …` in `[mcp_servers]`, or `mcp_servers.hoop.… = …`), and why hoop
 * can't be sure, if it can't: `mcp_servers` as an array or inline table, a line it can't read where
 * hoop's server could be, a quoted key with an escape, or, when it found no hoop, multi-line strings,
 * whose lines it skips.
 */
function scanCodex(text: string): { has: boolean; unsure?: string } {
  const scan: Scan = { table: [], depth: 0, has: false };
  let multiline: string | undefined;
  let sawMultiline = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (multiline) {
      if (line.includes(multiline)) multiline = undefined;
      continue;
    }
    const unsure = readCodexLine(scan, line);
    if (unsure) return { has: scan.has, unsure };
    multiline = opensMultiline(line);
    sawMultiline ||= multiline !== undefined;
  }
  return scan.has || !sawMultiline ? { has: scan.has } : { has: false, unsure: "it has multi-line strings" };
}

/** Where a scan of a Codex config is: the table its lines are in, how deep in a multi-line array, and whether hoop was seen. */
type Scan = { table: string[]; depth: number; has: boolean };

/** Whether a line hoop can't read could hide hoop's server: one in [mcp_servers], or at the top naming it. */
const hides = (table: string[], line: string) => (table.length === 1 && table[0] === "mcp_servers") || (!table.length && line.includes("mcp_servers"));

/** Reads one trimmed line into `scan`; returns why hoop can't be sure of the file, when this line makes it so. */
function readCodexLine(scan: Scan, line: string): string | undefined {
  if (scan.depth > 0) {
    scan.depth += opens(line);
    return undefined;
  }
  if (!line || line.startsWith("#")) return undefined;
  const t = tomlLine(line);
  if (!t) return hides(scan.table, line) ? `it has a line hoop can't read: ${line}` : undefined;
  // An escape in a quoted key could spell any name, hoop's too.
  if (/["'][^"']*\\/.test(t.raw)) return `it has a quoted key with an escape: ${t.raw}`;
  const keys = t.kind === "key" ? [...scan.table, ...t.keys] : t.keys;
  if (keys[0] === "mcp_servers" && keys.length === 1 && t.kind !== "table") return "it defines mcp_servers as an array or an inline table";
  if (keys[0] === "mcp_servers" && keys[1] === "hoop") scan.has = true;
  if (t.kind === "key") scan.depth = opens(t.value);
  else scan.table = keys;
  return undefined;
}

/** The newlines that leave one blank line between a file's text and what is appended to it. */
function gapBefore(text: string): string {
  if (!text || text.endsWith("\n\n")) return "";
  return text.endsWith("\n") ? "\n" : "\n\n";
}

function codexAgent(dir: string): Agent {
  const file = join(dir, "config.toml");
  return {
    name: "Codex CLI",
    dir,
    file,
    change: `add a [mcp_servers.hoop] table to ${file}`,
    has: (text) => scanCodex(text).has,
    refuse: (text) => {
      const unsure = scanCodex(text).unsure;
      return unsure ? `hoop can't read ${file} with certainty (${unsure})` : undefined;
    },
    add: (backup) => {
      // Read again: the file may have changed while the person was asked.
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      const scan = scanCodex(text);
      if (scan.has || scan.unsure) throw new Error(`${file} changed while hoop asked${scan.has ? " and has hoop now" : ""}, so hoop left it alone`);
      backup();
      appendFileSync(file, `${gapBefore(text)}${CODEX_TABLE}`);
    },
  };
}

/** The agents docs/using/other-agents.md covers, with their user config files under `home` (or the real home, with its overrides). */
export function knownAgents(home = agentsHome()): Agent[] {
  const h = home ?? homedir();
  const codex = (home ? undefined : process.env.CODEX_HOME) ?? join(h, ".codex");
  const config = (home ? undefined : process.env.XDG_CONFIG_HOME) ?? join(h, ".config");
  const cursor = join(h, ".cursor"),
    gemini = join(h, ".gemini"),
    opencode = join(config, "opencode");
  return [
    codexAgent(codex),
    jsonAgent("Cursor", cursor, join(cursor, "mcp.json"), "mcpServers", { type: "stdio", command: NPX[0], args: NPX.slice(1) }),
    jsonAgent("OpenCode", opencode, join(opencode, "opencode.json"), "mcp", { type: "local", command: [...NPX], enabled: true, timeout: 60000 }),
    jsonAgent("Gemini CLI", gemini, join(gemini, "settings.json"), "mcpServers", { command: NPX[0], args: NPX.slice(1) }),
  ];
}

/** An agent found here, and whether hoop is in its config already, can be added, or can't be. */
export type Found = { agent: Agent; state: "configured" | "missing" | "refused"; why?: string };

/** The agents installed here (their config folder exists), each with its state. Reads only. */
export function detectAgents(agents = knownAgents()): Found[] {
  return agents
    .filter((a) => existsSync(a.dir))
    .map((agent) => {
      let text = "";
      try {
        text = existsSync(agent.file) ? readFileSync(agent.file, "utf8") : "";
      } catch (err) {
        return { agent, state: "refused" as const, why: `${agent.file} can't be read (${err instanceof Error ? err.message : String(err)})` };
      }
      if (agent.has(text)) return { agent, state: "configured" as const };
      const why = agent.refuse(text);
      return why ? { agent, state: "refused" as const, why } : { agent, state: "missing" as const };
    });
}

/** Adds hoop to an agent's config, first copying the old file to `<file>.hoop-backup`. Returns the backup's path, if there was a file. */
export function addToAgent(agent: Agent): string | undefined {
  let backup: string | undefined;
  // The backup is made only once the file, read again, still takes hoop.
  agent.add(() => {
    if (existsSync(agent.file)) {
      backup = `${agent.file}.hoop-backup`;
      copyFileSync(agent.file, backup);
    } else mkdirSync(dirname(agent.file), { recursive: true });
  });
  return backup;
}

const LATER = "To add it later, run hoop init --agents, or see docs/using/other-agents.md.";

type StepOptions = {
  answer?: "yes" | "no";
  tty?: boolean;
  ask: (q: string) => Promise<boolean>;
  out: (s: string) => void;
  agents?: Agent[];
};

/** Whether the person says yes to adding hoop to `agent`: the flag's answer, else theirs on a terminal, else no. */
async function saysYes(agent: Agent, opts: StepOptions): Promise<boolean> {
  if (opts.answer) return opts.answer === "yes";
  if (!(opts.tty ?? Boolean(process.stdin.isTTY && process.stderr.isTTY))) return false;
  return opts.ask(`Found ${agent.name}. Add hoop to it? This will ${agent.change}. [y/N] `);
}

/** One agent found here: says it has hoop, can't take it, or adds it on a yes. Returns 1 when asked to change a config it can't. */
async function stepOne({ agent, state, why }: Found, opts: StepOptions): Promise<number> {
  if (state === "configured") {
    opts.out(`hoop: ${agent.name} already has hoop (${agent.file}).\n`);
    return 0;
  }
  if (state === "refused") {
    opts.out(`hoop: found ${agent.name}, but ${why}, so hoop left it alone; add hoop by hand: ${DOCS}\n`);
    return opts.answer === "yes" ? 1 : 0;
  }
  if (!(await saysYes(agent, opts))) {
    opts.out(`hoop: found ${agent.name} without hoop; left ${agent.file} as it is. ${LATER}\n`);
    return 0;
  }
  let backup: string | undefined;
  try {
    backup = addToAgent(agent);
  } catch (err) {
    opts.out(`hoop: didn't add hoop to ${agent.name}: ${err instanceof Error ? err.message : String(err)}; add hoop by hand: ${DOCS}\n`);
    return 1;
  }
  opts.out(`hoop: added hoop to ${agent.name} in ${agent.file}${backup ? ` (the old file is at ${backup})` : ""}. Restart ${agent.name} to use it.\n`);
  return 0;
}

/**
 * The other-agents step: for each agent found here without hoop, with `answer` yes or no it does that,
 * on a terminal it asks, and otherwise it only says what it found and how to add hoop. It writes a
 * config only on a yes. Returns the exit code: 1 when a config hoop was asked to change couldn't be.
 */
export async function agentsStep(opts: StepOptions): Promise<number> {
  let code = 0;
  for (const found of detectAgents(opts.agents)) code = Math.max(code, await stepOne(found, opts));
  return code;
}

/** What `hoop init --print` says about the agents found here: each one's file and whether hoop is in it. */
export function agentsPrint(agents?: Agent[]): string {
  const found = detectAgents(agents);
  if (!found.length) return "";
  const lines = found.map(({ agent, state }) => `  ${agent.name}: ${state === "configured" ? "has hoop" : "no hoop yet"} (${agent.file})`);
  return `\nOther agents found here:\n${lines.join("\n")}\nhoop init --agents adds hoop to each one without it; docs/using/other-agents.md has each config.\n`;
}
