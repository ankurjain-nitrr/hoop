import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { GitHub } from "../src/github.js";
import { OPS } from "../src/ops.js";
import { createWebServer } from "../src/web.js";
import { readAudit, summarize } from "../src/audit.js";
import { cli, example, mcpClient, tempHome, tsx } from "./helpers.js";
import { execFileSync } from "node:child_process";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function fakeGh(responses: Record<string, () => unknown>) {
  const run = async (args: string[]) => {
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "acme/orders", defaultBranchRef: { name: "main" } });
    const at = args.indexOf("--method"),
      key = `${args[at + 1]} ${args[at + 2]}`;
    const handler = responses[key];
    if (!handler) throw new Error(`gh api: unexpected ${key}`);
    return JSON.stringify(handler() ?? {});
  };
  return { run };
}
const op = OPS.find((o) => o.name === "submit")!;
const submitMarkdown = { run: (hoop: Hoop, input: Record<string, unknown>) => op.run(hoop, input, { actor: "claude" }) };

// Reports every line that holds "TODO", as `path:line: message`, and exits 1 when it finds one.
const TODO_CHECKER = `import { readFileSync } from "node:fs";
const f = process.argv[2], lines = readFileSync(f, "utf8").split("\\n");
const hits = lines.flatMap((l, i) => (l.includes("TODO") ? [f + ":" + (i + 1) + ": says TODO"] : []));
hits.forEach((h) => console.log(h));
if (process.env.CHECK_SLEEP) await new Promise((r) => setTimeout(r, Number(process.env.CHECK_SLEEP)));
process.exit(hits.length ? 1 : 0);
`;

/** A repository with the TODO checker, a hoop folder that allows it (or not), and a hoop on them. */
function setup(allow = true) {
  const repo = tmp("hoop-cs-repo-"),
    home = tempHome();
  writeFileSync(join(repo, "check.mjs"), TODO_CHECKER);
  const command = [process.execPath, "check.mjs"];
  writeFileSync(join(repo, "hoop.config.json"), JSON.stringify({ check: command }));
  if (allow) writeFileSync(join(home, "config.json"), JSON.stringify({ checks: [{ repo, command }] }));
  process.env.HOOP_REPO_DIR = repo;
  return { repo, home, command, hoop: new Hoop(new Store(home)) };
}

const DOC = "# Plan\n\nIntro.\n\n## Goals\n\n- Ship it.\n- TODO decide the date\n\n## Risks\n\nNone yet.\n";

test("FR-3: the submit result and the stored outcome hold the findings, their places and the command", async () => {
  const { hoop, home, command } = setup();
  const res = (await submitMarkdown.run(hoop, { markdown: DOC })) as { review_id: string; checks?: any };
  assert.equal(res.checks?.ran, true);
  assert.deepEqual(res.checks.command, command);
  assert.deepEqual(
    res.checks.findings.map((f: any) => [f.line, f.message, f.place]),
    [[8, "says TODO", { item: "S-1", line: 1 }]],
  );
  const stored = JSON.parse(readFileSync(join(home, "reviews", res.review_id, "checks-1.json"), "utf8"));
  assert.deepEqual(stored.findings, res.checks.findings);
  // The checks metric: hoop audit counts the check.
  assert.equal(summarize(readAudit()).checks.run >= 1, true);
});

test("FR-3: places stay right on a second revision, after keepIds keeps the section IDs", async () => {
  const { hoop } = setup();
  const first = (await submitMarkdown.run(hoop, { markdown: DOC })) as { review_id: string };
  const next = "# Plan\n\nIntro.\n\n## New first\n\nAdded.\n\n## Goals\n\n- Ship it.\n- TODO decide the date\n\n## Risks\n\nNone yet.\n";
  const res = (await submitMarkdown.run(hoop, { markdown: next, review_id: first.review_id })) as { checks?: any };
  const rev2 = hoop.store.revision(first.review_id, 2);
  const goals = rev2.items.find((i) => i.title === "Goals")!;
  assert.deepEqual(res.checks.findings[0].place, { item: goals.id, line: 1 }, "the finding sits on the Goals section's stored ID");
});

test("FR-3: a GitHub submission is checked too, and its result holds the findings", async () => {
  const { home } = setup();
  // A minimal fake gh for the calls a new decision PR makes; test/github.test.ts covers the channel itself.
  const gh = fakeGh({
    "GET repos/acme/orders/git/ref/heads/main": () => ({ object: { sha: "base1" } }),
    "GET repos/acme/orders/git/commits/base1": () => ({ tree: { sha: "tree0" } }),
    "POST repos/acme/orders/git/trees": () => ({ sha: "tree1" }),
    "POST repos/acme/orders/git/commits": () => ({ sha: "c1" }),
    "POST repos/acme/orders/git/refs": () => ({}),
    "POST repos/acme/orders/pulls": () => ({ number: 42, html_url: "https://github.com/acme/orders/pull/42" }),
  });
  const hoop = new Hoop(new Store(home), new GitHub(gh.run));
  const res = (await submitMarkdown.run(hoop, { markdown: DOC, channel: "github" })) as { url: string; checks?: any };
  assert.equal(res.url, "https://github.com/acme/orders/pull/42");
  assert.equal(res.checks?.findings.length, 1);
});

