import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_SKIP, hoopArgs, tempHome, withBrowser, withServer } from "./helpers.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { PACKAGE, UpdateCheck, update, updateCommand } from "../src/update.js";
import { ownInstall, release } from "../src/version.js";

const DAY = 24 * 60 * 60 * 1000;

/** A stand-in for npm that answers `answer` (or fails) and counts its calls. */
function npm(answer: string | Error) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (answer instanceof Error) throw answer;
    return `${answer}\n`;
  };
  return { calls, run };
}

test("the pages process asks npm for the latest hoop at most once a day, and keeps the answer", async () => {
  const home = tempHome();
  let now = Date.parse("2026-11-08T10:00:00Z");
  const n = npm("9.1.0");
  const check = new UpdateCheck(home, n.run, () => now);
  assert.equal(check.available("1.0.0"), undefined, "nothing known yet: it asks in the background");
  await check.settled();
  assert.deepEqual(n.calls, [["view", PACKAGE, "version"]]);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "update.json"), "utf8")), { checked_at: "2026-11-08T10:00:00.000Z", latest: "9.1.0" });
  assert.equal(check.available("1.0.0"), "9.1.0");
  assert.equal(check.available("9.1.0"), undefined, "not newer: nothing to show");
  assert.equal(check.available("9.2.0"), undefined);
  now += DAY - 1000;
  check.available("1.0.0");
  await check.settled();
  assert.equal(n.calls.length, 1, "within the day it doesn't ask again");
  // A new process reads the kept answer, and asks once the day is over.
  now += 2000;
  const next = new UpdateCheck(home, n.run, () => now);
  assert.equal(next.available("1.0.0"), "9.1.0");
  next.available("1.0.0");
  await next.settled();
  assert.equal(n.calls.length, 2, "one ask, however often Home asks while it runs");
});

test("offline, the check fails silently, keeps its last answer and waits a day", async () => {
  const home = tempHome();
  let now = Date.parse("2026-11-08T10:00:00Z");
  writeFileSync(join(home, "update.json"), JSON.stringify({ checked_at: new Date(now - 2 * DAY).toISOString(), latest: "2.0.0" }));
  const off = npm(new Error("getaddrinfo ENOTFOUND registry.npmjs.org"));
  const check = new UpdateCheck(home, off.run, () => now);
  assert.equal(check.available("1.0.0"), "2.0.0");
  await check.settled();
  assert.equal(off.calls.length, 1);
  assert.equal(JSON.parse(readFileSync(join(home, "update.json"), "utf8")).latest, "2.0.0");
  now += 60_000;
  check.available("1.0.0");
  await check.settled();
  assert.equal(off.calls.length, 1, "a failed ask waits a day too");
  // An answer that isn't a version is ignored.
  const odd = npm("npm WARN something");
  const fresh = tempHome();
  const c = new UpdateCheck(fresh, odd.run, () => now);
  c.available("1.0.0");
  await c.settled();
  assert.equal(c.available("1.0.0"), undefined);
});

test("/api/info gives a newer hoop and the command for it, and nothing without a check", async () => {
  const home = tempHome();
  writeFileSync(join(home, "update.json"), JSON.stringify({ checked_at: new Date().toISOString(), latest: "99.0.0" }));
  const updates = new UpdateCheck(home, npm("99.0.0").run);
  await withServer({ updates }, async (base) => {
    const info = await (await fetch(`${base}/api/info`)).json();
    assert.deepEqual(info.update, { latest: "99.0.0", command: "hoop update" });
  });
  await withServer({}, async (base) => {
    assert.equal((await (await fetch(`${base}/api/info`)).json()).update, undefined, "createWebServer alone never checks");
  });
  assert.equal(updateCommand("/Users/a/.npm/_npx/1a2b/node_modules/@ankurjain-nitrr/hoop/"), `npx -y ${PACKAGE}@latest update`);
  assert.equal(updateCommand(ownInstall()), "hoop update");
  assert.ok(release(ownInstall()));
});

