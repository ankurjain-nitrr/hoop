import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { usesHome } from "../src/sessions.js";
import {
  asUser,
  BROWSER_SKIP,
  example,
  fakeSocket,
  registerLive,
  freePort,
  hoopArgs,
  lstart,
  mcpClient,
  pagesOn,
  TEST_SESSION,
  withBrowser,
} from "./helpers.js";

// #391: a hoop started on a throwaway HOOP_HOME from inside a Claude Code session inherits the
// session's ID. When that session's own hoop runs on the default home, the throwaway one keeps its
// reviews in its own home and its pages process sends the session nothing; with no such evidence,
// a custom home delivers as before.

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
 * listener, as a real session's would; a user folder of its own (HOME), whose `.hoop` is the default
 * home; and the environment a hoop started inside the session inherits: its session ID and that
 * folder (through CLAUDE_CONFIG_DIR, as Claude Code sets it), never HOOP_CLAUDE_DIR.
 */
async function realSession() {
  const claude = mkdtempSync(join(tmpdir(), "hoop-claude-real-"));
  const user = mkdtempSync(join(tmpdir(), "hoop-user-"));
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
    HOME: user,
    CLAUDE_CONFIG_DIR: claude,
    CLAUDE_CODE_SESSION_ID: SESSION,
    HOOP_HOME: home,
    HOOP_PORT: port,
    HOOP_REPO_DIR: repo,
    HOOP_PAGES: "off",
  });
  return { claude, user, defaultHome: join(user, ".hoop"), repo, sock, env };
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

/** Waits for `n` lines on the session's socket and returns the messages they carry. */
async function messages(sock: { lines: string[] }, n: number): Promise<string[]> {
  for (let i = 0; i < 100 && sock.lines.length < n; i++) await sleep(20);
  return sock.lines.map((l) => JSON.parse(l).message.content as string);
}

test("regression #391: a throwaway hoop home sends nothing to the session it was started from, keeps its reviews, and leaves nothing behind; the session's own home still wakes it", async () => {
  const s = await realSession();
  const homeB = mkdtempSync(join(tmpdir(), "hoop-home-b-"));
  const [portA, portB] = [String(await freePort()), String(await freePort())];
  // The session's own hoop: its MCP server registers in the default home, as the plugin's does.
  const mcp = await mcpClient(s.env(s.defaultHome, portA), { replaceEnv: true });
  try {
    await pagesOn(homeB, Number(portB), s.env(homeB, portB));
    await pagesOn(s.defaultHome, Number(portA), s.env(s.defaultHome, portA));

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

    // The default home, the session's own, still keeps its reviews in the session's folder and wakes it.
    const a = await personActs(s.env(s.defaultHome, portA), mkdtempSync(join(tmpdir(), "hoop-docs-a-")));
    assert.deepEqual(a.outcomes, ["sent", "sent", "sent"]);
    const texts = await messages(s.sock, 3);
    assert.equal(texts.length, 3);
    assert.match(texts[0]!, new RegExp(`build .* \\(${a.build}\\)`));
    assert.match(texts[1]!, /ana reviewed "Ship the export"/);
    assert.match(texts[2]!, /^Closed in hoop: Ship the export/);
    assert.ok(existsSync(join(s.claude, "projects", "-x-repo", SESSION, ".hoop", "reviews", a.review, "review.json")), "it lives in the session's folder");
  } finally {
    await mcp.close();
    s.sock.close();
  }
});

test("a session on a custom hoop home whose MCP server hasn't registered anywhere is still woken, and keeps its reviews in its folder", async () => {
  const s = await realSession();
  const home = mkdtempSync(join(tmpdir(), "hoop-home-custom-"));
  const port = String(await freePort());
  try {
    await pagesOn(home, Number(port), s.env(home, port));
    const acts = await personActs(s.env(home, port), mkdtempSync(join(tmpdir(), "hoop-docs-c-")));
    assert.deepEqual(acts.outcomes, ["sent", "sent", "sent"], "no evidence of another home: hoop delivers, as before");
    assert.equal((await messages(s.sock, 3)).length, 3);
    assert.ok(existsSync(join(s.claude, "projects", "-x-repo", SESSION, ".hoop", "reviews", acts.review, "review.json")));
  } finally {
    s.sock.close();
  }
});

