import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restartTarget } from "../src/pages.js";
import type { Session } from "../src/sessions.js";
import { codeId } from "../src/version.js";
import { tempHome, tsx } from "./helpers.js";

const root = new URL("..", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** Every folder a test copied hoop into; any process still running from one is stopped at the end. */
const copies: string[] = [];
/** Processes running hoop from `dir`; `own` leaves out the tsx wrapper a test starts each one through. */
const running = (dir: string, own = false) => execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
  .split("\n").filter((l) => l.includes(`${dir}/src/cli.ts`) && !(own && l.includes("tsx/dist/cli.mjs")))
  .map((l) => Number(l.trim().split(/\s+/)[0]));
after(() => { for (const dir of copies) for (const pid of running(dir)) try { process.kill(pid); } catch { /* gone */ } });

/** A temporary copy of hoop's install, sharing its `node_modules`, that a test can change. */
function copyHoop(version?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hoop-install-"));
  for (const part of ["src", "web", "package.json", "tsconfig.json"]) cpSync(join(root, part), join(dir, part), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  if (version) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, version }));
  }
  copies.push(dir);
  return dir;
}

type Info = { hoop: string; release: string; code: string; stale: boolean; pid: number };
const info = (port: number) => fetch(`http://127.0.0.1:${port}/api/info`)
  .then((r) => r.json() as Promise<Info>).catch(() => undefined);

