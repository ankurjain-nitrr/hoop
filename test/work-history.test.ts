import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordStates } from "../src/history.js";
import { type ClaudeSession, HISTORY_MAX, readWork, type TodoLink, withState, workEvents, workHook, workView } from "../src/work.js";
import { historyText, todoState } from "../web/activity.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });
/** The fields Claude Code gives every hook, for an event of its own: Stop or SessionEnd. */
const event = (name: string, extra: Record<string, unknown> = {}) => {
  const { session_id, transcript_path, cwd, permission_mode } = HOOKS["post-taskcreate"];
  return { session_id, transcript_path, cwd, permission_mode, hook_event_name: name, ...extra };
};
/** A time `m` minutes after 09:00 on 25 Oct, as milliseconds and as ISO text. */
const ms = (m: number) => Date.parse("2026-10-25T09:00:00.000Z") + m * 60_000;
const iso = (m: number) => new Date(ms(m)).toISOString();
const live =
  (status: string): (() => ClaudeSession[]) =>
  () => [{ session: SESSION, pid: process.pid, status }];
const states = (home: string) => readWork(home, SESSION)!.todos[0]!.history!.map((h) => `${h.state}@${(Date.parse(h.at) - ms(0)) / 60_000}`);

test("a todo's history keeps each status the hooks saw and each state the page read, so a row says what came before", () => {
  const home = tempHome();
  workHook(home, hook("post-taskcreate"), iso(0));
  workHook(home, hook("post-taskupdate"), iso(20));
  // An edit to its text alone isn't a new state.
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "3", subject: "Run the whole suite" } }), iso(30));
  assert.deepEqual(states(home), ["queued@0", "running@20"]);

  // At 60 m it submits its plan for review; the page reads it waiting on you from then, though it looked only at 65 m.
  const waiting: TodoLink = { kind: "review", id: "rv_plan", title: "The plan", status: "awaiting_review", at: iso(60) };
  const view = workView(home, live("busy"), ms(65));
  view[0]!.todos[0]!.links = [waiting];
  recordStates(home, view, ms(65));
  assert.deepEqual(states(home), ["queued@0", "running@20", "waiting@60"]);
  assert.deepEqual(view[0]!.todos[0]!.history, readWork(home, SESSION)!.todos[0]!.history, "the answer carries the new history");
  // Asking again in the same state adds nothing.
  recordStates(home, view, ms(70));
  assert.equal(readWork(home, SESSION)!.todos[0]!.history!.length, 3);
  assert.equal(historyText(view[0]!.todos[0]!.history, "waiting"), "after running for 40 m");
  assert.equal(historyText(view[0]!.todos[0]!.history, "running"), "", "a history that doesn't end in the state says nothing");

  // It is approved and the agent goes on: running again, then done.
  const again = workView(home, live("busy"), ms(240));
  recordStates(home, again, ms(240));
  workHook(home, hook("post-taskupdate-completed"), iso(300));
  assert.deepEqual(states(home), ["queued@0", "running@20", "waiting@60", "running@240", "done@300"]);
  assert.equal(historyText(readWork(home, SESSION)!.todos[0]!.history, "done"), "after running for 1 h 0 m");
});

test("a state read late never starts before the one it follows, and a history keeps its last entries", () => {
  assert.deepEqual(withState([{ state: "running", at: iso(20) }], "waiting", iso(5)), [
    { state: "running", at: iso(20) },
    { state: "waiting", at: iso(20) },
  ]);
  let h = withState(undefined, "queued", iso(0));
  for (let n = 1; n <= 30; n++) h = withState(h, n % 2 ? "running" : "waiting", iso(n));
  assert.equal(h.length, HISTORY_MAX);
  assert.equal(h.at(-1)!.at, iso(30));
});

