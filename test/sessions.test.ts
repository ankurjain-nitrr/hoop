import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeId, isNewer, ownInstall, release } from "../src/version.js";
import {
  bootTime,
  liveSessions,
  loaderArgs,
  parseElapsed,
  processStart,
  sameStart,
  registerSession,
  SESSION_FORMAT,
  startCommand,
  storeKey,
} from "../src/sessions.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** A minimal install folder: a package.json and one page file. */
function install(version = "1.2.3") {
  const dir = tmp("hoop-install-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "hoop", version }));
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web", "app.js"), "export {};\n");
  return dir;
}

test("FR-4: an install's release comes from its package.json, and a missing install has none", () => {
  assert.equal(release(install("2.0.1")), "2.0.1");
  assert.equal(release(join(tmpdir(), "no-such-hoop-install")), undefined);
  assert.equal(release(ownInstall()), JSON.parse(readFileSync(join(ownInstall(), "package.json"), "utf8")).version);
});

test("FR-4: the code ID changes when a file's size or time changes, and is undefined for a missing install", () => {
  const dir = install();
  const before = codeId(dir);
  assert.match(before ?? "", /^[0-9a-f]{12}$/);
  assert.equal(codeId(dir), before, "same files, same ID");
  writeFileSync(join(dir, "web", "app.js"), "export const x = 1;\n");
  assert.notEqual(codeId(dir), before, "a changed file changes the ID");
  const after = codeId(dir);
  const t = new Date(Date.now() + 60_000);
  utimesSync(join(dir, "web", "app.js"), t, t);
  assert.notEqual(codeId(dir), after, "a new modified time changes the ID");
  assert.equal(codeId(join(tmpdir(), "no-such-hoop-install")), undefined);
});

test("FR-4: releases compare as dotted numbers, and a release that doesn't parse never compares as newer or older", () => {
  assert.equal(isNewer("1.10.0", "1.9.9"), true);
  assert.equal(isNewer("1.9.9", "1.10.0"), false);
  assert.equal(isNewer("2.0", "2.0.0"), false);
  assert.equal(isNewer("2.0.1", "2.0"), true);
  assert.equal(isNewer("next", "0.0.1"), false);
  assert.equal(isNewer("1.0.0", "2.0.0-rc.1"), false, "a release that doesn't parse is never older either");
  assert.equal(isNewer(undefined, "1.0.0"), false);
});

test("NFR-3: working out the code ID of hoop's own install takes well under 50 milliseconds", () => {
  codeId(ownInstall());
  const t = performance.now();
  codeId(ownInstall());
  assert.ok(performance.now() - t < 50, `took ${performance.now() - t} ms`);
});

test("FR-6: a session records itself with its repository and install, and removes the record", () => {
  const home = tmp("hoop-sessions-"),
    repo = tmp("hoop-repo-");
  const remove = registerSession(home, repo);
  const [s, ...rest] = liveSessions(home);
  assert.equal(rest.length, 0);
  assert.equal(s!.pid, process.pid);
  assert.equal(s!.format, SESSION_FORMAT);
  assert.equal(s!.install, ownInstall());
  assert.equal(s!.release, release(ownInstall()));
  assert.deepEqual(s!.start, startCommand());
  remove();
  assert.deepEqual(liveSessions(home), []);
});

test("FR-6: the start command runs this install's CLI module with Node and its loader arguments, never argv[1]", () => {
  const [node, ...args] = startCommand();
  assert.equal(node, process.execPath);
  assert.match(args.at(-1)!, /[/\\]src[/\\]cli\.ts$|[/\\]dist[/\\]cli\.js$/);
  assert.notEqual(args.at(-1), process.argv[1]);
});

test("FR-6: entries that don't parse, have a newer format, lack fields or belong to an ended process are skipped", async () => {
  const base = {
    format: 1,
    pid: process.pid,
    started: Date.now() - process.uptime() * 1000,
    boot: bootTime(),
    repo: "/r",
    install: "/i",
    release: "1.0.0",
    start: ["node"],
  };
  /** How many live sessions one entry, filed under its process ID, gives. */
  const count = (entry: unknown, raw?: string) => {
    const home = tmp("hoop-sessions-"),
      dir = join(home, "sessions");
    mkdirSync(dir);
    const pid = (entry as { pid?: number }).pid ?? process.pid;
    writeFileSync(join(dir, `${pid}.json`), raw ?? JSON.stringify(entry));
    return liveSessions(home).length;
  };
  assert.equal(count(base, "{ not json"), 0, "doesn't parse");
  assert.equal(count({ ...base, format: SESSION_FORMAT + 1 }), 0, "newer format");
  assert.equal(count({ ...base, start: "node cli.js" }), 0, "start as a string");
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => child.on("exit", r));
  assert.equal(count({ ...base, pid: child.pid }), 0, "ended process");
  assert.equal(count({ ...base, started: base.started - 3_600_000 }), 0, "a reused ID: the start time doesn't match (needs ps)");
  assert.equal(count({ ...base, later: { x: 1 } }), 1, "unknown fields still count");
});

