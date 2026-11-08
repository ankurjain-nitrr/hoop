// `hoop init`'s other-agents step: finds the MCP agent tools on this machine that docs/using/other-agents.md
// covers (Codex CLI, Cursor, OpenCode, Gemini CLI) by their user config folders, and adds hoop's MCP
// server to each one's user config only after the person says yes. It never writes without that, keeps
// the old file as `<file>.hoop-backup`, and leaves alone a file it can't merge into.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { tryReadJson, writeJson } from "./util.js";

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
  /** Adds hoop's server to the config. */
  add: () => void;
};

const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A JSON config that keeps its servers under `key`: hoop goes in as `key.hoop`, with every other key kept. */
function jsonAgent(name: string, dir: string, file: string, key: string, entry: Json): Agent {
  const parsed = (text: string) => {
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };
  return {
    name,
    dir,
    file,
    change: `add "hoop" under "${key}" in ${file}`,
    has: (text) => {
      const v = parsed(text);
      return isObject(v) && isObject(v[key]) && "hoop" in v[key];
    },
    refuse: (text) => {
      const v = parsed(text);
      if (!isObject(v)) return `${file} isn't a JSON object`;
      if (v[key] !== undefined && !isObject(v[key])) return `"${key}" in ${file} isn't an object`;
      return undefined;
    },
    add: () => {
      const v = (existsSync(file) ? tryReadJson(file) : undefined) ?? {};
      const settings = isObject(v) ? v : {};
      const servers = isObject(settings[key]) ? settings[key] : {};
      writeJson(file, { ...settings, [key]: { ...servers, hoop: entry } });
    },
  };
}

// Codex's config is TOML: hoop finds its own table by its header, and appends one when there is none.
const CODEX_HOOP = /^\s*\[\s*mcp_servers\s*\.\s*(?:hoop|"hoop"|'hoop')\s*\]|^\s*mcp_servers\s*\.\s*(?:hoop|"hoop")\s*\./m;
// `mcp_servers = { … }` or `[[mcp_servers]]` can't take another table appended after it.
const CODEX_INLINE = /^\s*mcp_servers\s*=|^\s*\[\[\s*mcp_servers\s*\]\]/m;
const CODEX_TABLE = `[mcp_servers.hoop]\ncommand = "npx"\nargs = ["-y", "@ankurjain-nitrr/hoop", "mcp"]\nstartup_timeout_sec = 60\n`;

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
    has: (text) => CODEX_HOOP.test(text),
    refuse: (text) => (CODEX_INLINE.test(text) ? `${file} defines mcp_servers in a way hoop can't add a table to` : undefined),
    add: () => {
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
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
  if (existsSync(agent.file)) {
    backup = `${agent.file}.hoop-backup`;
    copyFileSync(agent.file, backup);
  } else mkdirSync(dirname(agent.file), { recursive: true });
  agent.add();
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
    opts.out(`hoop: found ${agent.name}, but ${why}, so hoop left it alone. See docs/using/other-agents.md to add hoop yourself.\n`);
    return opts.answer === "yes" ? 1 : 0;
  }
  if (!(await saysYes(agent, opts))) {
    opts.out(`hoop: found ${agent.name} without hoop; left ${agent.file} as it is. ${LATER}\n`);
    return 0;
  }
  const backup = addToAgent(agent);
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
