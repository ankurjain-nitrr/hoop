import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Hoop } from "../src/hoop.js";
import { trackPr } from "../src/prs.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { linkTodos, readWork, type TodoLink, workHook, type WorkSession, type WorkTodo } from "../src/work.js";
import { counts, todoState } from "../web/activity.js";
import { BROWSER_SKIP, example, tempHome, withBrowser } from "./helpers.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });

/** A time `m` minutes after 07:00 on 24 Oct. */
const at = (m: number) => Date.parse("2026-10-24T07:00:00.000Z") + m * 60_000;
const iso = (m: number) => new Date(at(m)).toISOString();

const pr = (n: number, state: "open" | "merged" | "closed", more: Partial<TodoLink> = {}): TodoLink =>
  ({ kind: "pr", url: `https://github.com/acme/hoop/pull/${n}`, number: n, state, ...more }) as TodoLink;
const review = (status: string, m: number): TodoLink => ({ kind: "review", id: "rv_plan", title: "The plan", status, at: iso(m) });
const todo = (id: string, since: number, more: Partial<WorkTodo> = {}) =>
  ({ id, text: `Todo ${id}`, status: "running", order: Number(id), updated: iso(since), since: iso(since), ...more }) as WorkTodo;
const busy = (todos: WorkTodo[], more: Record<string, unknown> = {}) => ({
  id: SESSION,
  state: "busy" as const,
  activity: iso(300),
  agents: [],
  todos,
  ...more,
});

test("four todos marked running for hours, each waiting on a merge, read as waiting on you, none running", () => {
  // The Hoop Development session on 24 Oct: Release 0.1.1 since 07:49, and three more since 10:06 and 10:50.
  const todos = [
    todo("1", 49, { text: "Release 0.1.1", links: [pr(189, "open", { ready: true, checks: "green" })] }),
    todo("2", 186, { text: "Action items on Home", links: [pr(205, "open", { ready: true, checks: "green" })] }),
    todo("3", 230, { text: "Quick questions", links: [pr(206, "open", { review_requested: true, checks: "running" })] }),
    todo("4", 230, { text: "Work view clarity", links: [pr(207, "open", { checks: "failing" })] }),
  ];
  const s = busy(todos);
  assert.deepEqual(
    todos.map((t) => todoState(s, t, at(300))!.note),
    [
      "Waiting on you: PR #189 ready for your merge",
      "Waiting on you: PR #205 ready for your merge",
      "Waiting on you: PR #206 needs your review",
      "Waiting on you: PR #207 has failing checks",
    ],
  );
  assert.deepEqual(todoState(s, todos[0]!, at(300))!.link, { href: "https://github.com/acme/hoop/pull/189", text: "PR #189" });
  const c = counts([s] as never[], at(300));
  assert.equal(c.running.length, 0);
  assert.equal(c.waiting.length, 4);
});

