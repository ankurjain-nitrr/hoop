import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Steer } from "../src/steer.js";
import { type ClaudeSession, readWork, type TodoLink, workHook, workView, type WorkSession } from "../src/work.js";
import { workAlerts } from "../web/pending.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });
const ms = (m: number) => Date.parse("2026-10-25T09:00:00.000Z") + m * 60_000;
const iso = (m: number) => new Date(ms(m)).toISOString();

/** A session as /api/work sends it: one todo waiting on a review, one running, and a subagent quiet for 20 minutes. */
const session = (more: Partial<WorkSession> = {}) =>
  ({
    id: SESSION,
    name: "Order export",
    state: "busy",
    updated: iso(30),
    reachable: true,
    activity: iso(29),
    parked: [],
    changes: [],
    todos: [
      {
        id: "1",
        text: "Write the plan",
        status: "running",
        order: 1,
        updated: iso(0),
        since: iso(0),
        links: [{ kind: "review", id: "rv_plan", title: "The plan", status: "awaiting_review", at: iso(10) }],
      },
      { id: "2", text: "Build it", status: "running", order: 2, updated: iso(5), since: iso(5) },
    ],
    agents: [{ id: "a1", description: "Search the code", status: "running", started: iso(1), activity: iso(10) }],
    ...more,
  }) as WorkSession;

test("the Work alerts are each todo or subagent that waits on the person or stalled, with its session and why", () => {
  assert.deepEqual(workAlerts([session()], ms(30)), [
    {
      key: `${SESSION}:todo:1:waiting`,
      title: "Waiting on you: Write the plan",
      body: "Order export · Waiting on you: review “The plan”",
    },
    { key: `${SESSION}:agent:a1:stalled`, title: "Stalled: Search the code", body: "Order export · Stalled: no activity for 20 m" },
  ]);
  assert.deepEqual(workAlerts([session({ state: "ended", activity: iso(0), updated: iso(0) })], ms(300)), [], "an ended session's work stops counting");
});

test("a todo or subagent that comes to wait on the person or stalls notifies once, only while notifications are on", { skip: BROWSER_SKIP }, () =>
  withBrowser(async ({ base, page }) => {
    await page.addInitScript(`
      Object.assign(window, { shown: [], HOOP_WORK_ALERT_MS: 100 });
      function Stub(title, opts) { shown.push({ title, tag: opts.tag, body: opts.body }); this.close = () => {}; }
      Stub.permission = "granted";
      window.Notification = Stub;
      if (!sessionStorage.getItem("off")) localStorage.setItem("hoop:notify", "on");
      document.hasFocus = () => false;
    `);
    const now = Date.now();
    const at = (m: number) => new Date(now + m * 60_000).toISOString();
    const running = { id: "1", text: "Write the plan", status: "running", order: 1, updated: at(-5), since: at(-5) };
    let sessions: unknown[] = [{ ...session(), activity: at(0), agents: [], todos: [running] }];
    let asked = 0;
    await page.route("**/api/work", (route) => {
      asked++;
      return route.fulfill({ json: { sessions } });
    });
    await page.goto(base);
    await page.waitForFunction(() => document.title.startsWith("Home"));
    await page.waitForTimeout(300);
    const waiting: TodoLink = { kind: "review", id: "rv_plan", title: "The plan", status: "awaiting_review", at: at(0) };
    sessions = [{ ...session(), activity: at(0), agents: [], todos: [{ ...running, links: [waiting] }] }];
    await page.waitForFunction(() => (window as unknown as { shown: unknown[] }).shown.length >= 1);
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { shown: unknown[] }).shown), [
      { title: "Waiting on you: Write the plan", tag: `${SESSION}:todo:1:waiting`, body: "Order export · Waiting on you: review “The plan”" },
    ]);

    // Off, the Work page isn't asked at all.
    await page.evaluate(() => {
      sessionStorage.setItem("off", "1");
      localStorage.setItem("hoop:notify", "off");
    });
    await page.reload();
    await page.waitForTimeout(300);
    const before = asked;
    await page.waitForTimeout(400);
    assert.equal(asked, before);
  }),
);

test("hoop tells the agent once when a todo it has in progress reads done from evidence, and the change is seen once it marks it done", async () => {
  const home = tempHome();
  workHook(home, hook("post-taskcreate"), iso(0));
  workHook(home, hook("post-taskupdate"), iso(1));
  const sent: string[] = [];
  const live: ClaudeSession[] = [{ session: SESSION, pid: process.pid, status: "busy", socket: "/tmp/hoop-test.sock" }];
  const steer = new Steer(home, () => live, { delayMs: 60_000, send: async (_socket, text) => void sent.push(text) });
  const merged: TodoLink = { kind: "pr", url: "https://github.com/acme/hoop/pull/12", number: 12, state: "merged", merged_at: iso(40), opened: true };
  const view = () => {
    const v = workView(home, () => live, ms(45));
    v[0]!.todos[0]!.links = [merged];
    return v;
  };

  steer.noteDone(view(), ms(45));
  steer.noteDone(view(), ms(46));
  const [c, ...more] = readWork(home, SESSION)!.changes!;
  assert.deepEqual(more, [], "once per todo");
  assert.deepEqual([c!.kind, c!.todo, c!.by, c!.text, c!.delivery], ["done", "3", "hoop", "PR #12 merged", "pending"]);
  await steer.flush(SESSION);
  assert.equal(sent.length, 1);
  assert.match(
    sent[0]!,
    /^From hoop's Work view: what hoop checked about your own todos\. It reports evidence and approves nothing\.\n- Todo #3 "Run the test suite" looks done: PR #12 merged\. If it is, mark it completed with TaskUpdate; if not, carry on and say what is left\.\n\n\(hoop-ref st_[a-z0-9]+\)$/,
  );
  assert.equal(readWork(home, SESSION)!.changes![0]!.delivery, "sent");
  workHook(home, hook("post-taskupdate-completed"), iso(50));
  assert.equal(readWork(home, SESSION)!.changes![0]!.delivery, "seen");
});

test("a session that takes no messages, or ended, isn't told, and a todo done without evidence isn't either", () => {
  const home = tempHome();
  workHook(home, hook("post-taskcreate"), iso(0));
  workHook(home, hook("post-taskupdate"), iso(1));
  const merged: TodoLink = { kind: "pr", url: "https://github.com/acme/hoop/pull/12", number: 12, state: "merged", merged_at: iso(40), opened: true };
  for (const live of [[{ session: SESSION, pid: process.pid, status: "busy" }], []] as ClaudeSession[][]) {
    const steer = new Steer(home, () => live, { delayMs: 60_000, send: async () => assert.fail("nothing to send") });
    const v = workView(home, () => live, ms(45));
    v[0]!.todos[0]!.links = [merged];
    steer.noteDone(v, ms(45));
  }
  const live: ClaudeSession[] = [{ session: SESSION, pid: process.pid, status: "busy", socket: "/tmp/hoop-test.sock" }];
  new Steer(home, () => live, { delayMs: 60_000 }).noteDone(
    workView(home, () => live, ms(45)),
    ms(45),
  );
  assert.equal(readWork(home, SESSION)!.changes, undefined);
});
