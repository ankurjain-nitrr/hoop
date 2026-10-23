import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { OPS } from "../src/ops.js";
import { INSTRUCTIONS } from "../src/mcp.js";
import { type GhRunner, openedPr, PrStates, prState, trackedPrs } from "../src/prs.js";
import { createWebServer, prSummary } from "../src/web.js";
import { BROWSER_SKIP, cli, example, mcpClient, TEST_SESSION, tempHome, tsx, withBrowser } from "./helpers.js";

const GH = JSON.parse(readFileSync(new URL("./fixtures/gh-pr-view.json", import.meta.url), "utf8"));
const URL_A = "https://github.com/acme/shop/pull/42";
const track = OPS.find((o) => o.name === "track_pr")!;
const wrapper = new URL("../plugins/hoop-plan/hooks/track-pr.sh", import.meta.url).pathname;

/** A `gh` stand-in: `pr view <url>` answers from `views` (a fixture case or an error), `api user` with `login`. */
function fakeGh(views: Record<string, unknown>, login = "octocat") {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "api") return `${login}\n`;
    const v = views[args[2]!];
    if (v === undefined || v instanceof Error) throw v ?? new Error("no such pull request");
    return JSON.stringify(v);
  };
  return { gh, calls };
}

/** Claude Code's PostToolUse input for a Bash call. */
const hookInput = (command: string, stdout: string, session = "sess-hook-1") => ({
  session_id: session,
  transcript_path: `/Users/me/.claude/projects/-repo/${session}.jsonl`,
  cwd: "/Users/me/repo",
  permission_mode: "default",
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command, description: "Open a pull request" },
  tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
  tool_use_id: "toolu_01",
});
const CREATE_OUT = "\nCreating pull request for feat/export into main in acme/shop\n\nhttps://github.com/acme/shop/pull/42\n";

test("hoop_track_pr records a pull request for its session once, and refuses other URLs or no session", () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home), "sess-a");
  for (const bad of [
    "https://github.com/acme/shop/issues/42",
    "http://github.com/acme/shop/pull/42",
    "https://gitlab.com/a/b/pull/1",
    "acme/shop#42",
    "https://github.com/acme/shop/pull/0",
  ])
    assert.throws(() => track.run(hoop, { url: bad }, { actor: "claude" }), /expected a GitHub pull request URL/, bad);
  const first = track.run(hoop, { url: `${URL_A}/` }, { actor: "claude" }) as { url: string; already: boolean; owner: string };
  assert.equal(first.url, URL_A);
  assert.equal(first.already, false);
  assert.equal(first.owner, "session sess-a");
  const again = track.run(new Hoop(new Store(home), "sess-b"), { url: URL_A }, { actor: "claude" }) as { already: boolean; owner: string };
  assert.equal(again.already, true);
  assert.equal(again.owner, "session sess-a", "the session that opened it keeps it");
  assert.deepEqual(
    trackedPrs(home).map((p) => [p.url, p.owner.session]),
    [[URL_A, "sess-a"]],
  );
  assert.throws(() => track.run(new Hoop(new Store(home), null), { url: URL_A }, { actor: "me" }), /isn't in a Claude Code session/);
});

test("hoop track-pr works from a session's shell, and refuses a bad URL or a terminal outside a session", () => {
  const home = tempHome();
  const run = (args: string[], session?: string) => {
    const env = { ...process.env, HOOP_HOME: home } as Record<string, string | undefined>;
    if (session) env.CLAUDE_CODE_SESSION_ID = session;
    else delete env.CLAUDE_CODE_SESSION_ID;
    return spawnSync(process.execPath, [tsx, cli, ...args], { encoding: "utf8", env });
  };
  const bad = run(["track-pr", "https://github.com/acme/shop"], "sess-cli");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /pull request URL/);
  assert.equal(run(["track-pr", URL_A]).status, 1);
  const ok = run(["track-pr", URL_A, "--json"], "sess-cli");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).tracked, true);
  assert.equal(trackedPrs(home)[0]!.owner.session, "sess-cli");
});

test("hoop_track_pr works over MCP, and the instructions say when to call it", async () => {
  const home = tempHome();
  const mcp = await mcpClient({ HOOP_HOME: home });
  try {
    const r = await mcp.call("hoop_track_pr", { url: URL_A });
    assert.equal(r.isError, false);
    assert.equal(trackedPrs(home)[0]!.owner.session, TEST_SESSION);
    assert.equal((await mcp.call("hoop_track_pr", { url: "not a url" })).isError, true);
  } finally {
    await mcp.close();
  }
  assert.match(INSTRUCTIONS, /other than `gh pr create`, call hoop_track_pr/);
});

