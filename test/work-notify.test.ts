import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptRequests } from "../src/requests.js";
import { Steer, steerMessage } from "../src/steer.js";
import type { WorkChange } from "../src/work.js";
import { type ClaudeSession, readWork, type TodoLink, workHook, workView, type WorkSession } from "../src/work.js";
import { ALERT_FORGET_MS, newAlerts, workAlerts } from "../web/pending.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });
const ms = (m: number) => Date.parse("2026-10-25T09:00:00.000Z") + m * 60_000;
const iso = (m: number) => new Date(ms(m)).toISOString();
const PR12 = "https://github.com/acme/hoop/pull/12";
const needsReview = (at: string): TodoLink => ({ kind: "pr", url: PR12, number: 12, state: "open", review_requested: true, opened_at: at });
type Todo = WorkSession["todos"][number];

/** A session as /api/work sends it: a todo whose pull request needs your review, one waiting on a hoop review, one running, and a subagent quiet for 20 minutes. */
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
      { id: "1", text: "Write the plan", status: "running", order: 1, updated: iso(0), since: iso(0), links: [needsReview(iso(10))] },
      {
        id: "3",
        text: "Get the plan approved",
        status: "running",
        order: 3,
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
    { key: `${SESSION}:todo:1:waiting`, title: "Waiting on you: Write the plan", body: "Order export · Waiting on you: PR #12 needs your review" },
    { key: `${SESSION}:agent:a1:stalled`, title: "Stalled: Search the code", body: "Order export · Stalled: no activity for 20 m" },
  ]);
  assert.deepEqual(workAlerts([session({ state: "ended", activity: iso(0), updated: iso(0) })], ms(300)), [], "an ended session's work stops counting");
});

test("waiting on a hoop review or ask doesn't alert: the review already notifies as a new review", () => {
  assert.deepEqual(workAlerts([session({ agents: [], todos: [session().todos[1]!] })], ms(30)), [], "a todo whose review waits on you");
  const t = { id: "2", text: "Build it", status: "running", order: 2, updated: iso(5), since: iso(5) } as Todo;
  const waits = (waiting: "review" | "question") =>
    workAlerts([session({ agents: [], todos: [t], doing: { what: "w", at: iso(20), open: true, waiting } })], ms(30));
  assert.deepEqual(waits("review"), [], "a session in hoop_wait or hoop_ask");
  assert.deepEqual(
    waits("question").map((a) => a.title),
    ["Waiting on you: Build it"],
    "AskUserQuestion has no notification of its own",
  );
});

test("an alert that flickers away and back within a minute notifies once; one gone for a minute notifies again", () => {
  const seen = new Map<string, number>();
  const a = { key: "s:todo:1:waiting" };
  assert.deepEqual(newAlerts(seen, [a], 0), [a]);
  // Between two hoop_wait calls the todo reads running for a poll or two.
  assert.deepEqual(newAlerts(seen, [], 15_000), []);
  assert.deepEqual(newAlerts(seen, [a], 30_000), [], "back after 15 s: no second notification");
  assert.deepEqual(newAlerts(seen, [], 30_000 + ALERT_FORGET_MS), []);
  assert.deepEqual(newAlerts(seen, [a], 31_000 + ALERT_FORGET_MS), [a]);
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
    const of = (todo: object) => [{ ...session(), activity: at(0), agents: [], todos: [todo] }];
    let sessions: unknown[] = of(running);
    let asked = 0;
    await page.route("**/api/work", (route) => {
      asked++;
      return route.fulfill({ json: { sessions } });
    });
    await page.goto(base);
    await page.waitForFunction(() => document.title.startsWith("Home"));
    await page.waitForTimeout(300);
    const waiting = of({ ...running, links: [needsReview(at(0))] });
    sessions = waiting;
    await page.waitForFunction(() => (window as unknown as { shown: unknown[] }).shown.length >= 1);
    // It reads running for a moment, then waits again: still one notification.
    sessions = of(running);
    await page.waitForTimeout(300);
    sessions = waiting;
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { shown: unknown[] }).shown), [
      { title: "Waiting on you: Write the plan", tag: `${SESSION}:todo:1:waiting`, body: "Order export · Waiting on you: PR #12 needs your review" },
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

const merged: TodoLink = { kind: "pr", url: PR12, number: 12, state: "merged", merged_at: iso(40), opened: true };
const sock = (status: string): ClaudeSession[] => [{ session: SESSION, pid: process.pid, status, socket: "/tmp/hoop-test.sock" }];
/** A session with todo #3 running, its description naming PR #12 unless `named` is false. */
function started(named = true) {
  const home = tempHome();
  workHook(home, hook("post-taskcreate"), iso(0));
  const description = named ? { description: `Ship ${PR12}` } : {};
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "3", status: "in_progress", ...description } }), iso(1));
  return home;
}
const viewOf = (home: string, live: ClaudeSession[]) => {
  const v = workView(home, () => live, ms(45));
  v[0]!.todos[0]!.links = [merged];
  return v;
};

