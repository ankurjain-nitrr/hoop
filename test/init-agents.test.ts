// hoop init's other-agents step, on temporary homes only: no real ~/.codex, ~/.cursor or other config is read or written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToAgent, agentsStep, detectAgents, knownAgents } from "../src/agents.js";
import { init } from "../src/init.js";
import { hoopArgs } from "./helpers.js";

/** A temporary home with the given agents' folders, and files in them (path under home → text). */
function home(dirs: string[], files: Record<string, string> = {}) {
  const h = mkdtempSync(join(tmpdir(), "hoop-agents-test-"));
  for (const d of dirs) mkdirSync(join(h, d), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(h, f), text);
  return h;
}
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const byName = (h: string, name: string) => knownAgents(h).find((a) => a.name === name)!;
const ALL = [".codex", ".cursor", ".config/opencode", ".gemini"];

test("an agent is found by its config folder, and only those found are offered", () => {
  assert.deepEqual(detectAgents(knownAgents(home([]))), []);
  const h = home([".cursor", ".gemini"]);
  assert.deepEqual(
    detectAgents(knownAgents(h)).map((f) => [f.agent.name, f.state]),
    [
      ["Cursor", "missing"],
      ["Gemini CLI", "missing"],
    ],
  );
  assert.deepEqual(
    knownAgents(h).map((a) => a.file.slice(h.length)),
    ["/.codex/config.toml", "/.cursor/mcp.json", "/.config/opencode/opencode.json", "/.gemini/settings.json"],
  );
});

