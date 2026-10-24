import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { createServer as createHttpServer, Server as HttpServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startPages } from "../src/pages.js";
import { cli, mcpClient, tempHome, tsx } from "./helpers.js";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** Every pages process a test saw; all are stopped when the file ends, whether its tests pass or fail. */
const seen = new Set<number>();
after(() => {
  for (const pid of seen)
    try {
      process.kill(pid);
    } catch {
      /* gone */
    }
});

/** The pages listen on 127.0.0.1, and "localhost" can resolve to IPv6 first, so requests name the address. */
const info = (port: number) =>
  fetch(`http://127.0.0.1:${port}/api/info`)
    .then((r) => r.json() as Promise<Record<string, any>>)
    .then((i) => {
      if (Number.isInteger(i.pid)) seen.add(i.pid);
      return i;
    })
    .catch(() => undefined);

/** The status of a request with its own Host header, which fetch doesn't allow. */
const withHost = (port: number, host: string, headers: Record<string, string> = {}) =>
  new Promise<number>((resolve) => {
    request({ host: "127.0.0.1", port, path: "/api/info", headers: { host, ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on("error", () => resolve(0))
      .end();
  });

/** Waits up to `ms` for `check` to return a value; the deadline only stops a run that would otherwise hang. */
async function until<T>(check: () => Promise<T | undefined>, ms = 30_000): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    const v = await check();
    if (v !== undefined) return v;
  }
  return undefined;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits until no session entry is left in the store: a session has ended once its entry is gone. */
const sessionEnded = (home: string) =>
  until(async () => {
    const dir = join(home, "sessions");
    return existsSync(dir) && readdirSync(dir).some((n) => n.endsWith(".json")) ? undefined : true;
  });

/** Environment for a hoop child on its own port and store, with the starter on. */
function env(port: number, home = tempHome(), extra: Record<string, string> = {}) {
  return { HOOP_PORT: String(port), HOOP_HOME: home, HOOP_PAGES: "on", HOOP_REPO_DIR: mkdtempSync(join(tmpdir(), "hoop-repo-")), ...extra };
}

/** Stops every pages process a test learned about. */
function stopAll(pids: number[]) {
  for (const pid of pids)
    try {
      process.kill(pid);
    } catch {
      /* gone */
    }
}

const DOC = "# Plan\n\nWe ship on Friday.\n";

test("a session starts the pages process, its links use the usual address, and the pages outlive it", async () => {
  const port = await freePort(),
    home = tempHome(),
    pids: number[] = [];
  const mcp = await mcpClient(env(port, home));
  try {
    const first = await until(() => info(port));
    assert.equal(first?.hoop, "pages", "the session started the pages process");
    pids.push(first!.pid);
    const { value } = await mcp.call("hoop_submit", { markdown: DOC });
    assert.equal(new URL(value.url).port, String(port));
    assert.equal((await fetch(value.url.replace("//localhost:", "//127.0.0.1:"))).status, 200);
  } finally {
    await mcp.close();
  }
  assert.equal(await sessionEnded(home), true, "the session ended");
  const after = await info(port);
  assert.equal(after?.pid, pids[0], "the same pages process still answers after the session ends");
  stopAll(pids);
});

test("a second session for the same store reuses the pages process", async () => {
  const port = await freePort(),
    home = tempHome();
  const a = await mcpClient(env(port, home));
  const first = await until(() => info(port));
  assert.ok(first, "the pages process answers");
  const b = await mcpClient(env(port, home));
  await b.call("hoop_submit", { markdown: DOC });
  const second = await info(port);
  await a.close();
  await b.close();
  assert.equal(second?.pid, first?.pid);
  stopAll([first!.pid]);
});

test("a command that gives a link starts the pages process too", async () => {
  const port = await freePort(),
    e = env(port);
  const file = join(mkdtempSync(join(tmpdir(), "hoop-doc-")), "plan.md");
  writeFileSync(file, DOC);
  const { stdout } = await run(process.execPath, [tsx, cli, "submit", file], { env: { ...process.env, ...e }, timeout: 60_000 });
  assert.match(stdout, new RegExp(`url: http://localhost:${port}/r/rv_`));
  const up = await until(() => info(port));
  assert.equal(up?.hoop, "pages");
  stopAll([up!.pid]);
});

test("a holder that isn't hoop, never answers, answers slowly or is an old hoop leaves the tools working", async () => {
  for (const kind of ["text", "silent", "trickle", "old"] as const) {
    const holder =
      kind === "text"
        ? createHttpServer((_q, res) => res.end("hello"))
        : kind === "old"
          ? createHttpServer((_q, res) => res.end("{}"))
          : // Sends a byte every 300 ms, so the connection is never idle for a second.
            kind === "trickle"
            ? createHttpServer((_q, res) => {
                res.writeHead(200);
                const t = setInterval(() => res.write(" "), 300);
                res.on("close", () => clearInterval(t));
              })
            : createServer(() => {
                /* accepts and never answers */
              });
    await new Promise<void>((r) => holder.listen(0, "127.0.0.1", r));
    const port = (holder.address() as AddressInfo).port;
    const mcp = await mcpClient(env(port));
    try {
      const t = Date.now();
      const { isError, value } = await mcp.call("hoop_submit", { markdown: DOC });
      assert.equal(isError, false, kind);
      assert.match(value.review_id, /^rv_/);
      // The check waits at most a second; the rest is the submit itself.
      assert.ok(Date.now() - t < 2500, `${kind}: took ${Date.now() - t} ms`);
    } finally {
      await mcp.close();
      if (holder instanceof HttpServer) holder.closeAllConnections();
      holder.close();
    }
  }
});

test("a session with another store doesn't use or replace that store's pages", async () => {
  const port = await freePort();
  const a = await mcpClient(env(port));
  const first = await until(() => info(port));
  assert.ok(first, "the pages process answers");
  const b = await mcpClient(env(port, tempHome()));
  const { isError } = await b.call("hoop_submit", { markdown: DOC });
  assert.equal(isError, false);
  assert.equal((await info(port))?.pid, first?.pid);
  await a.close();
  await b.close();
  stopAll([first!.pid]);
});

test("the pages process stays while a page is open, and stops once nothing uses it", async () => {
  const port = await freePort(),
    home = tempHome();
  const mcp = await mcpClient(env(port, home, { HOOP_PAGES_IDLE_MS: "3000" }));
  const up = await until(() => info(port));
  assert.ok(up, "the pages process answers");
  await mcp.close();
  assert.equal(await sessionEnded(home), true, "the session ended");
  // An open page asks for the info every so often; here every half second for twice the idle time.
  for (let i = 0; i < 12; i++) {
    await info(port);
    await sleep(500);
  }
  assert.ok(alive(up!.pid), "an open page keeps the pages process running past the idle time");
  const gone = await until(async () => (alive(up!.pid) ? undefined : true));
  assert.equal(gone, true, "with no session and no page, the pages process stops");
});

test("requests from other sites, other host names and plain requests can't stop the pages process", async () => {
  const port = await freePort();
  const mcp = await mcpClient(env(port));
  const up = await until(() => info(port));
  assert.ok(up, "the pages process answers");
  await mcp.close();
  const base = `http://127.0.0.1:${port}`;
  const tries = [
    fetch(`${base}/api/stop`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }),
    fetch(`${base}/api/restart`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }),
    fetch(`${base}/api/shutdown`),
  ];
  const statuses = [
    ...(await Promise.all(
      tries.map((t) =>
        t.then(
          (r) => r.status,
          () => 0,
        ),
      ),
    )),
    await withHost(port, "evil.example"),
  ];
  assert.deepEqual(
    statuses.map((s) => s >= 400),
    [true, true, true, true],
  );
  assert.ok(alive(up!.pid));
  assert.equal((await info(port))?.pid, up!.pid);
  stopAll([up!.pid]);
});