test("FR-6: the start time comes from ps, and matches this process within a few seconds", () => {
  const t = processStart(process.pid);
  if (t === undefined) return; // no ps on this machine; liveness falls back to the boot time
  assert.ok(Math.abs(t - (Date.now() - process.uptime() * 1000)) < 5_000);
});

test("NFR-2: a store's key is the same for a folder and a link to it, and hides the path", () => {
  const home = tmp("hoop-home-"),
    link = join(tmp("hoop-link-"), "home");
  symlinkSync(home, link);
  assert.equal(storeKey(link), storeKey(home));
  assert.match(storeKey(home), /^[0-9a-f]{16}$/);
  assert.notEqual(storeKey(home), storeKey(tmp("hoop-home-")));
});

test("FR-6: an entry for process ID 0 or below, or filed under another ID, is never live", () => {
  const home = tmp("hoop-sessions-"),
    dir = join(home, "sessions");
  mkdirSync(dir);
  const base = { format: 1, started: 0, boot: bootTime(), repo: "/r", install: "/i", release: "99.0.0", start: ["/bin/sh", "-c", "true"] };
  writeFileSync(join(dir, "0.json"), JSON.stringify({ ...base, pid: 0 }));
  writeFileSync(join(dir, "-1.json"), JSON.stringify({ ...base, pid: -1 }));
  writeFileSync(join(dir, "1.json"), JSON.stringify({ ...base, pid: process.pid, started: Date.now() - process.uptime() * 1000 }));
  assert.deepEqual(liveSessions(home), []);
});

test("FR-6: an entry that isn't a small regular file is skipped without reading it", () => {
  const home = tmp("hoop-sessions-"),
    dir = join(home, "sessions");
  mkdirSync(dir);
  const entry = {
    format: 1,
    pid: process.pid,
    started: Date.now() - process.uptime() * 1000,
    boot: bootTime(),
    repo: "/r",
    install: "/i",
    release: "1.0.0",
    start: ["node"],
  };
  // A valid entry padded past the size limit: a reader that reads it whole would accept it.
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ ...entry, pad: "x".repeat(70_000) }));
  assert.deepEqual(liveSessions(home), []);
  rmSync(join(dir, `${process.pid}.json`));
  mkdirSync(join(dir, `${process.pid}.json`));
  assert.deepEqual(liveSessions(home), []);
});

test("FR-6: entries missing any field are skipped", () => {
  const home = tmp("hoop-sessions-"),
    dir = join(home, "sessions");
  mkdirSync(dir);
  const full = {
    format: 1,
    pid: process.pid,
    started: Date.now() - process.uptime() * 1000,
    boot: bootTime(),
    repo: "/r",
    install: "/i",
    release: "1.0.0",
    start: ["node"],
  };
  for (const key of ["started", "boot", "repo", "install", "release", "start"]) {
    const { [key as keyof typeof full]: _gone, ...rest } = full;
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify(rest));
    assert.deepEqual(liveSessions(home), [], `without ${key}`);
  }
});