test("the hook finds the pull request gh pr create printed, and nothing else", () => {
  assert.equal(openedPr(hookInput('gh pr create --title "Add export" --body-file /tmp/b.md', CREATE_OUT)), URL_A);
  assert.equal(openedPr(hookInput("git push -u origin feat && gh pr create --fill", `${CREATE_OUT}`)), URL_A);
  assert.equal(openedPr(hookInput("gh pr view 42", CREATE_OUT)), undefined, "another gh command");
  assert.equal(openedPr(hookInput("echo gh pr creation", CREATE_OUT)), undefined);
  assert.equal(openedPr(hookInput("gh pr create --fill", "a pull request for branch already exists")), undefined);
  assert.equal(openedPr(hookInput("gh pr create --fill", "https://github.com/acme/shop/pull/42/files")), undefined);
  assert.equal(openedPr({}), undefined);
});

test("hoop pr-hook records the pull request for the hook's session, ignores other commands, and never fails", () => {
  const home = tempHome();
  const run = (input: string) => {
    const env = { ...process.env, HOOP_HOME: home } as Record<string, string | undefined>;
    delete env.CLAUDE_CODE_SESSION_ID;
    return spawnSync(process.execPath, [tsx, cli, "pr-hook"], { input, encoding: "utf8", env });
  };
  for (const input of [JSON.stringify(hookInput("ls -la", "total 0\n")), "not json", "", JSON.stringify(hookInput("gh pr create", CREATE_OUT, "../bad id"))]) {
    const r = run(input);
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout + r.stderr, "", "quiet");
  }
  assert.deepEqual(trackedPrs(home), []);
  const r = run(JSON.stringify(hookInput("gh pr create --fill", CREATE_OUT, "sess-hook-1")));
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
  assert.deepEqual(
    trackedPrs(home).map((p) => [p.url, p.owner.session]),
    [[URL_A, "sess-hook-1"]],
  );
});

test("the plugin's hook wrapper always exits 0 quietly, and tracks through hoop", () => {
  const home = tempHome();
  const bin = mkdtempSync(join(tmpdir(), "hoop-pr-bin-"));
  const crash = join(bin, "crash");
  writeFileSync(crash, "#!/bin/sh\ncat >/dev/null\necho boom >&2\nexit 1\n", { mode: 0o755 });
  const run = (hoopBin: string, input: object) =>
    spawnSync("sh", [wrapper], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, HOOP_HOME: home, HOOP_BIN: hoopBin } });
  const created = hookInput("gh pr create --fill", CREATE_OUT);
  for (const [name, r] of [
    ["missing hoop", run(join(bin, "nothing"), created)],
    ["crash", run(crash, created)],
    ["other command", run(crash, hookInput("ls", "x"))],
  ] as const) {
    assert.equal(r.status, 0, name);
    assert.equal(r.stdout + r.stderr, "", name);
  }
  assert.deepEqual(trackedPrs(home), []);
  const ok = run(`${process.execPath} ${tsx} ${cli}`, created);
  assert.equal(ok.status, 0);
  assert.equal(trackedPrs(home)[0]?.url, URL_A);
  const hooks = JSON.parse(readFileSync(new URL("../plugins/hoop-plan/hooks/hooks.json", import.meta.url), "utf8"));
  assert.equal(hooks.hooks.PostToolUse[0].matcher, "Bash");
  assert.match(hooks.hooks.PostToolUse[0].hooks[0].command, /track-pr\.sh/);
});

test("gh's pull request JSON maps to the states Home shows", () => {
  const s = (name: string) => prState(GH[name], "octocat");
  assert.deepEqual(
    { ...s("running"), body: undefined },
    { state: "open", title: "Add CSV export to orders", body: undefined, checks: "running", conflicts: false, review_requested: false, ready: false },
  );
  assert.equal(s("failing").checks, "failing");
  assert.equal(s("pending_status").checks, "running");
  assert.equal(s("ready").checks, "green");
  assert.equal(s("ready").ready, true);
  assert.equal(s("conflicts").conflicts, true);
  assert.equal(s("conflicts").ready, false);
  assert.equal(s("review_requested").review_requested, true, "logins match without case");
  assert.equal(s("review_requested").ready, false, "a required review isn't ready");
  assert.equal(s("review_requested").checks, "none");
  assert.equal(prState(GH.review_requested, "someone-else").review_requested, false);
  assert.equal(prState(GH.review_requested).review_requested, false, "unknown login");
  assert.deepEqual(Object.keys(s("merged")).sort(), ["body", "state", "title"]);
  assert.equal(s("merged").state, "merged");
  assert.equal(s("closed").state, "closed");
  assert.equal(prSummary(GH.ready.body), "Adds CSV export to the orders page, so finance can reconcile in a spreadsheet.");
  assert.equal(prSummary("<!-- template -->\n# Title\n\n---\n\n- First point\n- Second\n"), "First point Second");
  assert.equal(prSummary(""), "");
});

