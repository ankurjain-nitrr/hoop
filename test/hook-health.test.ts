import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { BROWSER_SKIP, hoopArgs, pagesFor, tempHome, withBrowser } from "./helpers.js";
import { HOOK_GRACE_MS, hookWarnings, readStamps, stampHook, TODO_STAMP } from "../src/hook-health.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { WRITES } from "../src/writes.js";
import type { ClaudeSession } from "../src/work.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/hook-health.json", import.meta.url), "utf8"));
const WORK = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION: string = HOOKS.stop.session_id;
const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
/** The grace a hook gets, in seconds: a minute. */
const MINUTE = HOOK_GRACE_MS / 1000;

/** Writes a session's transcript in the tests' Claude folder: entries `secondsAgo` before NOW. */
function transcript(session: string, entries: object[]) {
  const folder = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-plain");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${session}.jsonl`), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}
const said = (s: number) => ({ type: "assistant", timestamp: iso(s), message: { content: [{ type: "text", text: "Done." }] } });
const call = (s: number, id: string, name: string) => ({
  type: "assistant",
  timestamp: iso(s),
  message: { content: [{ type: "tool_use", id, name, input: {} }] },
});
const result = (s: number, id: string) => ({ type: "user", timestamp: iso(s), message: { content: [{ type: "tool_result", tool_use_id: id }] } });
const live = (status: string, session = SESSION): ClaudeSession => ({ session, pid: 1, status, cwd: "/tmp/plain" });

test("a hook that reaches the pages process stamps the last time each event fired, and a todo tool's PostToolUse apart", () => {
  const home = tempHome();
  stampHook(home, HOOKS.stop, iso(30));
  stampHook(home, { ...WORK["post-taskcreate"], session_id: SESSION }, iso(20));
  stampHook(home, HOOKS["post-bash-pr"], iso(10));
  stampHook(home, HOOKS.stop, iso(5));
  assert.deepEqual(readStamps(home, SESSION), { Stop: iso(5), PostToolUse: iso(10), [TODO_STAMP]: iso(20) });
  // Input that names no session or event stamps nothing.
  stampHook(home, { hook_event_name: "Stop" });
  stampHook(home, { session_id: "../x", hook_event_name: "Stop" });
  stampHook(home, { session_id: "nobody-0000", hook_event_name: "../Stop" });
  assert.deepEqual(readStamps(home, "nobody-0000"), {});

  // The pages process stamps each hook write: the work hook (a turn end of a session with no work too), the gate and the pull request hook.
  const other = tempHome();
  const store = new Store(other);
  assert.deepEqual(WRITES.work_hook!.run(store, { input: HOOKS.stop }), { recorded: false });
  assert.ok(readStamps(other, SESSION).Stop);
  WRITES.work_gate!.run(store, { input: { ...WORK["pre-taskupdate"], session_id: SESSION } });
  WRITES.pr_hook!.run(store, { input: HOOKS["post-bash-pr"], session: SESSION });
  assert.deepEqual(Object.keys(readStamps(other, SESSION)).sort(), ["PostToolUse", "PreToolUse", "Stop"]);
});

test("hoop work-hook sends a turn end of a session with no work to the pages process, which stamps it", async () => {
  const home = tempHome();
  const env = { ...process.env, ...(await pagesFor(home)) };
  const run = spawnSync(process.execPath, [...hoopArgs, "work-hook"], { input: JSON.stringify(HOOKS.stop), env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(readStamps(home, SESSION).Stop, "the Stop hook left a stamp");
});

test("the warning shows for a running session whose turn ended with no hook, or whose todo calls had no PostToolUse, and not otherwise", () => {
  const home = tempHome();
  const warn = (sessions: ClaudeSession[], since = 0) => hookWarnings(home, sessions, since, NOW).map((w) => w.missing);

  // A turn ended two minutes ago and no hook ran since: the plugin's hooks don't run.
  transcript(SESSION, [said(2 * MINUTE)]);
  assert.deepEqual(hookWarnings(home, [live("idle")], 0, NOW), [{ session: SESSION, folder: "plain", missing: "all" }]);
  // Not while the turn runs, nor in the grace after it ends, nor for a session that isn't running.
  assert.deepEqual(warn([live("busy")]), []);
  transcript(SESSION, [said(10)]);
  assert.deepEqual(warn([live("idle")]), []);
  assert.deepEqual(warn([]), []);
  // A session only idle since it started (or since the pages process started) isn't warned about.
  transcript(SESSION, [said(10 * MINUTE)]);
  assert.deepEqual(warn([live("idle")], NOW - 5 * MINUTE * 1000), []);
  // Claude Code's procStart, as `ps -o lstart` prints it in UTC: five minutes before NOW.
  assert.deepEqual(warn([{ ...live("idle"), start: "Mon Oct 26 11:55:00 2026" }]), []);
  // A turn the person interrupted has no Stop hook.
  transcript(SESSION, [
    said(3 * MINUTE),
    { type: "user", timestamp: iso(3 * MINUTE - 1), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
  ]);
  assert.deepEqual(warn([live("idle")]), []);
  transcript(SESSION, [said(10 * MINUTE)]);
  // Its Stop hook stamped: hooks fire.
  stampHook(home, HOOKS.stop, iso(9 * MINUTE));
  assert.deepEqual(warn([live("idle")]), []);

  // Todo calls whose PostToolUse never came, though another hook ran: busy or idle.
  transcript(SESSION, [call(3 * MINUTE, "t1", "TaskCreate"), result(3 * MINUTE - 1, "t1"), call(10, "t2", "Bash")]);
  assert.deepEqual(warn([live("busy")]), ["todos"]);
  // A todo call still running, or within the grace, doesn't count.
  transcript(SESSION, [call(3 * MINUTE, "t1", "TaskCreate")]);
  assert.deepEqual(warn([live("busy")]), []);
  transcript(SESSION, [call(10, "t1", "TaskCreate"), result(9, "t1")]);
  assert.deepEqual(warn([live("busy")]), []);
  // Once a todo tool's PostToolUse stamps, it's gone.
  transcript(SESSION, [call(3 * MINUTE, "t1", "TodoWrite"), result(3 * MINUTE - 1, "t1")]);
  assert.deepEqual(warn([live("busy")]), ["todos"]);
  stampHook(home, { ...WORK["post-todowrite"], session_id: SESSION }, iso(2 * MINUTE));
  assert.deepEqual(warn([live("busy")]), []);
});

test("/api/work lists the sessions whose hooks don't fire, and the Work page says what is wrong and what to do", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  const quiet = "33333333-4444-5555-6666-777777777777";
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  transcript(quiet, [{ type: "assistant", timestamp: ago(5 * MINUTE), message: { content: [{ type: "text", text: "Done." }] } }]);
  const sessions = () => [live("idle", quiet)];
  const opts = { sessions, hooksSince: 0 };
  // A pages process started after the turn doesn't count it: the hook dropped its stamp then.
  const fresh = createWebServer(new Hoop(new Store(home)), [], { sessions });
  await new Promise<void>((r) => fresh.listen(0, "127.0.0.1", r));
  const none = await (await fetch(`http://127.0.0.1:${(fresh.address() as AddressInfo).port}/api/work`)).json();
  fresh.close();
  assert.deepEqual(none, { sessions: [] });

  await withBrowser(
    async ({ base, page }) => {
      const body = await (await fetch(`${base}/api/work`)).json();
      assert.deepEqual(body.hooks, [{ session: quiet, folder: "plain", missing: "all" }]);
      await page.goto(`${base}/work`);
      const warning = page.locator(".hooks-warning");
      await warning.waitFor();
      assert.equal(await warning.locator("h2").textContent(), "Hooks not firing");
      const text = (await warning.textContent()) ?? "";
      assert.match(text, /33333333-4444-5555-6666-777777777777 in plain: no hook has run since it started, though it finished a turn\./);
      assert.match(text, /isn't installed or enabled for this session.*Run claude plugin list.*then restart the session\./);
    },
    new Hoop(new Store(home)),
    opts,
  );
});