async function until<T>(check: () => Promise<T | undefined>, ms = 10_000): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    const v = await check();
    if (v) return v;
  }
  return undefined;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const events = (home: string) => {
  try { return readFileSync(join(home, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

/** Starts the pages process from an install folder, as the starter would, and waits for it to answer. */
async function startPages(install: string, port: number, home: string): Promise<Info> {
  const env = { ...process.env, HOOP_PAGES: "background", HOOP_PORT: String(port), HOOP_HOME: home, HOOP_REPO_DIR: mkdtempSync(join(tmpdir(), "hoop-repo-")) };
  spawn(process.execPath, [tsx, join(install, "src/cli.ts"), "serve"], { env, stdio: "ignore", detached: true }).unref();
  const up = await until(() => info(port), 15_000);
  assert.ok(up, "the pages process answers");
  return up;
}

test("FR-4: a changed install restarts the pages into the new code on the same address", async () => {
  const install = copyHoop(), port = await freePort(), home = tempHome();
  const first = await startPages(install, port, home);
  const changed = Date.now();
  appendFileSync(join(install, "web/app.js"), "\n// a newer build\n");
  const next = await until(async () => { const i = await info(port); return i && i.pid !== first.pid ? i : undefined; });
  assert.ok(next, "a new pages process answers on the same address");
  assert.ok(Date.now() - changed < 5000, `the new code served after ${Date.now() - changed} ms`);
  assert.notEqual(next.code, first.code);
  assert.equal(next.stale, false);
  // The old process exits on its next check after the successor answers.
  assert.equal(await until(async () => (alive(first.pid) ? undefined : true), 3000), true, "the old process exited");
  assert.ok(events(home).some((e) => e.event === "pages_restart" && e.code === next.code));
});

test("FR-4: when the new code never answers, the old process serves again once and stays out of date", async () => {
  const install = copyHoop(), port = await freePort(), home = tempHome();
  const first = await startPages(install, port, home);
  const cli = join(install, "src/cli.ts");
  writeFileSync(cli, "await new Promise(() => {});\n" + readFileSync(cli, "utf8"));
  const changed = Date.now();
  const back = await until(async () => (events(home).some((e) => e.event === "pages_fallback") ? info(port) : undefined), 15_000);
  assert.ok(back, "the old process answers again");
  assert.ok(Date.now() - changed < 10_000, `it answered again after ${Date.now() - changed} ms`);
  assert.equal(back.pid, first.pid);
  assert.equal(back.stale, true);
  assert.deepEqual(running(install, true), [first.pid], "the successor that never answered was stopped");
  // It tries once for each change, so the same code isn't tried again.
  await sleep(5000);
  assert.equal(events(home).filter((e) => e.event === "pages_restart").length, 1);
  assert.equal((await info(port))?.pid, first.pid);
});

test("FR-4: a session on a newer release moves the pages to that release's install", async () => {
  const older = copyHoop(), newer = copyHoop("99.0.0"), port = await freePort(), home = tempHome();
  const first = await startPages(older, port, home);
  // A session from the newer install records itself in the same store, and leaves the pages to the process.
  const session = spawn(process.execPath, [tsx, join(newer, "src/cli.ts"), "mcp"], {
    env: { ...process.env, HOOP_HOME: home, HOOP_PORT: String(port), HOOP_PAGES: "off" }, stdio: ["pipe", "ignore", "ignore"],
  });
  try {
    const moved = await until(async () => { const i = await info(port); return i?.release === "99.0.0" ? i : undefined; }, 15_000);
    assert.ok(moved, "the pages run the newer release");
    assert.notEqual(moved.pid, first.pid);
  } finally {
    session.kill();
  }
});

test("FR-4: the pages process exits when its install is gone and no session is live", async () => {
  const install = copyHoop(), port = await freePort(), home = tempHome();
  const first = await startPages(install, port, home);
  rmSync(install, { recursive: true, force: true });
  const gone = await until(async () => (alive(first.pid) ? undefined : true));
  assert.equal(gone, true);
});

test("NFR-3: page loads with the restart timer on take no more than 50 ms longer than without it", async () => {
  const time = async (port: number) => {
    const runs: number[] = [];
    for (let i = 0; i < 25; i++) {
      const t = performance.now();
      await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
      runs.push(performance.now() - t);
      await sleep(40);
    }
    return runs.sort((a, b) => a - b)[Math.floor(runs.length / 2)]!;
  };
  const foreground = await freePort(), background = await freePort();
  const env = (port: number, pages: string) => ({ ...process.env, HOOP_PAGES: pages, HOOP_PORT: String(port), HOOP_HOME: tempHome() });
  const plain = spawn(process.execPath, [tsx, join(root, "src/cli.ts"), "serve"], { env: env(foreground, "off"), stdio: "ignore" });
  const install = copyHoop();
  try {
    await until(() => info(foreground), 15_000);
    await startPages(install, background, tempHome());
    const without = await time(foreground), withTimer = await time(background);
    assert.ok(withTimer - without <= 50, `median ${withTimer.toFixed(1)} ms with the timer, ${without.toFixed(1)} ms without`);
  } finally {
    plain.kill();
  }
});

test("FR-4: the target is the newest live release, a rollback included, and one release never restarts another install", () => {
  const a = copyHoop("0.2.0"), b = copyHoop("0.1.0"), c = copyHoop("0.2.0");
  const own = { install: a, release: "0.2.0", code: codeId(a) };
  const session = (install: string, release: string): Session =>
    ({ format: 1, pid: 1, started: 0, boot: 0, repo: "/r", install, release, start: ["node", join(install, "src/cli.ts")] });
  assert.equal(restartTarget(own, []), undefined, "current code with no session");
  const back = restartTarget(own, [session(b, "0.1.0")]);
  assert.ok(back && back !== "gone");
  assert.equal(back.release, "0.1.0", "a rollback leaves an older release as the newest one in use");
  assert.equal(restartTarget(own, [session(c, "0.2.0"), session(b, "0.1.0")]), undefined, "another install of the same release");
  rmSync(b, { recursive: true, force: true });
  assert.equal(restartTarget(own, [session(b, "0.1.0")]), undefined, "a session whose install is gone");
  rmSync(a, { recursive: true, force: true });
  assert.equal(restartTarget(own, []), "gone");
  assert.equal(restartTarget(own, [session(c, "0.2.0")]), undefined, "a live session keeps it while its own install is gone");
});