test("Home shows a newer hoop as a callout with the command and its Copy button, only when newer", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  writeFileSync(join(home, "update.json"), JSON.stringify({ checked_at: new Date().toISOString(), latest: "99.0.0" }));
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/`);
      const notice = page.locator(".list .update-notice");
      await notice.waitFor();
      assert.equal((await notice.textContent())?.replace(/\s+/g, " ").trim(), "hoop 99.0.0 is available. To update, run hoop updateCopy");
      assert.equal(await notice.locator("code").textContent(), "hoop update");
      assert.equal(await notice.getByRole("button", { name: "Copy the command hoop update" }).count(), 1);
      // It sits under Home's header, above the sections.
      assert.equal(await page.locator(".list > .list-head + .update-notice").count(), 1);
    },
    new Hoop(new Store(home)),
    { updates: new UpdateCheck(home, npm("99.0.0").run) },
  );
  const current = tempHome();
  writeFileSync(join(current, "update.json"), JSON.stringify({ checked_at: new Date().toISOString(), latest: release(ownInstall()) }));
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/`);
      await page.locator(".list-head").waitFor();
      assert.equal(await page.locator(".update-notice").count(), 0, "the running release: no notice");
    },
    new Hoop(new Store(current)),
    { updates: new UpdateCheck(current, npm("0.0.1").run) },
  );
});

/** A stand-in for running commands: records each, and fails the one named `fail`. */
function runner(fail?: string) {
  const ran: string[] = [];
  const run = (cmd: string, args: string[]) => {
    const line = [cmd, ...args].join(" ");
    ran.push(line);
    return line === fail ? 1 : 0;
  };
  return { ran, run };
}

const NPM = `npm install -g ${PACKAGE}@latest`;
const MARKET = "claude plugin marketplace update hoop";
const PLUGIN = "claude plugin update hoop@hoop";

test("hoop update prints its commands first, then updates the global package and the plugin", () => {
  let out = "";
  const r = runner();
  assert.equal(update({ run: r.run, global: () => true, claude: () => true, out: (s) => void (out += s) }), 0);
  assert.deepEqual(r.ran, [NPM, MARKET, PLUGIN]);
  const listed = out.indexOf(`hoop update runs:\n\n  ${NPM}\n  ${MARKET}\n  ${PLUGIN}\n`);
  assert.ok(listed >= 0, out);
  assert.ok(listed < out.indexOf(`hoop: ${NPM}`), "printed before any runs");
  assert.match(out, /hoop: updated\. Start a new Claude Code session/);

  // --print only prints.
  let printed = "";
  const p = runner();
  assert.equal(update({ print: true, run: p.run, global: () => true, claude: () => true, out: (s) => void (printed += s) }), 0);
  assert.deepEqual(p.ran, []);
  assert.match(printed, /hoop update would run:/);
});

test("hoop update stops at a failed command and says what is left to run", () => {
  let out = "";
  const r = runner(MARKET);
  assert.equal(update({ run: r.run, global: () => true, claude: () => true, out: (s) => void (out += s) }), 1);
  assert.deepEqual(r.ran, [NPM, MARKET]);
  assert.match(out, new RegExp(`that failed \\(exit 1\\)\\. Run these yourself:\\n\\n  ${MARKET}\\n  ${PLUGIN.replace(".", "\\.")}\\n`));
});

test("without a global install hoop update updates the plugin only; without claude it says how", () => {
  let out = "";
  const r = runner();
  assert.equal(update({ run: r.run, global: () => false, claude: () => true, out: (s) => void (out += s) }), 0);
  assert.deepEqual(r.ran, [MARKET, PLUGIN]);
  assert.match(out, /isn't installed with npm -g here/);

  let none = "";
  const n = runner();
  assert.equal(update({ run: n.run, global: () => false, claude: () => false, out: (s) => void (none += s) }), 1);
  assert.deepEqual(n.ran, []);
  assert.match(none, new RegExp(`claude isn't on PATH\\. To update the plugin, run:\\n\\n  ${MARKET}\\n`));
});

test("the hoop update command runs npm and claude from PATH, and refuses other flags", () => {
  // Stand-ins for npm and claude, on a PATH with neither of the real ones.
  const bin = mkdtempSync(join(tmpdir(), "hoop-update-bin-"));
  const root = mkdtempSync(join(tmpdir(), "hoop-update-root-"));
  mkdirSync(join(root, PACKAGE), { recursive: true });
  writeFileSync(join(root, PACKAGE, "package.json"), "{}");
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> "${log}"\n[ "$1" = root ] && echo "${root}"\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "claude $*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  const hoop = (...args: string[]) => spawnSync(process.execPath, [...hoopArgs, "update", ...args], { encoding: "utf8", env });
  const printed = hoop("--print");
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, new RegExp(`would run:\\n\\n  ${NPM}\\n  ${MARKET}\\n`));
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["npm root -g", "claude --version"], "--print runs nothing that changes anything");
  const ran = hoop();
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").slice(2), ["npm root -g", "claude --version", NPM, MARKET, PLUGIN]);
  assert.equal(hoop("--yes").status, 2);
});