test("gh is asked at most once a minute per pull request, never again once merged, and its failure reads as unknown", async () => {
  const { gh, calls } = fakeGh({ [URL_A]: GH.ready, "https://github.com/acme/shop/pull/7": GH.merged });
  const states = new PrStates(gh);
  const views = () => calls.filter((c) => c[0] === "pr");
  const [a, b] = await Promise.all([states.get(URL_A), states.get(URL_A)]);
  assert.equal(a, b);
  assert.equal(views().length, 1, "one read for two requests at once");
  await states.get(URL_A);
  assert.equal(views().length, 1, "cached");
  assert.deepEqual(views()[0], ["pr", "view", URL_A, "--json", "title,body,state,mergeable,reviewDecision,reviewRequests,statusCheckRollup"]);
  await states.get("https://github.com/acme/shop/pull/7");
  (states as unknown as { cache: Map<string, { at: number }> }).cache.forEach((c) => (c.at -= 61_000));
  await states.get(URL_A);
  await states.get("https://github.com/acme/shop/pull/7");
  assert.equal(views().length, 3, "the open one is read again after a minute, the merged one isn't");
  const none = new PrStates(async () => {
    throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
  });
  assert.deepEqual(await none.get(URL_A), { state: "unknown" });
});

test("the pages list tracked pull requests with their state, summary and session, and read gh only when asked", async () => {
  const home = tempHome();
  const claude = process.env.HOOP_CLAUDE_DIR!;
  mkdirSync(join(claude, "projects", "-repo"), { recursive: true });
  writeFileSync(join(claude, "projects", "-repo", "sess-pages-12345.jsonl"), `${JSON.stringify({ type: "custom-title", customTitle: "Order export" })}\n`);
  const hoop = new Hoop(new Store(home), "sess-pages-12345");
  const { gh, calls } = fakeGh({ [URL_A]: GH.ready });
  const server = createWebServer(hoop, [], { gh });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    track.run(hoop, { url: URL_A }, { actor: "claude" });
    track.run(hoop, { url: "https://github.com/acme/shop/pull/9" }, { actor: "claude" });
    assert.equal(calls.length, 0, "no gh until Home asks");
    const list = await (await fetch(`${base}/api/prs`)).json();
    assert.deepEqual(
      list.map((p: { number: number; state: string }) => [p.number, p.state]),
      [
        [9, "unknown"],
        [42, "open"],
      ],
    );
    const pr = list[1];
    assert.equal(pr.repo, "acme/shop");
    assert.equal(pr.title, "Add CSV export to orders");
    assert.equal(pr.summary, "Adds CSV export to the orders page, so finance can reconcile in a spreadsheet.");
    assert.equal(pr.owner, "Order export (sess-pag)");
    assert.equal(pr.ready, true);
    assert.equal(pr.body, undefined, "the pages get the summary, not the whole description");
  } finally {
    server.close();
  }
});

test("Home shows open pull requests under Pending and merged ones under Completed", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home), "sess-home-1");
  hoop.submit(example());
  const urls = ["https://github.com/acme/shop/pull/1", "https://github.com/acme/shop/pull/2", "https://github.com/acme/shop/pull/3"];
  for (const url of urls) track.run(hoop, { url }, { actor: "claude" });
  const { gh } = fakeGh({ [urls[0]!]: GH.merged, [urls[1]!]: { ...GH.failing, mergeable: "CONFLICTING" } });
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(base);
      const pending = page.locator("section.group", { has: page.locator("h2", { hasText: "Pending" }) });
      const completed = page.locator("section.group", { has: page.locator("h2", { hasText: "Completed" }) });
      const failing = pending.locator(`a.pr[href="${urls[1]}"]`);
      await failing.waitFor();
      assert.equal(await failing.locator(".t").innerText(), "Add CSV export to orders");
      assert.match(await failing.locator(".s").innerText(), /^Adds CSV export to the orders page/);
      assert.deepEqual(await failing.locator(".badge").allInnerTexts(), ["Checks failing", "Conflicts with base"]);
      assert.match(await failing.locator(".m").innerText(), /opened by session sess-hom/);
      assert.deepEqual(await pending.locator(`a.pr[href="${urls[2]}"] .badge`).allInnerTexts(), ["State unknown"]);
      assert.equal(await pending.locator(`a.pr[href="${urls[2]}"] .t`).innerText(), "acme/shop#3");
      assert.deepEqual(await completed.locator(`a.pr[href="${urls[0]}"] .badge`).allInnerTexts(), ["Merged"]);
      assert.equal(await pending.locator(".count").innerText(), "3", "the review and two pull requests");
    },
    hoop,
    { gh },
  );
});