test("the rules go in order: waiting on you, in review, done, blocked, then running, stalled and not running", () => {
  const state = (t: WorkTodo, s = busy([t])) => todoState(s, t, at(300));
  // A review waiting on the person comes before an open pull request.
  assert.equal(state(todo("1", 0, { links: [pr(1, "open", { checks: "running" }), review("awaiting_review", 10)] }))!.state, "waiting");
  assert.equal(state(todo("1", 0, { links: [review("awaiting_review", 10)] }))!.since, iso(10), "waiting since the review came");
  assert.deepEqual(state(todo("1", 0, { links: [pr(1, "open", { checks: "running" })] })), {
    state: "inreview",
    note: "In review: PR #1 · checks running",
    since: iso(0),
    link: { href: "https://github.com/acme/hoop/pull/1", text: "PR #1" },
  });
  assert.equal(state(todo("1", 0, { links: [pr(1, "merged")] }))!.note, "Done: PR #1 merged (hoop checked)");
  assert.equal(state(todo("1", 0, { links: [pr(1, "open"), pr(2, "merged")] }))!.state, "inreview", "done only once nothing is open");
  // An approved review the todo submitted is done; an approved plan it started from is not.
  assert.equal(state(todo("1", 0, { links: [review("approved", 20)] }))!.note, "Done: review “The plan” approved (hoop checked)");
  assert.equal(state(todo("1", 30, { links: [review("approved", 20)] }))!.state, "running");
  assert.equal(state(todo("1", 0, { links: [review("changes_requested", 20)] }))!.state, "running", "changes requested wait on the agent");
  // Blocked by a todo not done, queued or running; a done or missing blocker doesn't block.
  const blocker = { ...todo("2", 0), status: "queued" as const };
  const blocked = todo("1", 0, { blocked_by: ["2", "9"] });
  assert.deepEqual(state(blocked, busy([blocked, blocker])), { state: "blocked", note: "Blocked by #2 “Todo 2”", since: iso(0) });
  assert.equal(state({ ...blocked, status: "queued" }, busy([blocked, blocker]))!.state, "blocked");
  assert.equal(state(blocked, busy([blocked, { ...blocker, status: "done" }]))!.state, "running");
  assert.equal(state({ ...blocked, status: "queued" }, busy([blocked, { ...blocker, status: "done" }])), undefined, "queued reads as queued");
});

test("one todo per session reads running: the latest started; a subagent's todo runs too; durations count from the state's start", () => {
  const older = todo("1", 0, { text: "Write the docs" });
  const newer = todo("2", 100, { text: "Open the pull request" });
  const s = busy([older, newer]);
  assert.deepEqual(todoState(s, newer, at(300)), { state: "running", note: "Running: the session works on it", since: iso(100) });
  assert.equal(todoState(s, older, at(300))!.note, "Not running: also marked in progress; the session works on another todo");
  // A running subagent named for the older todo, or started while it was the latest, works on it.
  const named = { id: "a", description: "write the docs", status: "running" as const, started: iso(150), activity: iso(299) };
  assert.equal(todoState({ ...s, agents: [named] }, older, at(300))!.note, "Running: a subagent works on it: write the docs");
  const timed = { id: "b", description: "Research", status: "running" as const, started: iso(50), activity: iso(299) };
  assert.equal(todoState({ ...s, agents: [timed] }, older, at(300))!.state, "running");
  assert.equal(todoState({ ...s, agents: [timed] }, newer, at(300))!.state, "running");
  // A todo explained by its links leaves the running place to the next one.
  const linked = { ...newer, links: [pr(3, "open")] };
  assert.equal(todoState(busy([older, linked]), older, at(300))!.state, "running");
});

test("a description edit leaves when the todo started as it was; blocked-by links come from TaskUpdate and TaskList", () => {
  const home = tempHome();
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Ship it" }, tool_response: { task: { id: "1" } } }), iso(0));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", status: "in_progress" } }), iso(10));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", description: "Now with a PR link" } }), iso(40));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", status: "in_progress", subject: "Ship it now" } }), iso(50));
  let t = readWork(home, SESSION)!.todos[0]!;
  assert.equal(t.updated, iso(50));
  assert.equal(t.since, iso(10), "running since it started, not since its last edit");
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", addBlockedBy: ["7"] } }), iso(60));
  t = readWork(home, SESSION)!.todos[0]!;
  assert.deepEqual(t.blocked_by, ["7"]);
  workHook(home, hook("post-tasklist"), iso(70));
  const list = readWork(home, SESSION)!.todos;
  assert.deepEqual(
    list.map((x) => [x.id, x.blocked_by]),
    [
      ["1", undefined],
      ["3", undefined],
      ["4", ["3"]],
    ],
  );
  assert.equal(list.find((x) => x.id === "3")!.since, iso(70));
});