test("the real home's CODEX_HOME and XDG_CONFIG_HOME are honored, and HOOP_AGENTS_HOME overrides both", () => {
  const saved = { home: process.env.HOOP_AGENTS_HOME, codex: process.env.CODEX_HOME, xdg: process.env.XDG_CONFIG_HOME };
  try {
    delete process.env.HOOP_AGENTS_HOME;
    process.env.CODEX_HOME = "/tmp/codex-home";
    process.env.XDG_CONFIG_HOME = "/tmp/xdg";
    // Paths only: nothing is read.
    const [codex, , opencode] = knownAgents();
    assert.equal(codex!.file, "/tmp/codex-home/config.toml");
    assert.equal(opencode!.file, "/tmp/xdg/opencode/opencode.json");
    assert.equal(knownAgents("/tmp/h")[0]!.file, "/tmp/h/.codex/config.toml");
  } finally {
    process.env.HOOP_AGENTS_HOME = saved.home;
    for (const [k, v] of [
      ["CODEX_HOME", saved.codex],
      ["XDG_CONFIG_HOME", saved.xdg],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

/** The fenced block after "**<name>**" in docs/using/other-agents.md. */
function docsBlock(name: string): string {
  const doc = readFileSync(new URL("../docs/using/other-agents.md", import.meta.url), "utf8");
  const at = doc.indexOf(`**${name}**`);
  const m = /```\w*\n([\s\S]*?)```/.exec(doc.slice(at));
  return m![1]!;
}

test("hoop goes into each agent's config as docs/using/other-agents.md gives it, keeping everything else, with a backup", () => {
  const cursorOld = `{\n  "mcpServers": { "other": { "command": "x" } },\n  "theme": "dark"\n}\n`;
  const opencodeOld = `{ "$schema": "https://opencode.ai/config.json", "model": "m" }`;
  const codexOld = `model = "o3"\n\n[mcp_servers.other]\ncommand = "x"`;
  const h = home(ALL, { ".cursor/mcp.json": cursorOld, ".config/opencode/opencode.json": opencodeOld, ".codex/config.toml": codexOld });

  const cursor = byName(h, "Cursor");
  assert.equal(addToAgent(cursor), `${cursor.file}.hoop-backup`);
  assert.equal(readFileSync(`${cursor.file}.hoop-backup`, "utf8"), cursorOld, "the backup is the old file, byte for byte");
  const docCursor = JSON.parse(docsBlock("Cursor")).mcpServers.hoop;
  assert.deepEqual(read(cursor.file), { mcpServers: { other: { command: "x" }, hoop: docCursor }, theme: "dark" });

  const opencode = byName(h, "OpenCode");
  addToAgent(opencode);
  assert.deepEqual(read(opencode.file), { $schema: "https://opencode.ai/config.json", model: "m", mcp: { hoop: JSON.parse(docsBlock("OpenCode")).mcp.hoop } });

  // No file yet: it is made, with nothing to back up.
  const gemini = byName(h, "Gemini CLI");
  assert.equal(addToAgent(gemini), undefined);
  assert.deepEqual(read(gemini.file), JSON.parse(docsBlock("Gemini CLI")));

  // Codex's TOML gets the docs' table appended after a blank line, and the rest stays as it was.
  const codex = byName(h, "Codex CLI");
  addToAgent(codex);
  assert.equal(readFileSync(codex.file, "utf8"), `${codexOld}\n\n${docsBlock("Codex CLI")}`);

  assert.deepEqual(
    detectAgents(knownAgents(h)).map((f) => f.state),
    ["configured", "configured", "configured", "configured"],
  );
});

const codexState = (text: string) => detectAgents([byName(home([".codex"], { ".codex/config.toml": text }), "Codex CLI")])[0]!;

test("Codex's config counts hoop in any form, and one hoop can't read with certainty is left alone", async () => {
  for (const text of [
    '[mcp_servers."hoop"]\ncommand = "npx"\n',
    "[ mcp_servers.hoop ]\n",
    "[mcp_servers.hoop.env]\nX = '1'\n",
    'mcp_servers.hoop.command = "npx"\n',
    // Regression: hoop's server as a key of [mcp_servers] was missed, and init appended a second hoop that broke the file.
    '[mcp_servers]\nhoop = { command = "npx", args = ["-y", "@ankurjain-nitrr/hoop", "mcp"] }\n',
    '[mcp_servers]\nhoop.command = "npx"\nhoop.args = ["mcp"]\n',
    "[mcp_servers]\n\"hoop\" = { command = 'npx' } # hoop\n",
  ])
    assert.equal(codexState(text).state, "configured", text);
  for (const text of [
    "[mcp_servers.hoopla]\n",
    '[mcp_servers]\nother = { command = "x" }\n',
    // A multi-line array whose lines look like headers isn't read as tables.
    'model = "o3"\nlist = [\n  [1],\n  [2],\n]\n[mcp_servers.other]\ncommand = "x"\n',
  ])
    assert.equal(codexState(text).state, "missing", text);
  for (const [text, why] of [
    ['mcp_servers = { other = { command = "x" } }\n', /as an array or an inline table/],
    ["[[mcp_servers]]\n", /as an array or an inline table/],
    ['[mcp_servers]\nother.args = [\n  "x",\n]\n', undefined],
    // A header inside a multi-line string isn't a table; with no hoop outside it, the file is unsure.
    ['notes = """\n[mcp_servers.hoop]\n"""\n', /multi-line strings/],
    ['[mcp_servers]\n{ weird = "x" }\n', /a line hoop can't read: \{ weird = "x" \}/],
    // An escape in a quoted key could spell hoop's name.
    ['[mcp_servers]\n"ho\\u006fp" = { command = "npx" }\n', /a quoted key with an escape: "ho\\u006fp"/],
  ] as const) {
    const found = codexState(text);
    if (why) {
      assert.equal(found.state, "refused", text);
      assert.match(found.why!, why);
    } else assert.equal(found.state, "missing", text);
  }

  // Regression: a multi-line string anywhere made a config that has hoop read as unsure.
  assert.equal(codexState('developer_instructions = """\nhi\n"""\n[mcp_servers.hoop]\ncommand="npx"\n').state, "configured");
  assert.equal(codexState("x = '''one line'''\n").state, "missing", "a multi-line delimiter closed on its line is no multi-line string");

  // Regression: `\"""` was read as closing the string, so the hoop key in [mcp_servers] below it was
  // taken for one in [other], and init appended a second hoop table that broke the file.
  const tricky = '[mcp_servers]\na = """x\\"""\n[other]\n"""  # """\nhoop = { command = "y" }\n';
  const trickyState = codexState(tricky);
  assert.deepEqual(
    [trickyState.state, trickyState.why],
    ["refused", `hoop can't read ${trickyState.agent.file} with certainty (it has a multi-line string with escapes)`],
  );
  const th = home([".codex"], { ".codex/config.toml": tricky });
  assert.equal(await agentsStep({ answer: "yes", agents: knownAgents(th), ask: async () => true, out: () => {} }), 1);
  assert.equal(readFileSync(join(th, ".codex/config.toml"), "utf8"), tricky, "the file is unchanged");
  assert.equal(existsSync(join(th, ".codex/config.toml.hoop-backup")), false);
  // A literal string's backslash escapes nothing: '''x\''' closes.
  assert.equal(codexState("a = '''x\\'''\n[mcp_servers.other]\ncommand = \"x\"\n").state, "missing");

  // Regression: an unterminated string of escaped quotes made the scan quadratic (seconds on 100 KB).
  const started = performance.now();
  assert.equal(codexState(`[mcp_servers.other]\nargs = ["${'\\"'.repeat(50_000)}\n`).state, "missing");
  assert.ok(performance.now() - started < 200, `${Math.round(performance.now() - started)} ms`);

  // The [mcp_servers] form with hoop isn't appended to again.
  const text = '[mcp_servers]\nhoop = { command = "npx" }\n';
  const h = home([".codex"], { ".codex/config.toml": text });
  let out = "";
  assert.equal(await agentsStep({ answer: "yes", agents: knownAgents(h), ask: async () => true, out: (s) => void (out += s) }), 0);
  assert.match(out, /Codex CLI already has hoop/);
  assert.equal(readFileSync(join(h, ".codex/config.toml"), "utf8"), text);
});

test("a JSON config hoop can't merge into is left alone, and asking to change it fails the step", async () => {
  for (const text of ["{ not json", "[1]", `{"mcpServers": "x"}`, `{"mcpServers": [1]}`, '{\n  // mine\n  "mcpServers": {}\n}\n']) {
    const h = home([".cursor"], { ".cursor/mcp.json": text });
    let out = "";
    const code = await agentsStep({ answer: "yes", agents: knownAgents(h), ask: async () => true, out: (s) => void (out += s) });
    assert.equal(code, 1, text);
    assert.match(
      out,
      /found Cursor, but .* so hoop left it alone; add hoop by hand: https:\/\/github\.com\/ankurjain-nitrr\/hoop\/blob\/main\/docs\/using\/other-agents\.md/,
    );
    assert.equal(readFileSync(join(h, ".cursor/mcp.json"), "utf8"), text);
    assert.equal(existsSync(join(h, ".cursor/mcp.json.hoop-backup")), false);
  }
  // A file with comments (JSONC) is named as such.
  assert.match(
    detectAgents([byName(home([".cursor"], { ".cursor/mcp.json": '{ /* c */ "a": 1 }' }), "Cursor")])[0]!.why!,
    /mcp\.json can't be read as plain JSON \(it may have comments\)/,
  );
});

test("a JSON config keeps its indentation, final newline and file mode", () => {
  for (const [text, want] of [
    ['{\n\t"a": 1\n}\n', '{\n\t"a": 1,\n\t"mcpServers": {\n\t\t"hoop": '],
    ['{\n    "a": 1\n}', '{\n    "a": 1,\n    "mcpServers": {\n        "hoop": '],
    ['{"a":1}\n', '{"a":1,"mcpServers":{"hoop":'],
  ] as const) {
    const h = home([".cursor"], { ".cursor/mcp.json": text });
    addToAgent(byName(h, "Cursor"));
    const after = readFileSync(join(h, ".cursor/mcp.json"), "utf8");
    assert.ok(after.startsWith(want), after);
    assert.equal(after.endsWith("\n"), text.endsWith("\n"), "a final newline only when the file had one");
  }
  // Windows line endings stay.
  const crlf = home([".cursor"], { ".cursor/mcp.json": '{\r\n  "a": 1\r\n}\r\n' });
  addToAgent(byName(crlf, "Cursor"));
  const crlfAfter = readFileSync(join(crlf, ".cursor/mcp.json"), "utf8");
  assert.ok(crlfAfter.endsWith("}\r\n") && !/[^\r]\n/.test(crlfAfter), JSON.stringify(crlfAfter));
  const crlfOne = home([".cursor"], { ".cursor/mcp.json": '{"a":1}\r\n' });
  addToAgent(byName(crlfOne, "Cursor"));
  const oneAfter = readFileSync(join(crlfOne, ".cursor/mcp.json"), "utf8");
  assert.ok(oneAfter.startsWith('{"a":1,"mcpServers"') && oneAfter.endsWith("}\r\n") && !/[^\r]\n/.test(oneAfter), JSON.stringify(oneAfter));

  // Regression: a file only its owner could read became readable by everyone.
  const h = home([".cursor"], { ".cursor/mcp.json": "{}\n" });
  chmodSync(join(h, ".cursor/mcp.json"), 0o600);
  addToAgent(byName(h, "Cursor"));
  assert.equal(statSync(join(h, ".cursor/mcp.json")).mode & 0o777, 0o600);
  // A tight umask doesn't narrow a file's mode either.
  const wide = home([".cursor"], { ".cursor/mcp.json": "{}\n" });
  chmodSync(join(wide, ".cursor/mcp.json"), 0o644);
  const umask = process.umask(0o077);
  try {
    addToAgent(byName(wide, "Cursor"));
  } finally {
    process.umask(umask);
  }
  assert.equal(statSync(join(wide, ".cursor/mcp.json")).mode & 0o777, 0o644);
});

test("a config that changed while the person was asked is read again, and one hoop can't merge into now is left alone", async () => {
  const h = home([".cursor", ".codex"], { ".cursor/mcp.json": "{}\n" });
  let out = "";
  const code = await agentsStep({
    tty: true,
    agents: knownAgents(h),
    // While the question waits, the person edits the files.
    ask: async () => {
      writeFileSync(join(h, ".cursor/mcp.json"), "{ // now with a comment\n}\n");
      writeFileSync(join(h, ".codex/config.toml"), '[mcp_servers]\nhoop = { command = "npx" }\n');
      return true;
    },
    out: (s) => void (out += s),
  });
  assert.equal(code, 1);
  assert.match(out, /didn't add hoop to Cursor: .*mcp\.json can't be read as plain JSON \(it may have comments\) now, so hoop left it alone/);
  assert.match(out, /didn't add hoop to Codex CLI: .*config\.toml changed while hoop asked and has hoop now/);
  assert.equal(readFileSync(join(h, ".cursor/mcp.json"), "utf8"), "{ // now with a comment\n}\n");
  assert.equal(readFileSync(join(h, ".codex/config.toml"), "utf8"), '[mcp_servers]\nhoop = { command = "npx" }\n');
  // No backup of a file hoop then didn't change.
  assert.equal(existsSync(join(h, ".cursor/mcp.json.hoop-backup")), false);
  assert.equal(existsSync(join(h, ".codex/config.toml.hoop-backup")), false);
});

test("a config is written only after a yes: on a terminal it asks about each agent, a flag answers for all, and otherwise it only says what it found", async () => {
  const step = async (opts: { answer?: "yes" | "no"; tty?: boolean; yes?: (q: string) => boolean }) => {
    const h = home([".cursor", ".gemini"]);
    const asked: string[] = [];
    let out = "";
    const code = await agentsStep({
      ...opts,
      agents: knownAgents(h),
      ask: async (q) => (asked.push(q), Boolean(opts.yes?.(q))),
      out: (s) => void (out += s),
    });
    const written = ["Cursor", "Gemini CLI"].filter((n) => existsSync(byName(h, n).file));
    return { code, asked, out, written };
  };
  // On a terminal: one question per agent, with what it will change; only the yes is written.
  const asks = await step({ tty: true, yes: (q) => q.includes("Gemini") });
  assert.equal(asks.asked.length, 2);
  assert.match(asks.asked[0]!, /^Found Cursor\. Add hoop to it\? This will add "hoop" under "mcpServers" in .*\/\.cursor\/mcp\.json\. \[y\/N\] $/);
  assert.deepEqual(asks.written, ["Gemini CLI"]);
  assert.match(asks.out, /found Cursor without hoop; left .*mcp\.json as it is\. To add it later, run hoop init --agents/);
  assert.match(asks.out, /added hoop to Gemini CLI in .*settings\.json\. Restart Gemini CLI to use it\./);

  // No terminal and no flag: nothing is asked or written.
  const quiet = await step({ tty: false, yes: () => true });
  assert.deepEqual([quiet.asked.length, quiet.written, quiet.code], [0, [], 0]);
  assert.match(quiet.out, /found Cursor without hoop; left .* as it is/);

  const all = await step({ answer: "yes", tty: true });
  assert.deepEqual([all.asked.length, all.written], [0, ["Cursor", "Gemini CLI"]]);
  const none = await step({ answer: "no", tty: true, yes: () => true });
  assert.deepEqual([none.asked.length, none.written], [0, []]);

  // An agent that has hoop already isn't asked about again.
  const h = home([".cursor"]);
  addToAgent(byName(h, "Cursor"));
  const asked: string[] = [];
  let out = "";
  await agentsStep({ tty: true, agents: knownAgents(h), ask: async (q) => (asked.push(q), true), out: (s) => void (out += s) });
  assert.deepEqual(asked, []);
  assert.match(out, /Cursor already has hoop/);
});

test("hoop init --print lists the agents found and changes nothing", async () => {
  const h = home([".cursor", ".codex"], { ".codex/config.toml": '[mcp_servers.hoop]\ncommand = "npx"\n' });
  let out = "";
  const settings = join(mkdtempSync(join(tmpdir(), "hoop-settings-")), "settings.json");
  assert.equal(await init({ print: true, agentList: knownAgents(h), settings, out: (s) => void (out += s) }), 0);
  assert.match(
    out,
    /Other agents found here:\n {2}Codex CLI: has hoop \(.*config\.toml\)\n {2}Cursor: no hoop yet \(.*mcp\.json\)\nhoop init --agents adds hoop/,
  );
  assert.equal(existsSync(join(h, ".cursor/mcp.json")), false);
});

test("hoop init takes --agents or --no-agents but not both, and finds agents in HOOP_AGENTS_HOME", () => {
  const h = home([".cursor"]);
  const env = {
    ...process.env,
    HOOP_AGENTS_HOME: h,
    HOOP_CLAUDE_DIR: mkdtempSync(join(tmpdir(), "hoop-claude-init-")),
    PATH: `${mkdtempSync(join(tmpdir(), "hoop-nobin-"))}:/usr/bin:/bin`,
  };
  const hoop = (...args: string[]) => spawnSync(process.execPath, [...hoopArgs, "init", "--no", "--no-browser", ...args], { encoding: "utf8", env });
  const quiet = hoop();
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stdout, /found Cursor without hoop/);
  assert.equal(existsSync(join(h, ".cursor/mcp.json")), false, "without a terminal or a flag, nothing changes");
  assert.equal(hoop("--no-agents").status, 0);
  assert.equal(existsSync(join(h, ".cursor/mcp.json")), false);
  const yes = hoop("--agents");
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(read(join(h, ".cursor/mcp.json")).mcpServers.hoop.command, "npx");
  assert.match(hoop("--agents").stdout, /Cursor already has hoop/);
  assert.equal(hoop("--agents", "--no-agents").status, 2);
});