test("hoop tells the agent once, after its turn ends, that a todo it named a pull request for looks done, and the note is seen once it marks it done", async () => {
  const home = started();
  const sent: string[] = [];
  let live = sock("busy");
  const steer = new Steer(home, () => live, { delayMs: 60_000, send: async (_socket, text) => void sent.push(text) });
  steer.noteDone(viewOf(home, live), ms(45));
  assert.equal(readWork(home, SESSION)!.changes, undefined, "not in the middle of a turn");
  live = sock("idle");
  steer.noteDone(viewOf(home, live), ms(45));
  steer.noteDone(viewOf(home, live), ms(46));
  const [c, ...more] = readWork(home, SESSION)!.changes!;
  assert.deepEqual(more, [], "once per todo");
  assert.deepEqual([c!.kind, c!.todo, c!.by, c!.text, c!.delivery], ["done", "3", "hoop", "PR #12 merged", "pending"]);
  await steer.flush(SESSION);
  assert.equal(sent.length, 1);
  assert.match(
    sent[0]!,
    /^From hoop's Work view: what hoop checked about your own todos\. It reports evidence and approves nothing\.\n- hoop sees PR #12 merged; if that finishes todo #3 "Run the test suite", mark it completed \(with TaskUpdate, or TodoWrite if you keep your list with it\), or say what's left\.\n\n\(hoop-ref st_[a-z0-9]+\)$/,
  );
  assert.equal(readWork(home, SESSION)!.changes![0]!.delivery, "sent");
  workHook(home, hook("post-taskupdate-completed"), iso(50));
  assert.equal(readWork(home, SESSION)!.changes![0]!.delivery, "seen");
});

test("a pull request the session only opened, which the todo doesn't name, tells the agent nothing", () => {
  const home = started(false);
  new Steer(home, () => sock("idle"), { delayMs: 60_000 }).noteDone(viewOf(home, sock("idle")), ms(45));
  assert.equal(readWork(home, SESSION)!.changes, undefined);
});

test("a todo whose place now holds another todo is told about again", () => {
  const home = started();
  const steer = new Steer(home, () => sock("idle"), { delayMs: 60_000 });
  steer.noteDone(viewOf(home, sock("idle")), ms(45));
  // A TodoWrite list reuses the place: same ID, another subject.
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "3", subject: "Release it" } }), iso(46));
  assert.equal(readWork(home, SESSION)!.changes![0]!.delivery, "seen");
  steer.noteDone(viewOf(home, sock("idle")), ms(47));
  assert.deepEqual(
    readWork(home, SESSION)!.changes!.map((c) => c.subject),
    ["Run the test suite", "Release it"],
  );
});

test("a session that takes no messages, or ended, isn't told, and a todo done without evidence isn't either", () => {
  const home = started();
  for (const live of [[{ session: SESSION, pid: process.pid, status: "idle" }], []] as ClaudeSession[][]) {
    const steer = new Steer(home, () => live, { delayMs: 60_000, send: async () => assert.fail("nothing to send") });
    steer.noteDone(viewOf(home, live), ms(45));
  }
  new Steer(home, () => sock("idle"), { delayMs: 60_000 }).noteDone(
    workView(home, () => sock("idle"), ms(45)),
    ms(45),
  );
  assert.equal(readWork(home, SESSION)!.changes, undefined);
});

test("a done note alone is hoop's, not a request; with a person's changes, the message is still their request", () => {
  const done: WorkChange = {
    id: "ch_d",
    kind: "done",
    todo: "3",
    subject: "Run the test suite",
    text: "PR #12 merged",
    by: "hoop",
    at: iso(0),
    delivery: "pending",
  };
  const comment: WorkChange = {
    id: "ch_c",
    kind: "comment",
    todo: "1",
    subject: "Write the plan",
    was: "running",
    text: "Use semicolons",
    by: "ankur",
    at: iso(0),
    delivery: "pending",
  };
  const peer = (uuid: string, prompt: string, changes: WorkChange[], ref: string) =>
    `${JSON.stringify({
      type: "user",
      uuid,
      timestamp: iso(1),
      promptId: prompt,
      promptSource: "system",
      origin: { kind: "peer", from: "unknown" },
      isMeta: true,
      message: { role: "user", content: `Another Claude session sent a message:\n${steerMessage(changes)}\n\n(hoop-ref ${ref})` },
    })}\n`;
  const path = join(mkdtempSync(join(tmpdir(), "hoop-done-")), "t.jsonl");
  writeFileSync(path, peer("u1", "P1", [done], "st_done01") + peer("u2", "P2", [comment, done], "st_both01"));
  const scan = transcriptRequests(path)!;
  assert.deepEqual(
    scan.requests.map((r) => [r.id, r.kind, r.ref]),
    [["u2", "change", "st_both01"]],
  );
  assert.equal(scan.turns.get("P1"), null, "todos the agent makes after a done note are its own");
});
