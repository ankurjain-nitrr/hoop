import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeId, isNewer, ownInstall, release } from "../src/version.js";
import { bootTime, liveSessions, processStart, registerSession, SESSION_FORMAT, startCommand, storeKey } from "../src/sessions.js";

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

test("FR-4: releases compare as dotted numbers, and one that doesn't parse is never newer", () => {
  assert.equal(isNewer("1.10.0", "1.9.9"), true);
  assert.equal(isNewer("1.9.9", "1.10.0"), false);
  assert.equal(isNewer("2.0", "2.0.0"), false);
  assert.equal(isNewer("2.0.1", "2.0"), true);
  assert.equal(isNewer("next", "0.0.1"), false);
  assert.equal(isNewer("0.0.1", "next"), true);
  assert.equal(isNewer(undefined, "1.0.0"), false);
});

test("NFR-3: working out the code ID of hoop's own install takes well under 50 milliseconds", () => {
  codeId(ownInstall());
  const t = performance.now();
  codeId(ownInstall());
  assert.ok(performance.now() - t < 50, `took ${performance.now() - t} ms`);
});

test("FR-6: a session records itself with its repository and install, and removes the record", () => {
  const home = tmp("hoop-sessions-"), repo = tmp("hoop-repo-");
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
  const home = tmp("hoop-sessions-"), dir = join(home, "sessions");
  mkdirSync(dir);
  const base = { format: 1, pid: process.pid, started: Date.now() - process.uptime() * 1000, boot: bootTime(), repo: "/r", install: "/i", release: "1.0.0", start: ["node"] };
  writeFileSync(join(dir, "a.json"), "{ not json");
  writeFileSync(join(dir, "b.json"), JSON.stringify({ ...base, format: SESSION_FORMAT + 1 }));
  writeFileSync(join(dir, "c.json"), JSON.stringify({ ...base, start: "node cli.js" }));
  // A process that has exited.
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => child.on("exit", r));
  writeFileSync(join(dir, "d.json"), JSON.stringify({ ...base, pid: child.pid }));
  // A live process ID whose start time doesn't match: a reused ID.
  writeFileSync(join(dir, "e.json"), JSON.stringify({ ...base, started: base.started - 3_600_000 }));
  // An entry with fields this release doesn't know still counts.
  writeFileSync(join(dir, "f.json"), JSON.stringify({ ...base, later: { x: 1 } }));
  const live = liveSessions(home);
  assert.equal(live.length, 1);
  assert.deepEqual((live[0] as unknown as { later: unknown }).later, { x: 1 });
});

test("FR-6: the start time comes from ps, and matches this process within a few seconds", () => {
  const t = processStart(process.pid);
  if (t === undefined) return; // no ps on this machine; liveness falls back to the boot time
  assert.ok(Math.abs(t - (Date.now() - process.uptime() * 1000)) < 5_000);
});

test("NFR-2: a store's key is the same for a folder and a link to it, and hides the path", () => {
  const home = tmp("hoop-home-"), link = join(tmp("hoop-link-"), "home");
  symlinkSync(home, link);
  assert.equal(storeKey(link), storeKey(home));
  assert.match(storeKey(home), /^[0-9a-f]{16}$/);
  assert.notEqual(storeKey(home), storeKey(tmp("hoop-home-")));
});