test("a session uses a hoop home unless a live hoop MCP server for it, by ID or by its Claude Code process after /clear, runs on the default home", () => {
  const user = mkdtempSync(join(tmpdir(), "hoop-user-"));
  const custom = mkdtempSync(join(tmpdir(), "hoop-home-"));
  const proc = { pid: process.pid, start: "Fri Oct 23 17:11:53 2026" };
  asUser(user, () => {
    assert.equal(
      usesHome(custom, SESSION, () => proc),
      true,
      "no evidence anywhere: the session uses it",
    );
    assert.equal(usesHome(join(user, ".hoop"), SESSION), true, "every session uses the default home");
    registerLive(join(user, ".hoop"), SESSION, proc);
    assert.equal(usesHome(custom, SESSION), false, "its MCP server runs on the default home");
    assert.equal(
      usesHome(custom, "after-clear-0002", () => proc),
      false,
      "the same Claude Code process under a new ID",
    );
    assert.equal(
      usesHome(custom, "another-0003", () => ({ ...proc, start: "Sat Oct 24 09:00:00 2026" })),
      true,
      "another process",
    );
    assert.equal(usesHome(join(user, ".hoop"), SESSION), true, "the default home is still its own");
    registerLive(custom, SESSION, proc);
    assert.equal(usesHome(custom, SESSION), true, "an MCP server for it registered in the custom home too");
  });
  assert.equal(usesHome(mkdtempSync(join(tmpdir(), "hoop-home-")), SESSION), true, "HOOP_CLAUDE_DIR pairs a home with its own Claude Code folder");
});

test("the review page says a session that keeps its reviews in another home wasn't told, and what to do", { skip: BROWSER_SKIP }, async () => {
  const user = mkdtempSync(join(tmpdir(), "hoop-user-"));
  const proc = { pid: process.pid, start: lstart(Date.now() - process.uptime() * 1000) };
  registerLive(join(user, ".hoop"), TEST_SESSION, proc);
  const sock = await fakeSocket();
  const sessions = () => [{ session: TEST_SESSION, ...proc, status: "idle", socket: sock.path }];
  const { HOOP_CLAUDE_DIR: claude, HOME: home } = process.env;
  try {
    await withBrowser(
      async ({ hoop, base, page }) => {
        delete process.env.HOOP_CLAUDE_DIR;
        process.env.HOME = user;
        const { review_id } = hoop.submit(example());
        await page.goto(`${base}/r/${review_id}`);
        await page.locator(".agent-state", { hasText: "Claude's session is idle and keeps its reviews elsewhere" }).waitFor();
        const fb = await post(`${base}/api/reviews/${review_id}/feedback`, { verdict: "changes_requested", reviewer: "ana", summary: "Later.", comments: [] });
        assert.equal(fb.body.delivery.outcome, "other_home");
        await page.reload();
        await page.locator(".latest-receipt", { hasText: "Not read yet; Claude's session keeps its reviews elsewhere" }).waitFor();
        await post(`${base}/api/reviews/${review_id}/feedback`, { verdict: "approved", reviewer: "ana", comments: [] });
        await page.reload();
        await page.locator(".latest-receipt", { hasText: "Claude wasn't told; its session keeps its reviews elsewhere" }).waitFor();
        assert.deepEqual(sock.lines, []);
      },
      undefined,
      { sessions },
    );
  } finally {
    process.env.HOOP_CLAUDE_DIR = claude;
    process.env.HOME = home;
    sock.close();
  }
});
