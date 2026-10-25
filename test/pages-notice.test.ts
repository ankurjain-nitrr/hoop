import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hoop } from "../src/hoop.js";
import { parseMarkdown } from "../src/markdown.js";
import { ensurePages } from "../src/pages.js";
import { Store } from "../src/store.js";
import { mcpClient, tempHome, hoopArgs } from "./helpers.js";

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
after(() => {
  for (const pid of seen)
    try {
      process.kill(pid);
    } catch {
      /* gone */
    }
});
const info = (port: number) =>
  fetch(`http://127.0.0.1:${port}/api/info`)
    .then((r) => r.json() as Promise<Record<string, any>>)
    .then((i) => {
      if (Number.isInteger(i.pid)) seen.add(i.pid);
      return i;
    })
    .catch(() => undefined);

const env = (port: number, home = tempHome()) => ({
  HOOP_PORT: String(port),
  HOOP_HOME: home,
  HOOP_PAGES: "on",
  HOOP_REPO_DIR: mkdtempSync(join(tmpdir(), "hoop-repo-")),
});

/** A server on a free port that answers every request with `body`. */
async function holder(body: string): Promise<{ server: Server; port: number }> {
  const server = createHttpServer((_q, res) => res.end(body));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

test("a result whose pages are served carries no notice, and its link opens at once", async () => {
  const port = await freePort();
  const mcp = await mcpClient(env(port));
  try {
    const { value } = await mcp.call("hoop_submit", { markdown: DOC });
    assert.equal("pages" in value, false);
    assert.equal((await fetch(value.url.replace("//localhost:", "//127.0.0.1:"))).status, 200);
  } finally {
    await mcp.close();
    await info(port);
  }
});

test("a session starts the pages once, though its start and its first link both find nothing yet", async () => {
  const port = await freePort(),
    home = tempHome();
  // A pages process tries the address four times, a quarter second apart, instead of twenty.
  const mcp = await mcpClient({ ...env(port, home), HOOP_PAGES_BIND_TRIES: "4" });
  try {
    await mcp.call("hoop_submit", { markdown: DOC });
  } finally {
    await mcp.close();
  }
  await info(port);
  const starts = readFileSync(join(home, "pages.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).event)
    .filter((e: string) => e === "pages_start" || e === "pages_not_started");
  // A second process would retry the address for a second, then record that it never started.
  await new Promise((r) => setTimeout(r, 2500));
  const later = readFileSync(join(home, "pages.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).event)
    .filter((e: string) => e === "pages_start" || e === "pages_not_started");
  assert.deepEqual(starts, ["pages_start"]);
  assert.deepEqual(later, ["pages_start"], "no second pages process was started");
});

test("another program, an older hoop or another store on the port refuses the write with the reason, and nothing starts", async () => {
  const otherStore = await freePort();
  const first = await mcpClient(env(otherStore));
  await first.call("hoop_submit", { markdown: DOC });
  const ownerPid = (await info(otherStore))?.pid;
  const cases = [
    { name: "another program", ...(await holder("hello")), status: "unavailable", says: /another program is using port \d+\. Set HOOP_PORT/ },
    { name: "an older hoop", ...(await holder("{}")), status: "old", says: /older hoop that can't restart itself.*Restart the session/ },
    { name: "another store", server: undefined, port: otherStore, status: "unavailable", says: /another hoop store is using port \d+\. Set HOOP_PORT/ },
  ];
  try {
    for (const c of cases) {
      const home = tempHome();
      const mcp = await mcpClient(env(c.port, home));
      try {
        // Only the pages process writes, so pages that can't be served for this store can't take the review.
        const { isError, value } = await mcp.call("hoop_submit", { markdown: DOC });
        assert.equal(isError, true, `${c.name}: the review can't be stored`);
        assert.match(value.error, /^hoop couldn't save this: /, c.name);
        assert.match(value.error, c.says, c.name);
        assert.equal(existsSync(join(home, "reviews")), false, `${c.name}: nothing was written`);
      } finally {
        await mcp.close();
      }
      const log = (() => {
        try {
          return readFileSync(join(home, "pages.jsonl"), "utf8");
        } catch {
          return "";
        }
      })();
      assert.doesNotMatch(log, /pages_start"|pages_not_started/, `${c.name}: no pages process was started`);
    }
    assert.equal((await fetch(`http://127.0.0.1:${cases[0]!.port}/`)).status, 200, "the other program still holds its port");
    assert.equal((await info(otherStore))?.pid, ownerPid, "the other store's pages were left alone");
  } finally {
    for (const c of cases) c.server?.close();
    await first.close();
  }
});

test("a command that writes prints the reason to stderr and exits 1; one that reads still gives its result", async () => {
  const { server, port } = await holder("hello");
  const file = join(mkdtempSync(join(tmpdir(), "hoop-doc-")), "plan.md");
  writeFileSync(file, DOC);
  try {
    const failed = await run(process.execPath, [...hoopArgs, "submit", file], { env: { ...process.env, ...env(port) } }).then(
      () => undefined,
      (err: { code: number; stdout: string; stderr: string }) => err,
    );
    assert.equal(failed?.code, 1);
    assert.equal(failed?.stdout, "");
    assert.match(failed!.stderr, /hoop: hoop couldn't save this: The review pages aren't served for this session: another program is using port/);
    // A command that only reads still answers.
    const home = tempHome();
    const { review_id } = new Hoop(new Store(home), "notice-session").submit(parseMarkdown(DOC));
    const json = await run(process.execPath, [...hoopArgs, "export", review_id, "--json"], { env: { ...process.env, ...env(port, home) } });
    assert.equal(JSON.parse(json.stdout).review_id, review_id);
  } finally {
    server.close();
  }
});

/** Runs `fn` with HOOP_HOME set to a new home and the starter on, then restores both. */
async function inHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = tempHome(),
    saved = { home: process.env.HOOP_HOME, pages: process.env.HOOP_PAGES };
  process.env.HOOP_HOME = home;
  process.env.HOOP_PAGES = "on";
  try {
    return await fn(home);
  } finally {
    for (const [k, v] of [
      ["HOOP_HOME", saved.home],
      ["HOOP_PAGES", saved.pages],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}
const events = (home: string) =>
  readFileSync(join(home, "pages.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).event);

test("a pages process that is slow to answer is reported as not answering yet, and recorded", () =>
  inHome(async (home) => {
    const r = await ensurePages(home, await freePort(), { wait: true, start: () => undefined, waitMs: 600 });
    assert.equal(r.status, "failed");
    assert.match(r.notice!.message, /didn't answer on port \d+ within 0\.6 seconds\. If they don't open soon, run hoop serve to see the error\./);
    assert.deepEqual(events(home), ["pages_start_failed"]);
  }));

test("a pages process that exits, or can't be run, is reported at once with its error", () =>
  inHome(async (home) => {
    for (const [start, says] of [
      [() => spawn(process.execPath, ["-e", "process.exit(3)"]), /exited with code 3/],
      [() => spawn("/nonexistent/hoop-node"), /ENOENT/],
    ] as const) {
      const t = Date.now();
      const r = await ensurePages(home, await freePort(), { wait: true, start, waitMs: 6000 });
      assert.equal(r.status, "failed");
      assert.match(r.notice!.message, says);
      assert.ok(Date.now() - t < 3000, `reported after ${Date.now() - t} ms`);
    }
  }));

test("a program on the IPv6 loopback address counts as holding the port", async (t) => {
  const v6 = createServer(() => {
    /* holds the port */
  });
  const listening = await new Promise<boolean>((r) => {
    v6.once("error", () => r(false));
    v6.listen(0, "::1", () => r(true));
  });
  if (!listening) return t.skip("no IPv6 loopback here");
  const port = (v6.address() as AddressInfo).port,
    home = tempHome();
  const mcp = await mcpClient(env(port, home));
  try {
    const { isError, value } = await mcp.call("hoop_submit", { markdown: DOC });
    assert.equal(isError, true);
    assert.match(value.error, /another program is using port/);
  } finally {
    await mcp.close();
    v6.close();
  }
  const log = (() => {
    try {
      return readFileSync(join(home, "pages.jsonl"), "utf8");
    } catch {
      return "";
    }
  })();
  assert.doesNotMatch(log, /pages_start"/, "no pages process was started");
});

test("a start made without waiting that then crashes is reported with its error by the next link", () =>
  inHome(async (home) => {
    const port = await freePort();
    await ensurePages(home, port, { start: () => spawn(process.execPath, ["-e", "setTimeout(() => process.exit(3), 300)"]) });
    const t = Date.now();
    const r = await ensurePages(home, port, { wait: true, waitMs: 6000 });
    assert.equal(r.status, "failed");
    assert.match(r.notice!.message, /exited with code 3/);
    assert.ok(Date.now() - t < 3000, `reported after ${Date.now() - t} ms`);
    assert.equal(events(home).filter((e) => e === "pages_start_failed").length, 1, "recorded once");
  }));

test("a foreground hoop serve doesn't start when a program holds the port on IPv6", async (t) => {
  const v6 = createServer(() => {
    /* holds the port */
  });
  const listening = await new Promise<boolean>((r) => {
    v6.once("error", () => r(false));
    v6.listen(0, "::1", () => r(true));
  });
  if (!listening) return t.skip("no IPv6 loopback here");
  const port = (v6.address() as AddressInfo).port;
  try {
    const { stdout } = await run(process.execPath, [...hoopArgs, "serve"], { env: { ...process.env, ...env(port), HOOP_PAGES: "off" }, timeout: 15_000 });
    assert.match(stdout, /another program holds port/);
  } finally {
    v6.close();
  }
});
