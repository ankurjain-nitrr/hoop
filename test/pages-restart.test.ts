import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restartTarget } from "../src/pages.js";
import { registerSession } from "../src/sessions.js";
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
const running = (dir: string, own = false) =>
  execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(`${dir}/src/cli.ts`) && !(own && l.includes("tsx/dist/cli.mjs")))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
after(() => {
  for (const dir of copies) {
    for (const pid of running(dir))
      try {
        process.kill(pid);
      } catch {
        /* gone */
      }
    rmSync(dir, { recursive: true, force: true });
  }
});

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

type Info = { hoop: string; release: string; code: string; stale: boolean; pid: number; checks?: number };
const info = (port: number) =>
  fetch(`http://127.0.0.1:${port}/api/info`)
    .then((r) => r.json() as Promise<Info>)
    .catch(() => undefined);

/** Waits for `check` to return a value; the deadline only stops a run that would otherwise hang. */
async function until<T>(check: () => Promise<T | undefined>, ms = 30_000): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    const v = await check();
    if (v) return v;
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
const events = (home: string) => {
  try {
    return readFileSync(join(home, "pages.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

/** A successor gets this long to answer, so a slow start on a busy machine still takes over. */
const SLOW_START = { HOOP_PAGES_HANDOVER_MS: "60000" };

/** The pages process checks its code every quarter second, not every two, so a test waits for checks briefly. */
const FAST_CHECKS = { HOOP_PAGES_CHECK_MS: "250" };

/** Starts the pages process from an install folder, as the starter would, and waits for it to answer. */
async function startPages(install: string, port: number, home: string, extra: Record<string, string> = {}): Promise<Info> {
  const env = {
    ...process.env,
    HOOP_PAGES: "background",
    HOOP_PORT: String(port),
    HOOP_HOME: home,
    HOOP_REPO_DIR: mkdtempSync(join(tmpdir(), "hoop-repo-")),
    ...FAST_CHECKS,
    ...extra,
  };
  spawn(process.execPath, [tsx, join(install, "src/cli.ts"), "serve"], { env, stdio: "ignore", detached: true }).unref();
  const up = await until(() => info(port));
  assert.ok(up, "the pages process answers");
  return up;
}

/** Waits until the pages process `pid` has checked its code `n` more times after `from` checks. */
async function checked(port: number, pid: number, n: number, from = 0): Promise<Info> {
  const i = await until(async () => {
    const now = await info(port);
    return now && (now.pid !== pid || (now.checks ?? 0) >= from + n) ? now : undefined;
  }, 60_000);
  assert.ok(i, `the pages process made ${n} more checks`);
  return i;
}

test("a changed install restarts the pages into the new code on the same address", async () => {
  const install = copyHoop(),
    port = await freePort(),
    home = tempHome();
  const first = await startPages(install, port, home, SLOW_START);
  appendFileSync(join(install, "web/app.js"), "\n// a newer build\n");
  const next = await until(async () => {
    const i = await info(port);
    return i && i.pid !== first.pid ? i : undefined;
  }, 90_000);
  assert.ok(next, "a new pages process answers on the same address");
  assert.notEqual(next.code, first.code);
  assert.equal(next.stale, false);
  // The old process exits on its next check after the successor answers.
  assert.equal(await until(async () => (alive(first.pid) ? undefined : true)), true, "the old process exited");
  assert.ok(events(home).some((e) => e.event === "pages_restart" && e.code === next.code));
});

test("when the new code never answers, the old process serves again once and stays out of date", async () => {
  const install = copyHoop(),
    port = await freePort(),
    home = tempHome();
  // The successor gets a second and a half, after which the old process binds again.
  const first = await startPages(install, port, home, { HOOP_PAGES_HANDOVER_MS: "1500" });
  const cli = join(install, "src/cli.ts");
  writeFileSync(cli, "await new Promise(() => {});\n" + readFileSync(cli, "utf8"));
  const back = await until(async () => (events(home).some((e) => e.event === "pages_fallback") ? info(port) : undefined), 60_000);
  assert.ok(back, "the old process answers again");
  assert.equal(back.pid, first.pid);
  assert.equal(back.stale, true);
  assert.deepEqual(running(install, true), [first.pid], "the successor that never answered was stopped");
  // It tries once for each change, so the same code isn't tried again on the next checks.
  await checked(port, first.pid, 3, back.checks);
  assert.equal(events(home).filter((e) => e.event === "pages_restart").length, 1);
  assert.equal((await info(port))?.pid, first.pid);
});

test("a session on a newer release moves the pages to that release's install", async () => {
  const older = copyHoop(),
    newer = copyHoop("99.0.0"),
    port = await freePort(),
    home = tempHome();
  const first = await startPages(older, port, home, SLOW_START);
  // A session from the newer install records itself in the same store, and leaves the pages to the process.
  const session = spawn(process.execPath, [tsx, join(newer, "src/cli.ts"), "mcp"], {
    env: { ...process.env, HOOP_HOME: home, HOOP_PORT: String(port), HOOP_PAGES: "off" },
    stdio: ["pipe", "ignore", "ignore"],
  });
  try {
    const moved = await until(async () => {
      const i = await info(port);
      return i?.release === "99.0.0" ? i : undefined;
    }, 90_000);
    assert.ok(moved, "the pages run the newer release");
    assert.notEqual(moved.pid, first.pid);
  } finally {
    session.kill();
  }
});

test("the pages process exits when its install is gone and no session is live", async () => {
  const install = copyHoop(),
    port = await freePort(),
    home = tempHome();
  const first = await startPages(install, port, home);
  rmSync(install, { recursive: true, force: true });
  const gone = await until(async () => (alive(first.pid) ? undefined : true));
  assert.equal(gone, true);
});

test("page loads with the restart timer on take no more than 50 ms longer than without it", async () => {
  const load = async (port: number) => {
    const t = performance.now();
    await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    return performance.now() - t;
  };
  // The 95th percentile still holds the loads that wait on a check, but not one stray pause.
  const p95 = (runs: number[]) => runs.sort((x, y) => x - y)[Math.floor(runs.length * 0.95)]!;
  const foreground = await freePort(),
    background = await freePort(),
    home = tempHome();
  const env = (port: number, pages: string) => ({ ...process.env, HOOP_PAGES: pages, HOOP_PORT: String(port), HOOP_HOME: home });
  const plain = spawn(process.execPath, [tsx, join(root, "src/cli.ts"), "serve"], { env: env(foreground, "off"), stdio: "ignore" });
  const install = copyHoop();
  const session = spawn(process.execPath, [tsx, join(install, "src/cli.ts"), "mcp"], { env: env(background, "off"), stdio: ["pipe", "ignore", "ignore"] });
  try {
    assert.ok(await until(() => info(foreground)), "the foreground pages answer");
    // The usual check interval, whose cost this measures.
    const up = await startPages(install, background, home, { HOOP_PAGES_CHECK_MS: "2000" });
    // Loads alternate between the two servers, so both see the same load on the machine, and go on
    // for at least five seconds and until the timer has made two checks; a live session makes each
    // check read the sessions.
    const plainRuns: number[] = [],
      timerRuns: number[] = [];
    const from = up.checks ?? 0;
    for (const end = Date.now() + 5000; ; await sleep(25)) {
      plainRuns.push(await load(foreground));
      timerRuns.push(await load(background));
      if (Date.now() >= end && ((await info(background))?.checks ?? 0) >= from + 2) break;
      assert.ok(Date.now() < end + 60_000, "the timer made two checks");
    }
    const without = p95(plainRuns),
      withTimer = p95(timerRuns);
    assert.ok(withTimer - without <= 50, `95th percentile ${withTimer.toFixed(1)} ms with the timer, ${without.toFixed(1)} ms without`);
  } finally {
    plain.kill();
    session.kill();
  }
});

test("an update in place while a session is live restarts the pages once, into current code", async () => {
  const install = copyHoop(),
    port = await freePort(),
    home = tempHome();
  const first = await startPages(install, port, home, SLOW_START);
  const session = spawn(process.execPath, [tsx, join(install, "src/cli.ts"), "mcp"], {
    env: { ...process.env, HOOP_HOME: home, HOOP_PORT: String(port), HOOP_PAGES: "off" },
    stdio: ["pipe", "ignore", "ignore"],
  });
  try {
    // The session records itself, with the release its install held when it started.
    const recorded = await until(async () => {
      try {
        return readdirSync(join(home, "sessions")).length ? true : undefined;
      } catch {
        return undefined;
      }
    });
    assert.ok(recorded, "the session recorded itself");
    const pkg = JSON.parse(readFileSync(join(install, "package.json"), "utf8"));
    writeFileSync(join(install, "package.json"), JSON.stringify({ ...pkg, version: "0.3.0" }));
    appendFileSync(join(install, "web/app.js"), "\n// a newer build\n");
    const next = await until(async () => {
      const i = await info(port);
      return i?.release === "0.3.0" && i.pid !== first.pid ? i : undefined;
    }, 90_000);
    assert.ok(next, "the pages run the updated release");
    // The session's entry still names the old release; that must not start a second restart.
    const later = await checked(port, next.pid, 3, next.checks);
    assert.equal(later?.pid, next.pid);
    assert.equal(later?.stale, false);
    assert.equal(events(home).filter((e) => e.event === "pages_restart").length, 1);
  } finally {
    session.kill();
  }
});

test("an entry with no program to run leaves the pages serving", async () => {
  const install = copyHoop(),
    port = await freePort(),
    home = tempHome();
  const first = await startPages(install, port, home);
  // A live process with a broken entry, on a newer release so it would be the target.
  const newer = copyHoop("99.0.0");
  const remove = registerSession(home, tmpdir());
  const file = join(home, "sessions", `${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), install: newer, release: "99.0.0", start: [""] }));
  try {
    const now = await checked(port, first.pid, 3, (await info(port))?.checks);
    assert.equal(now?.pid, first.pid, "the pages still answer");
    assert.equal(now?.stale, false);
  } finally {
    remove();
  }
});

test("the target is the newest live release, a rollback included, and one release never restarts another install", () => {
  const a = copyHoop("0.2.0"),
    b = copyHoop("0.1.0"),
    c = copyHoop("0.2.0");
  const own = { install: a, release: "0.2.0", code: codeId(a) };
  const session = (install: string, release: string): Session => ({
    format: 1,
    pid: 1,
    started: 0,
    boot: 0,
    repo: "/r",
    install,
    release,
    start: ["node", join(install, "src/cli.ts")],
  });
  assert.equal(restartTarget(own, []), undefined, "current code with no session");
  const back = restartTarget(own, [session(b, "0.1.0")]);
  assert.ok(back && back !== "gone");
  assert.equal(back.release, "0.1.0", "a rollback leaves an older release as the newest one in use");
  assert.equal(restartTarget(own, [session(c, "0.2.0"), session(b, "0.1.0")]), undefined, "another install of the same release");
  assert.equal(restartTarget(own, [session(a, "0.1.0")]), undefined, "an install updated in place, whose entry still names the old release");
  const bad = copyHoop("9.0.0");
  assert.equal(restartTarget(own, [{ ...session(bad, "9.0.0"), start: [""] }]), undefined, "an entry with no program to run");
  rmSync(b, { recursive: true, force: true });
  assert.equal(restartTarget(own, [session(b, "0.1.0")]), undefined, "a session whose install is gone");
  rmSync(a, { recursive: true, force: true });
  assert.equal(restartTarget(own, []), "gone");
  assert.equal(restartTarget(own, [session(c, "0.2.0")]), undefined, "a live session keeps it while its own install is gone");
});

test("pages from a foreground hoop serve warn once its code changes, and don't restart", async () => {
  const install = copyHoop(),
    port = await freePort(),
    home = tempHome();
  const env = { ...process.env, HOOP_PAGES: "off", HOOP_PORT: String(port), HOOP_HOME: home, ...FAST_CHECKS };
  const serve = spawn(process.execPath, [tsx, join(install, "src/cli.ts"), "serve"], { env, stdio: "ignore" });
  try {
    const first = await until(() => info(port));
    assert.equal(first?.stale, false);
    appendFileSync(join(install, "web/app.js"), "\n// a newer build\n");
    const stale = await until(async () => {
      const i = await info(port);
      return i?.stale ? i : undefined;
    });
    assert.ok(stale, "the pages warn");
    assert.equal(stale.pid, first!.pid, "a foreground server doesn't restart itself");
  } finally {
    serve.kill();
  }
});