test("FR-6: a start time matches whether ps counts from the wall clock or from boot", () => {
  const started = 1_000_000,
    boot = 400_000;
  // The wall clock stepped 60 seconds forward after the session started.
  assert.equal(sameStart({ started, boot }, { started: started + 60_000, boot: boot + 60_000 }), true, "boot based ps, as on Linux");
  assert.equal(sameStart({ started, boot }, { started, boot: boot + 60_000 }), true, "wall based ps, as on macOS");
  assert.equal(sameStart({ started, boot }, { started: started + 3_600_000, boot }), false, "another process");
});

test("FR-6: ps elapsed times parse in every form, and anything else is unknown", () => {
  assert.equal(parseElapsed("05:07"), 307);
  assert.equal(parseElapsed("1:02:03"), 3723);
  assert.equal(parseElapsed("2-01:02:03"), 2 * 86400 + 3723);
  assert.equal(parseElapsed("garbage"), undefined);
  assert.equal(parseElapsed(""), undefined);
});

test("FR-6: with a ps that prints garbage, liveness falls back to the boot time", () => {
  const bin = tmp("hoop-fake-ps-");
  writeFileSync(join(bin, "ps"), "#!/bin/sh\necho nonsense\n", { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const home = tmp("hoop-sessions-");
    const remove = registerSession(home, tmp("hoop-repo-"));
    assert.equal(liveSessions(home).length, 1);
    remove();
  } finally {
    process.env.PATH = path;
  }
});

test("FR-6: removing a registration also stops its exit listener", () => {
  const events = ["exit"] as const;
  const before = events.map((e) => process.listenerCount(e));
  const remove = registerSession(tmp("hoop-sessions-"), tmp("hoop-repo-"));
  remove();
  assert.deepEqual(
    events.map((e) => process.listenerCount(e)),
    before,
  );
});

test("FR-6: the start command keeps only loader arguments from Node's own arguments", () => {
  assert.deepEqual(loaderArgs(["--require", "/a.cjs", "--inspect=9229", "--import", "file:///b.mjs", "--cpu-prof", "--loader=x", "--watch"]), [
    "--require",
    "/a.cjs",
    "--import",
    "file:///b.mjs",
    "--loader=x",
  ]);
});

test("FR-6: a session records its repository's real folder", () => {
  const home = tmp("hoop-sessions-"),
    repo = tmp("hoop-repo-"),
    link = join(tmp("hoop-link-"), "repo");
  symlinkSync(repo, link);
  const remove = registerSession(home, link);
  assert.equal(liveSessions(home)[0]!.repo, realpathSync.native(repo));
  remove();
});

test("FR-6: the boot relative match needs the same boot, so a process ID reused after a reboot isn't live", () => {
  const entry = { started: 1_000_000, boot: 960_000, bootId: "boot-a" };
  // The next boot: the same offset from boot, a later boot time and another boot identifier.
  assert.equal(sameStart(entry, { started: 9_000_000, boot: 8_960_000, bootId: "boot-b" }), false);
  assert.equal(sameStart(entry, { started: 1_060_000, boot: 1_020_000, bootId: "boot-a" }), true, "a clock step in the same boot");
});

test("FR-6: when ps runs but doesn't list a process, its entry isn't live", () => {
  const bin = tmp("hoop-quiet-ps-");
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const home = tmp("hoop-sessions-");
    const remove = registerSession(home, tmp("hoop-repo-"));
    assert.equal(liveSessions(home).length, 0);
    remove();
  } finally {
    process.env.PATH = path;
  }
});

test("FR-6: registering a session adds no signal handlers, so the caller owns shutdown", () => {
  const sigs = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const before = sigs.map((s) => process.listenerCount(s));
  const remove = registerSession(tmp("hoop-sessions-"), tmp("hoop-repo-"));
  assert.deepEqual(
    sigs.map((s) => process.listenerCount(s)),
    before,
  );
  remove();
});