test("a session ended by a signal removes its entry, so it no longer keeps the pages running", async () => {
  const home = tempHome(),
    dir = join(home, "sessions");
  // tsx runs the CLI in a child process, so the session's process ID comes from its entry.
  const child = spawn(process.execPath, [tsx, cli, "mcp"], {
    env: { ...process.env, HOOP_HOME: home, HOOP_PAGES: "off" },
    stdio: ["pipe", "ignore", "ignore"],
  });
  try {
    const name = await until(async () => (existsSync(dir) ? readdirSync(dir).find((n) => n.endsWith(".json")) : undefined));
    assert.ok(name, "the session recorded itself");
    const pid = Number(name.replace(".json", ""));
    process.kill(pid, "SIGTERM");
    assert.equal(await until(async () => (alive(pid) ? undefined : true)), true, "the signal still ends the session");
    assert.equal(existsSync(join(dir, name)), false);
  } finally {
    child.kill();
  }
});

test("requests from other sites don't keep the pages process running", async () => {
  const port = await freePort();
  const mcp = await mcpClient(env(port, tempHome(), { HOOP_PAGES_IDLE_MS: "1500" }));
  const up = await until(() => info(port));
  assert.ok(up, "the pages process answers");
  await mcp.close();
  // Another site in the browser can reach the address, but its requests carry its own Host.
  const stop = Date.now() + 5000;
  const visit = async () => {
    await withHost(port, "evil.example");
    // A browser names the address itself as Host, and marks the request as coming from another site.
    await withHost(port, `127.0.0.1:${port}`, { "sec-fetch-site": "cross-site" });
  };
  const gone = await until(async () => {
    if (Date.now() < stop) await visit();
    return alive(up!.pid) ? undefined : true;
  });
  assert.equal(gone, true, "only page traffic counts as use");
});