test("FR-2, FR-7: a command that isn't allowed doesn't run, and JSON reviews or repositories without a config check nothing", async () => {
  const { hoop } = setup(false);
  const res = (await submitMarkdown.run(hoop, { markdown: DOC })) as { review_id: string; checks?: any };
  assert.deepEqual([res.checks.ran, res.checks.reason], [false, "not_allowed"]);
  assert.ok(res.checks.allow?.repo, "the agent gets the entry to ask the user for");
  // FR-68: a check that didn't run leads the result with a warning that names the command to run.
  assert.equal(Object.keys(res)[0], "warnings");
  assert.match((res as unknown as { warnings: string[] }).warnings[0]!, /didn't run.*hoop allow-check/);

  const json = (await hoop.submitAny(example())) as { checks?: unknown };
  assert.equal("checks" in json, false, "a JSON review runs nothing");

  process.env.HOOP_REPO_DIR = tmp("hoop-cs-none-");
  const plain = (await submitMarkdown.run(new Hoop(new Store(tempHome())), { markdown: DOC })) as { checks?: unknown };
  assert.equal("checks" in plain, false, "a repository without a config runs nothing");
});

async function withServer(hoop: Hoop, fn: (base: string) => Promise<void>) {
  const server = createWebServer(hoop);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("FR-6, NFR-2: the view holds the latest outcome without folder paths, and the page answers while a check runs", async () => {
  const { hoop, repo } = setup();
  process.env.CHECK_SLEEP = "3000";
  try {
    await withServer(hoop, async (base) => {
      const pending = submitMarkdown.run(hoop, { markdown: DOC }) as Promise<{ review_id: string }>;
      // Wait until the revision exists, then ask the page for it while the check still runs.
      let id: string | undefined;
      for (let i = 0; i < 50 && !id; i++) {
        await new Promise((r) => setTimeout(r, 50));
        id = hoop.store.list()[0]?.id;
      }
      assert.ok(id);
      const t0 = Date.now();
      const view = await (await fetch(`${base}/api/reviews/${id}`)).json();
      assert.ok(Date.now() - t0 < 1000, "the page answers at once");
      assert.equal(view.checks?.reason, "running");
      await pending;
      const done = await (await fetch(`${base}/api/reviews/${id}`)).json();
      assert.deepEqual([done.checks.ran, done.checks.revision, done.checks.findings.length], [true, 1, 1]);
      const text = JSON.stringify(done.checks);
      assert.equal(text.includes(repo), false, "no folder path reaches the page");
    });
  } finally {
    delete process.env.CHECK_SLEEP;
  }
});

test("FR-6: a running outcome older than the timeout reads as stopped, and a not-allowed one loses its entry", async () => {
  const { hoop, repo, home } = setup(false);
  const res = (await submitMarkdown.run(hoop, { markdown: DOC })) as { review_id: string };
  await withServer(hoop, async (base) => {
    const view = await (await fetch(`${base}/api/reviews/${res.review_id}`)).json();
    assert.equal(view.checks.reason, "not_allowed");
    assert.equal("allow" in view.checks, false, "the allow entry stays with the agent");
    // Regression: the not-allowed message named the repository and the hoop folder.
    const text = JSON.stringify(view.checks);
    assert.equal(text.includes(repo) || text.includes(home), false, `no folder path reaches the page: ${text}`);
    // FR-69: the page names the command that allows the check.
    assert.match(view.checks.message, /run hoop allow-check in the repository/);
    hoop.store.saveCheck(res.review_id, 1, { ran: false, reason: "running", findings: [], started: new Date(Date.now() - 3600_000).toISOString() });
    const stale = await (await fetch(`${base}/api/reviews/${res.review_id}`)).json();
    assert.equal(stale.checks.reason, "stopped");
    hoop.store.saveCheck(res.review_id, 1, { ran: false, reason: "running", findings: [] });
    assert.equal((await (await fetch(`${base}/api/reviews/${res.review_id}`)).json()).checks.reason, "stopped", "no start time reads as stopped");
    // Regression: a failed check's message quoted stderr, which can name a folder.
    hoop.store.saveCheck(res.review_id, 1, { ran: false, reason: "failed", message: `python: can't open file '${repo}/x.py'`, findings: [] });
    const failed = JSON.stringify((await (await fetch(`${base}/api/reviews/${res.review_id}`)).json()).checks);
    assert.equal(failed.includes(repo), false, `no folder path reaches the page: ${failed}`);
  });
});

test("FR-3: the agent tool over MCP returns checks", async () => {
  const { repo, home } = setup();
  const mcp = await mcpClient({ HOOP_HOME: home, HOOP_REPO_DIR: repo });
  try {
    const { value } = await mcp.call("hoop_submit_markdown", { markdown: DOC });
    assert.equal(value.checks.findings[0].message, "says TODO");
  } finally {
    await mcp.close();
  }
});

test("Metrics: hoop audit prints checks run, findings and checks that didn't run", () => {
  // Regression: only the JSON summary held the counts.
  const home = tempHome();
  const at = new Date().toISOString();
  writeFileSync(
    join(home, "audit.jsonl"),
    [
      { at, event: "check", ok: true, ran: true, findings: 2 },
      { at, event: "check", ok: true, ran: false, reason: "timeout", findings: 0 },
      { at, event: "check", ok: true, ran: false, reason: "not_allowed", findings: 0 },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  const out = execFileSync(process.execPath, [tsx, cli, "audit"], { env: { ...process.env, HOOP_HOME: home }, encoding: "utf8" });
  assert.match(out, /checks run 1 · findings 2 · checks that didn't run 1/);
});
