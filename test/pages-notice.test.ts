import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensurePages } from "../src/pages.js";
import { cli, mcpClient, tempHome, tsx } from "./helpers.js";

const run = promisify(execFile);
const DOC = "# Plan\n\nWe ship on Friday.\n";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** Every pages process a test saw, stopped when the file ends. */
const seen = new Set<number>();
after(() => { for (const pid of seen) try { process.kill(pid); } catch { /* gone */ } });
const info = (port: number) => fetch(`http://127.0.0.1:${port}/api/info`).then((r) => r.json() as Promise<Record<string, any>>)
  .then((i) => { if (Number.isInteger(i.pid)) seen.add(i.pid); return i; }).catch(() => undefined);

const env = (port: number, home = tempHome()) =>
  ({ HOOP_PORT: String(port), HOOP_HOME: home, HOOP_PAGES: "on", HOOP_REPO_DIR: mkdtempSync(join(tmpdir(), "hoop-repo-")) });

/** A server on a free port that answers every request with `body`. */
async function holder(body: string): Promise<{ server: Server; port: number }> {
  const server = createHttpServer((_q, res) => res.end(body));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

test("FR-56: a result whose pages are served carries no notice, and its link opens at once", async () => {
  const port = await freePort();
  const mcp = await mcpClient(env(port));
  try {
    const { value } = await mcp.call("hoop_submit_markdown", { markdown: DOC });
    assert.equal("pages" in value, false);
    assert.equal((await fetch(value.url.replace("//localhost:", "//127.0.0.1:"))).status, 200);
  } finally {
    await mcp.close();
    await info(port);
  }
});

test("FR-49: a session starts the pages once, though its start and its first link both find nothing yet", async () => {
  const port = await freePort(), home = tempHome();
  const mcp = await mcpClient(env(port, home));
  try {
    await mcp.call("hoop_submit_markdown", { markdown: DOC });
  } finally {
    await mcp.close();
  }
  await info(port);
  const starts = readFileSync(join(home, "audit.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l).event).filter((e: string) => e === "pages_start" || e === "pages_not_started");
  // A second process would retry the address for five seconds, then record that it never started.
  await new Promise((r) => setTimeout(r, 5500));
  const later = readFileSync(join(home, "audit.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l).event).filter((e: string) => e === "pages_start" || e === "pages_not_started");
  assert.deepEqual(starts, ["pages_start"]);
  assert.deepEqual(later, ["pages_start"], "no second pages process was started");
});

test("FR-56: another program, an older hoop or another store on the port gives the reason, and nothing starts", async () => {
  const otherStore = await freePort();
  const first = await mcpClient(env(otherStore));
  await first.call("hoop_submit_markdown", { markdown: DOC });
  const ownerPid = (await info(otherStore))?.pid;
  const cases = [
    { name: "another program", ...(await holder("hello")), status: "unavailable", says: /another program is using port \d+\. Set HOOP_PORT/ },
    { name: "an older hoop", ...(await holder("{}")), status: "old", says: /older hoop that can't restart itself.*Restart the session/ },
    { name: "another store", server: undefined, port: otherStore, status: "unavailable", says: /another hoop store is using port \d+\. Set HOOP_PORT/ },
  ];
  try {
    for (const c of cases) {
      const mcp = await mcpClient(env(c.port));
      try {
        const { isError, value } = await mcp.call("hoop_submit_markdown", { markdown: DOC });
        assert.equal(isError, false, `${c.name}: the review is still stored`);
        assert.match(value.review_id, /^rv_/);
        assert.equal(value.pages?.status, c.status, c.name);
        assert.match(value.pages?.message, c.says, c.name);
      } finally {
        await mcp.close();
      }
    }
    assert.equal((await fetch(`http://127.0.0.1:${cases[0]!.port}/`)).status, 200, "the other program still holds its port");
    assert.equal((await info(otherStore))?.pid, ownerPid, "the other store's pages were left alone");
  } finally {
    for (const c of cases) c.server?.close();
    await first.close();
  }
});

test("FR-56: a command prints the reason to stderr, and still gives its result", async () => {
  const { server, port } = await holder("hello");
  const file = join(mkdtempSync(join(tmpdir(), "hoop-doc-")), "plan.md");
  writeFileSync(file, DOC);
  try {
    const { stdout, stderr } = await run(process.execPath, [tsx, cli, "submit", file], { env: { ...process.env, ...env(port) } });
    assert.match(stdout, /review_id: rv_/);
    assert.match(stderr, /hoop: The review pages aren't served for this session: another program is using port/);
  } finally {
    server.close();
  }
});

test("FR-56: a pages process that never answers is reported as a failed start, and recorded", async () => {
  const home = tempHome(), saved = process.env.HOOP_HOME, port = await freePort();
  process.env.HOOP_HOME = home;
  try {
    const saw = { pages: process.env.HOOP_PAGES };
    process.env.HOOP_PAGES = "on";
    const r = await ensurePages(home, port, { wait: true, start: () => { /* starts nothing */ }, waitMs: 600 });
    process.env.HOOP_PAGES = saw.pages;
    assert.equal(r.status, "failed");
    assert.match(r.notice!.message, /couldn't start on port \d+\. Run hoop serve to see the error\./);
    const events = readFileSync(join(home, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).event);
    assert.deepEqual(events, ["pages_start_failed"]);
  } finally {
    if (saved === undefined) delete process.env.HOOP_HOME; else process.env.HOOP_HOME = saved;
  }
});