test("the Work API links a running todo to the reviews and pull requests it names, and to the pull requests its session opened meanwhile", () => {
  const view = [
    {
      id: SESSION,
      todos: [
        todo("1", 0, { description: "PR https://github.com/acme/hoop/pull/5. Plan: http://localhost:4747/r/rv_plan." }),
        todo("2", 100),
        { ...todo("3", 0), status: "queued", description: "Later: https://github.com/acme/hoop/pull/6" },
      ],
    },
  ] as unknown as WorkSession[];
  const states: Record<string, { state: "open" | "merged" | "unknown"; ready?: boolean }> = {
    "https://github.com/acme/hoop/pull/5": { state: "open", ready: true },
    "https://github.com/acme/hoop/pull/7": { state: "merged" },
    "https://github.com/acme/hoop/pull/8": { state: "unknown" },
  };
  const asked: string[] = [];
  linkTodos(view, {
    review: (id) => (id === "rv_plan" ? { title: "The plan", status: "approved", at: iso(-10) } : undefined),
    pr: (url) => (asked.push(url), states[url]),
    tracked: [
      { url: "https://github.com/acme/hoop/pull/7", session: SESSION, added: iso(120) },
      { url: "https://github.com/acme/hoop/pull/8", session: SESSION, added: iso(130) },
      { url: "https://github.com/acme/hoop/pull/9", session: "another", added: iso(130) },
      { url: "https://github.com/acme/hoop/pull/4", session: SESSION, added: iso(-5) },
    ],
  });
  const [one, two, three] = view[0]!.todos;
  assert.deepEqual(one!.links, [
    { kind: "review", id: "rv_plan", title: "The plan", status: "approved", at: iso(-10) },
    { kind: "pr", url: "https://github.com/acme/hoop/pull/5", number: 5, state: "open", ready: true },
  ]);
  assert.deepEqual(one!.reviews, { rv_plan: "The plan" });
  assert.deepEqual(two!.links, [{ kind: "pr", url: "https://github.com/acme/hoop/pull/7", number: 7, state: "merged" }], "an unknown state is no evidence");
  assert.equal(three!.links, undefined, "a queued todo's links aren't read");
  assert.ok(!asked.includes("https://github.com/acme/hoop/pull/6") && !asked.includes("https://github.com/acme/hoop/pull/9"));
});

test("the Work page shows a todo waiting on a merge as Waiting on you, with its pull request, and counts it", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home));
  hoop.submit(example());
  const url = "https://github.com/acme/hoop/pull/189";
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Release 0.1.1" }, tool_response: { task: { id: "1" } } }));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", status: "in_progress" } }));
  trackPr(home, url, SESSION);
  const gh = async (args: string[]) => {
    if (args[0] === "api") return "me\n";
    return JSON.stringify({
      title: "Release 0.1.1",
      state: "OPEN",
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
    });
  };
  const server = createWebServer(hoop, [], { sessions: () => [{ session: SESSION, pid: 1, status: "busy" }], gh });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    // The first read starts reading the pull request; a later one has it.
    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/work`;
    let links: TodoLink[] | undefined;
    for (let n = 0; n < 50 && !links; n++) {
      links = (await (await fetch(api)).json()).sessions[0].todos[0].links;
      if (!links) await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(links, [{ kind: "pr", url, number: 189, state: "open", checks: "green", ready: true }]);
  } finally {
    server.close();
  }
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => ((window as unknown as { HOOP_WORK_MS: number }).HOOP_WORK_MS = 200));
      await page.goto(`${base}/work`);
      const row = page.locator('.todo[data-todo="1"]');
      await row.locator(".why").waitFor();
      assert.match(await row.innerText(), /^Waiting on you\s*Release 0\.1\.1\s*for \d+ s/);
      assert.equal(await row.locator(".why").innerText(), "Waiting on you: PR #189 ready for your merge PR #189");
      assert.equal(await row.locator(".why a").getAttribute("href"), url);
      assert.equal(await row.locator(".state").getAttribute("title"), "Waiting on you: PR #189 ready for your merge");
      assert.equal(await page.locator(".work-counts").innerText(), "0 running · 1 waiting on you · 0 stalled · 0 not running");
    },
    hoop,
    { sessions: () => [{ session: SESSION, pid: 1, status: "busy" }], gh },
  );
});