test("a session's end reconciles its work: it reads ended from then, its subagents stop, and a resume undoes it", () => {
  const home = tempHome();
  workHook(home, hook("post-taskcreate"), iso(0));
  workHook(home, hook("post-taskupdate"), iso(1));
  workHook(home, hook("subagent-start"), iso(2));
  workHook(home, event("SessionEnd", { reason: "prompt_input_exit" }), iso(50));
  const r = readWork(home, SESSION)!;
  assert.equal(r.ended, iso(50));
  assert.deepEqual(
    r.agents.map((a) => [a.status, a.ended]),
    [["stopped", iso(50)]],
  );
  // Its process may linger a moment: the hook's word counts.
  const [s] = workView(home, live("busy"), ms(55));
  assert.equal(s!.state, "ended");
  const st = todoState(s!, s!.todos[0]!, ms(55))!;
  assert.deepEqual([st.state, st.since], ["notrunning", iso(50)]);
  recordStates(home, [s!], ms(55));
  assert.deepEqual(states(home), ["queued@0", "running@1", "notrunning@50"]);
  assert.equal(historyText(s!.todos[0]!.history, "notrunning"), "after running for 49 m");

  // An async hook that ran late leaves it ended; one later is a resumed session.
  workHook(home, hook("post-taskget"), new Date(ms(50) + 2000).toISOString());
  assert.equal(readWork(home, SESSION)!.ended, iso(50));
  workHook(home, hook("post-taskget"), iso(80));
  assert.equal(readWork(home, SESSION)!.ended, undefined);
  assert.equal(workView(home, live("busy"), ms(80))[0]!.state, "busy");
});

test("a turn's end dates a todo left in progress, and a turn or session end of a session with no work writes nothing", () => {
  const home = tempHome();
  assert.deepEqual(workEvents(event("Stop", { stop_hook_active: false })), [{ kind: "turn-end" }]);
  assert.deepEqual(workEvents(event("SessionEnd", { reason: "clear" })), [{ kind: "session-end" }]);
  assert.equal(workHook(home, event("Stop")), undefined);
  assert.equal(workHook(home, event("SessionEnd")), undefined);
  assert.equal(existsSync(join(home, "work")), false);

  workHook(home, hook("post-taskcreate"), iso(0));
  workHook(home, hook("post-taskupdate"), iso(1));
  workHook(home, event("Stop"), iso(30));
  const s = { id: SESSION, state: "idle" as const, activity: iso(30), agents: [], todos: readWork(home, SESSION)!.todos, turn_ended: iso(30) };
  assert.deepEqual(todoState(s, s.todos[0]!, ms(90))!.since, iso(30));
  // A turn end long before the last activity is an earlier turn's: an interrupted turn has none.
  assert.equal(todoState({ ...s, activity: iso(45) }, s.todos[0]!, ms(90))!.since, iso(45));
});

test("the wrapper passes a turn or session end on only for a session with work, and the plugin hooks both", () => {
  const home = tempHome();
  const bin = mkdtempSync(join(tmpdir(), "hoop-work-bin-"));
  const fake = join(bin, "hoop");
  writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\necho "$@" >> "${bin}/ran"\n`, { mode: 0o755 });
  const wrapper = new URL("../plugins/hoop/scripts/track-work.sh", import.meta.url).pathname;
  const run = (input: object) =>
    spawnSync("sh", [wrapper], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, HOOP_HOME: home, HOOP_BIN: fake } });
  for (const name of ["Stop", "SessionEnd"]) assert.equal(run(event(name)).status, 0);
  assert.equal(existsSync(join(bin, "ran")), false, "no work: hoop isn't started");
  workHook(home, hook("post-taskcreate"), iso(0));
  for (const name of ["Stop", "SessionEnd"]) assert.equal(run(event(name)).status, 0);
  assert.deepEqual(readFileSync(join(bin, "ran"), "utf8").trim().split("\n"), ["work-hook", "work-hook"]);

  const hooks = JSON.parse(readFileSync(new URL("../plugins/hoop/hooks/hooks.json", import.meta.url), "utf8")).hooks;
  assert.match(hooks.Stop[0].hooks[0].command, /track-work\.sh/);
  assert.equal(hooks.Stop[0].hooks[0].async, true, "a turn's end never waits on hoop");
  assert.match(hooks.SessionEnd[0].hooks[0].command, /track-work\.sh/);
});

test("the Work page says what a todo left in an ended session did before", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  workHook(home, hook("post-taskcreate"), ago(55));
  workHook(home, hook("post-taskupdate"), ago(50));
  workHook(home, event("SessionEnd", { reason: "logout" }), ago(10));
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/work`);
      const row = page.locator(`#todo-${SESSION}-3`);
      await row.locator(".stall").waitFor();
      assert.equal(await row.locator(".stall").innerText(), "Not running: the session ended; this todo was left in progress");
      assert.equal(await row.locator(".clock").innerText(), "marked running for 50 m · after running for 40 m");
    },
    new Hoop(new Store(home)),
    { sessions: () => [] },
  );
});