test("page requests don't each wait for the session list", async () => {
  // A slow ps stands in for a loaded machine; each run takes over a second.
  const bin = mkdtempSync(join(tmpdir(), "hoop-bin-"));
  writeFileSync(join(bin, "ps"), '#!/bin/sh\nsleep 1.2\nexec /bin/ps "$@"\n', { mode: 0o755 });
  const port = await freePort();
  const mcp = await mcpClient(env(port, tempHome(), { PATH: `${bin}:${process.env.PATH}` }));
  try {
    assert.ok(await until(() => info(port)), "the pages process answers");
    const t = Date.now();
    for (let i = 0; i < 4; i++) await info(port);
    assert.ok(Date.now() - t < 2500, `four info requests took ${Date.now() - t} ms`);
  } finally {
    await mcp.close();
  }
});

test("a pages process that finds the address taken records that it never started", async () => {
  const holder = createHttpServer((_q, res) => res.end("hello"));
  await new Promise<void>((r) => holder.listen(0, "127.0.0.1", r));
  const port = (holder.address() as AddressInfo).port,
    home = tempHome();
  try {
    await run(process.execPath, [tsx, cli, "serve"], { env: { ...process.env, ...env(port, home, { HOOP_PAGES: "background" }) }, timeout: 60_000 });
  } finally {
    holder.close();
  }
  const events = readFileSync(join(home, "pages.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).event);
  assert.deepEqual(
    events.filter((e) => e.startsWith("pages_")),
    ["pages_not_started"],
  );
});

test("a pages process that can't be started is recorded", async () => {
  const home = tempHome(),
    saved = process.env.HOOP_HOME;
  process.env.HOOP_HOME = home;
  try {
    startPages(["/nonexistent/node"]);
    const line = await until(async () => {
      try {
        return readFileSync(join(home, "pages.jsonl"), "utf8") || undefined;
      } catch {
        return undefined;
      }
    });
    assert.equal(JSON.parse(line!.trim()).event, "pages_start_failed");
  } finally {
    if (saved === undefined) delete process.env.HOOP_HOME;
    else process.env.HOOP_HOME = saved;
  }
});

test("hoop serve says when another store's pages hold the address", async () => {
  const port = await freePort();
  const mcp = await mcpClient(env(port));
  try {
    // A foreground server that found the address free would serve until stopped, so the pages answer first.
    assert.ok(await until(() => info(port)), "the pages process answers");
    const { stdout } = await run(process.execPath, [tsx, cli, "serve"], {
      env: { ...process.env, ...env(port, tempHome(), { HOOP_PAGES: "off" }) },
      timeout: 60_000,
    });
    assert.match(stdout, /another hoop store/);
  } finally {
    await mcp.close();
  }
});
