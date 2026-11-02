import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { usesHome } from "../src/sessions.js";
import { fakeSocket, freePort, hoopArgs, lstart, mcpClient, pagesOn } from "./helpers.js";

// #391: a hoop started on a throwaway HOOP_HOME from inside a Claude Code session inherits the
// session's ID. It keeps its reviews in its own home, and its pages process sends that session
// nothing, while the session's own hoop home still wakes it.

const SESSION = "fake-real-0001";
const OUTLINE = "# Cutting cloud cost\n\nWhat this document helps decide.\n\n## Where the money goes\n\nOld guess.\n\n## Options\n";
const DOC = "# Ship the export\n\nWhether to ship the order export this week.\n\n## Plan\n\nShip on Friday.\n";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

/** Every path under `dir` whose name is `name`. */
function findNamed(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((p) => p.split("/").includes(name));
}

/**
 * A Claude Code folder with one live session, this test process, that takes messages on a local
 * listener, as a real session's would; and the environment a hoop started inside it inherits: its
 * session ID and that folder (through CLAUDE_CONFIG_DIR, as Claude Code sets it), never HOOP_CLAUDE_DIR.
 */
async function realSession() {
  const claude = mkdtempSync(join(tmpdir(), "hoop-claude-real-"));
  const repo = mkdtempSync(join(tmpdir(), "hoop-repo-real-"));
  mkdirSync(join(claude, "projects", "-x-repo"), { recursive: true });
  writeFileSync(join(claude, "projects", "-x-repo", `${SESSION}.jsonl`), `${JSON.stringify({ type: "user", sessionId: SESSION })}\n`);
  const sock = await fakeSocket();
  mkdirSync(join(claude, "sessions"), { recursive: true });
  writeFileSync(
    join(claude, "sessions", `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: SESSION,
      cwd: repo,
      procStart: lstart(Date.now() - process.uptime() * 1000),
      status: "idle",
      messagingSocketPath: sock.path,
    }),
  );
  const { HOOP_CLAUDE_DIR: _c, ...rest } = process.env;
  const env = (home: string, port: string): Record<string, string> => ({
    ...(rest as Record<string, string>),
    CLAUDE_CONFIG_DIR: claude,
    CLAUDE_CODE_SESSION_ID: SESSION,
    HOOP_HOME: home,
    HOOP_PORT: port,
    HOOP_REPO_DIR: repo,
    HOOP_PAGES: "off",
  });
  return { claude, repo, sock, env };
}

/** Runs one hoop command with `env` and returns its JSON answer. */
async function hoopJson(env: Record<string, string>, args: string[]): Promise<{ review_id: string }> {
  const { stdout } = await promisify(execFile)(process.execPath, [...hoopArgs, ...args, "--json"], { env });
  return JSON.parse(stdout);
}

/**
 * From a home on its own pages process: a build with a Generate, and a review with a submitted
 * review and a close. Returns their IDs and how each person's step reached the session.
 */
async function personActs(env: Record<string, string>, dir: string) {
  const base = `http://127.0.0.1:${env.HOOP_PORT}`;
  writeFileSync(join(dir, "outline.md"), OUTLINE);
  writeFileSync(join(dir, "doc.md"), DOC);
  const build = (await hoopJson(env, ["build", join(dir, "outline.md")])).review_id;
  const review = (await hoopJson(env, ["submit", join(dir, "doc.md")])).review_id;
  const gen = await post(`${base}/api/reviews/${build}/build`, { op: "generate", block: "b3" });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const fb = await post(`${base}/api/reviews/${review}/feedback`, { verdict: "changes_requested", reviewer: "ana", summary: "Ship it Monday.", comments: [] });
  assert.equal(fb.status, 201, JSON.stringify(fb.body));
  const close = await post(`${base}/api/reviews/${review}/close`, { reason: "Not needed" });
  assert.equal(close.status, 201, JSON.stringify(close.body));
  const deliveries = async (id: string) => (await (await fetch(`${base}/api/reviews/${id}`)).json()).deliveries;
  return { build, review, outcomes: [(await deliveries(build))["build:g1"].outcome, fb.body.delivery.outcome, close.body.delivery.outcome] };
}

test("regression #391: a throwaway hoop home sends nothing to the session it was started from, keeps its reviews, and leaves nothing behind; the session's own home still wakes it", async () => {
  const s = await realSession();
  const homeA = mkdtempSync(join(tmpdir(), "hoop-home-a-"));
  const homeB = mkdtempSync(join(tmpdir(), "hoop-home-b-"));
  const [portA, portB] = [String(await freePort()), String(await freePort())];
  // The session's own hoop: its MCP server registers in home A, as the plugin's does.
  const mcp = await mcpClient(s.env(homeA, portA), { replaceEnv: true });
  try {
    await pagesOn(homeB, Number(portB), s.env(homeB, portB));
    await pagesOn(homeA, Number(portA), s.env(homeA, portA));

    // Home B, the throwaway one, started with the session's environment.
    const b = await personActs(s.env(homeB, portB), mkdtempSync(join(tmpdir(), "hoop-docs-b-")));
    assert.deepEqual(b.outcomes, ["other_home", "other_home", "other_home"], "each step is recorded as not sent, with why");
    await sleep(300);
    assert.deepEqual(s.sock.lines, [], "the session's socket received nothing from home B");
    for (const id of [b.build, b.review]) {
      assert.ok(existsSync(join(homeB, "reviews", id, "review.json")), `${id} lives in home B`);
      assert.deepEqual(findNamed(s.claude, id), [], `nothing of ${id} is in the Claude Code folder`);
    }
    rmSync(homeB, { recursive: true, force: true });
    assert.deepEqual([...findNamed(s.claude, b.build), ...findNamed(s.claude, b.review)], [], "removing home B leaves nothing of it behind");

    // Home A, the session's own, still keeps its reviews in the session's folder and wakes it.
    const a = await personActs(s.env(homeA, portA), mkdtempSync(join(tmpdir(), "hoop-docs-a-")));
    assert.deepEqual(a.outcomes, ["sent", "sent", "sent"]);
    for (let i = 0; i < 100 && s.sock.lines.length < 3; i++) await sleep(20);
    const texts = s.sock.lines.map((l) => JSON.parse(l).message.content as string);
    assert.equal(texts.length, 3);
    assert.match(texts[0]!, new RegExp(`build .* \\(${a.build}\\)`));
    assert.match(texts[1]!, /ana reviewed "Ship the export"/);
    assert.match(texts[2]!, /^Closed in hoop: Ship the export/);
    assert.ok(
      existsSync(join(s.claude, "projects", "-x-repo", SESSION, ".hoop", "reviews", a.review, "review.json")),
      "home A keeps it in the session's folder",
    );
  } finally {
    await mcp.close();
    s.sock.close();
  }
});

test("a home other than the default is a session's when a hoop MCP server for it registered there, by its ID or by its Claude Code process after /clear", () => {
  const home = mkdtempSync(join(tmpdir(), "hoop-home-"));
  const { HOOP_CLAUDE_DIR: saved } = process.env;
  delete process.env.HOOP_CLAUDE_DIR;
  try {
    const proc = { pid: process.pid, start: "Fri Oct 23 17:11:53 2026" };
    assert.equal(
      usesHome(home, SESSION, () => proc),
      false,
      "no hoop MCP server registered there",
    );
    mkdirSync(join(home, "sessions"));
    const entry = {
      format: 1,
      pid: process.pid,
      started: 1,
      boot: 1,
      repo: "/x",
      claude: SESSION,
      process: proc,
      install: "/i",
      release: "0",
      start: ["node"],
    };
    writeFileSync(join(home, "sessions", `${process.pid}.json`), JSON.stringify(entry));
    assert.equal(usesHome(home, SESSION), true);
    assert.equal(
      usesHome(home, "after-clear-0002", () => proc),
      true,
      "the same Claude Code process under a new ID",
    );
    assert.equal(
      usesHome(home, "another-0003", () => ({ ...proc, start: "Sat Oct 24 09:00:00 2026" })),
      false,
    );
    process.env.HOOP_CLAUDE_DIR = saved;
    assert.equal(usesHome(mkdtempSync(join(tmpdir(), "hoop-home-")), "another-0003"), true, "HOOP_CLAUDE_DIR pairs a home with its own Claude Code folder");
  } finally {
    process.env.HOOP_CLAUDE_DIR = saved;
  }
});
