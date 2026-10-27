import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Hoop } from "../src/hoop.js";
import { prState, trackPr } from "../src/prs.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { type ClaudeSession, linkTodos, readWork, type TodoLink, workHook, type WorkSession, type WorkTodo } from "../src/work.js";
import { counts, prWords, todoState } from "../web/activity.js";
import { BROWSER_SKIP, example, hasFocus, tempHome, withBrowser } from "./helpers.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });

/** A time `m` minutes after 07:00 on 24 Oct. */
const at = (m: number) => Date.parse("2026-10-24T07:00:00.000Z") + m * 60_000;
const iso = (m: number) => new Date(at(m)).toISOString();
const PR = (n: number) => `https://github.com/acme/hoop/pull/${n}`;

const pr = (n: number, state: "open" | "merged" | "unknown", more: Record<string, unknown> = {}): TodoLink =>
  ({ kind: "pr", url: PR(n), number: n, state, ...more }) as TodoLink;
const review = (status: string, m: number, approved?: number): TodoLink => ({
  kind: "review",
  id: "rv_plan",
  title: "The plan",
  status,
  at: iso(m),
  ...(approved !== undefined ? { approved_at: iso(approved) } : {}),
});
const todo = (id: string, since: number, more: Partial<WorkTodo> = {}) =>
  ({ id, text: `Todo ${id}`, status: "running", order: Number(id), updated: iso(since), since: iso(since), ...more }) as WorkTodo;
const busy = (todos: WorkTodo[], more: Record<string, unknown> = {}) => ({
  id: SESSION,
  state: "busy" as const,
  activity: iso(300),
  agents: [] as never[],
  todos,
  ...more,
});

test("four todos marked running for hours, each waiting on a merge, read as waiting on you, none running", () => {
  // The Hoop Development session on 24 Oct: Release 0.1.1 since 07:49, and three more since 10:06 and 10:50.
  const ready = { ready: true, checks: "green" };
  const todos = [
    todo("1", 49, { text: "Release 0.1.1", links: [pr(189, "open", { ...ready, opened_at: iso(60) })] }),
    todo("2", 186, { text: "Action items on Home", links: [pr(205, "open", ready)] }),
    todo("3", 230, { text: "Quick questions", links: [pr(206, "open", { review_requested: true, checks: "running" })] }),
    todo("4", 230, { text: "Work view clarity", links: [pr(207, "open", ready)] }),
  ];
  const s = busy(todos);
  assert.deepEqual(
    todos.map((t) => todoState(s, t, at(300))!.note),
    [
      "Waiting on you: PR #189 ready for your merge",
      "Waiting on you: PR #205 ready for your merge",
      "Waiting on you: PR #206 needs your review",
      "Waiting on you: PR #207 ready for your merge",
    ],
  );
  assert.deepEqual(todoState(s, todos[0]!, at(300))!.link, { href: PR(189), text: "PR #189" });
  assert.equal(todoState(s, todos[0]!, at(300))!.since, iso(60), "waiting since the pull request opened");
  assert.equal(todoState(s, todos[1]!, at(300))!.since, iso(186), "else since the todo started");
  const c = counts([s] as never[], at(300));
  assert.equal(c.running.length, 0);
  assert.equal(c.waiting.length, 4);
});

test("the rules go in order: waiting on you, in review, done, blocked, then running, stalled and not running", () => {
  const state = (t: WorkTodo, s = busy([t])) => todoState(s, t, at(300));
  // A review waiting on the person comes before an open pull request.
  assert.equal(state(todo("1", 0, { links: [pr(1, "open", { checks: "running" }), review("awaiting_review", 10)] }))!.state, "waiting");
  assert.equal(state(todo("1", 0, { links: [review("awaiting_review", 10)] }))!.since, iso(10), "waiting since the review came");
  assert.deepEqual(state(todo("1", 0, { links: [pr(1, "open", { checks: "running", opened_at: iso(5) })] })), {
    state: "inreview",
    note: "In review: PR #1 · checks running",
    since: iso(5),
    link: { href: PR(1), text: "PR #1" },
  });
  // A draft, or failing checks, waits on the agent: in review, never ready for the person's merge.
  assert.equal(
    state(todo("1", 0, { links: [pr(1, "open", { draft: true, ready: true, checks: "green" })] }))!.note,
    "In review: PR #1 · draft · checks passed",
  );
  assert.equal(state(todo("1", 0, { links: [pr(1, "open", { checks: "failing" })] }))!.note, "In review: PR #1 · checks failing");
  assert.equal(state(todo("1", 0, { links: [pr(1, "merged", { merged_at: iso(100) })] }))!.note, "Done: PR #1 merged (hoop checked)");
  assert.equal(state(todo("1", 0, { links: [pr(1, "open"), pr(2, "merged", { merged_at: iso(100) })] }))!.state, "inreview", "done only once nothing is open");
  // A pull request merged before the todo started is what it builds on, not its outcome.
  assert.equal(state(todo("1", 200, { links: [pr(207, "merged", { merged_at: iso(100) })] }))!.state, "running");
  assert.equal(state(todo("1", 0, { links: [pr(1, "merged")] }))!.state, "running", "a merge with no time is no outcome");
  // A pull request not read yet keeps the todo from reading done.
  assert.equal(state(todo("1", 0, { links: [pr(1, "unknown"), review("approved", 20, 20)] }))!.state, "running");
  // An approved review counts once it was approved after the todo started; an approved plan it started from doesn't.
  assert.equal(state(todo("1", 0, { links: [review("approved", 20, 20)] }))!.note, "Done: review “The plan” approved (hoop checked)");
  assert.equal(state(todo("1", 30, { links: [review("approved", 20, 20)] }))!.state, "running");
  assert.equal(state(todo("1", 30, { started: iso(0), links: [review("approved", 20, 20)] }))!.state, "done", "from its first start");
  assert.equal(state(todo("1", 0, { links: [review("changes_requested", 20)] }))!.state, "running", "changes requested wait on the agent");
  // Blocked by a todo not done, queued or running; a done or missing blocker doesn't block.
  const blocker = { ...todo("2", 0), status: "queued" as const };
  const blocked = todo("1", 0, { blocked_by: ["2", "9"] });
  assert.deepEqual(state(blocked, busy([blocked, blocker])), { state: "blocked", note: "Blocked by #2 “Todo 2”", since: iso(0) });
  assert.equal(state({ ...blocked, status: "queued" }, busy([blocked, blocker]))!.state, "blocked");
  assert.equal(state(blocked, busy([blocked, { ...blocker, status: "done" }]))!.state, "running");
  assert.equal(state({ ...blocked, status: "queued" }, busy([blocked, { ...blocker, status: "done" }])), undefined, "queued reads as queued");
});

test("one todo per session reads running: the latest started; a subagent's todo runs too, and counts once", () => {
  const older = todo("1", 0, { text: "Write the docs page" });
  const newer = todo("2", 100, { text: "Open the pull request" });
  const s = busy([older, newer]);
  assert.deepEqual(todoState(s, newer, at(300)), { state: "running", note: "Running: the session works on it", since: iso(100) });
  assert.equal(todoState(s, older, at(300))!.note, "Not running: also marked in progress; the session works on another todo");
  // A running subagent whose description holds the older todo's whole subject works on it.
  const named = { id: "a", description: "Write the docs page, then lint", status: "running" as const, started: iso(150), activity: iso(299) };
  assert.equal(todoState({ ...s, agents: [named] } as never, older, at(300))!.note, "Running: a subagent works on it: Write the docs page, then lint");
  // Not on part of a word, the other way round, or a subject too short to tell.
  for (const description of ["Rewrite the docs pages", "docs"]) {
    const other = { ...named, description };
    assert.equal(todoState({ ...s, agents: [other] } as never, older, at(300))!.state, "notrunning", description);
  }
  const short = todo("1", 0, { text: "Run tests" });
  assert.equal(todoState({ ...busy([short, newer]), agents: [{ ...named, description: "Run tests in CI" }] } as never, short, at(300))!.state, "notrunning");
  // One started while the older todo was the latest works on it.
  const timed = { id: "b", description: "Research", status: "running" as const, started: iso(50), activity: iso(299) };
  const withAgent = { ...s, agents: [timed] } as never;
  assert.equal(todoState(withAgent, older, at(300))!.agent, "b");
  assert.deepEqual(counts([withAgent], at(300)).running, [
    { session: SESSION, kind: "todo", id: "1" },
    { session: SESSION, kind: "todo", id: "2" },
  ]);
  // A todo explained by its links leaves the running place to the next one.
  const linked = { ...newer, links: [pr(3, "open")] };
  assert.equal(todoState(busy([older, linked]), older, at(300))!.state, "running");
});

test("an ended session's work leaves every count an hour after its last activity", () => {
  const t = todo("1", 0, { links: [pr(1, "open", { ready: true })] });
  const ended = (m: number) => ({ ...busy([t]), state: "ended" as const, activity: iso(m) });
  assert.equal(counts([ended(0)] as never[], at(30)).waiting.length, 1);
  assert.deepEqual(counts([ended(0)] as never[], at(61)), { running: [], waiting: [], stalled: [], notrunning: [] });
});

test("the hook record keeps when each todo started and its blocked-by links from TaskUpdate and TaskList", () => {
  const home = tempHome();
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Ship it" }, tool_response: { task: { id: "1" } } }), iso(0));
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Announce it" }, tool_response: { task: { id: "2" } } }), iso(0));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", status: "in_progress" } }), iso(10));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", description: "Now with a PR link" } }), iso(40));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", status: "in_progress", subject: "Ship it now" } }), iso(50));
  let t = readWork(home, SESSION)!.todos[0]!;
  assert.equal(t.updated, iso(50));
  assert.equal(t.since, iso(10), "running since it started, not since its last edit");
  assert.equal(t.started, iso(10));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", status: "completed", addBlockedBy: ["7"], addBlocks: ["2"] } }), iso(60));
  t = readWork(home, SESSION)!.todos[0]!;
  assert.deepEqual([t.status, t.since, t.started, t.blocked_by], ["done", iso(60), iso(10), ["7"]], "its start stays once it is done");
  assert.deepEqual(readWork(home, SESSION)!.todos[1]!.blocked_by, ["1"], "addBlocks marks the other todo");
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

test("the Work API links a running todo to the reviews and open pull requests it names, and puts what its session opened beside two running todos under the session", () => {
  const view = [
    {
      id: SESSION,
      state: "busy",
      updated: iso(0),
      todos: [
        todo("1", 0, { description: `PR ${PR(5)}. Builds on ${PR(207)}. Plan: http://localhost:4747/r/rv_plan. Also ${PR(10)}.` }),
        todo("2", 100),
        { ...todo("3", 0), status: "queued", description: `Later: ${PR(6)}` },
        // Started after todo 2, then finished: what it opened isn't todo 2's.
        { ...todo("4", 140), status: "done", started: iso(140) },
      ],
    },
  ] as unknown as WorkSession[];
  const states: Record<string, { state: "open" | "merged" | "unknown"; ready?: boolean; merged_at?: string }> = {
    [PR(5)]: { state: "open", ready: true },
    [PR(207)]: { state: "merged", merged_at: iso(-60) },
    [PR(7)]: { state: "merged", merged_at: iso(130) },
    [PR(8)]: { state: "unknown" },
  };
  const asked: string[] = [];
  linkTodos(
    view,
    {
      review: (id) => (id === "rv_plan" ? { title: "The plan", status: "approved", at: iso(-10), approved_at: iso(-5) } : undefined),
      pr: (url) => (asked.push(url), states[url]),
      tracked: [
        { url: PR(7), session: SESSION, added: iso(120) },
        { url: PR(8), session: SESSION, added: iso(130) },
        { url: PR(11), session: SESSION, added: iso(150) },
        { url: PR(9), session: "another", added: iso(130) },
      ],
    },
    at(300),
  );
  const [one, two, three] = view[0]!.todos;
  assert.deepEqual(
    one!.links,
    [
      { kind: "review", id: "rv_plan", title: "The plan", status: "approved", at: iso(-10), approved_at: iso(-5) },
      { kind: "pr", url: PR(5), number: 5, state: "open", ready: true },
      { kind: "pr", url: PR(10), number: 10, state: "unknown" },
    ],
    "a merged pull request it names is context; one not read yet is kept",
  );
  assert.deepEqual(one!.reviews, { rv_plan: "The plan" });
  // Todos 1 and 2 both ran when the session opened 7, 8 and 11, and neither names them: the session's.
  assert.equal(two!.links, undefined);
  assert.deepEqual(view[0]!.prs, [
    { kind: "pr", url: PR(8), number: 8, state: "unknown", opened: true },
    { kind: "pr", url: PR(11), number: 11, state: "unknown", opened: true },
  ]);
  assert.equal(three!.links, undefined, "a queued todo's links aren't read");
  assert.ok(![PR(6), PR(9)].some((u) => asked.includes(u)));
  // An ended session's pull requests aren't read an hour after its last activity.
  asked.length = 0;
  const ended = [{ id: SESSION, state: "ended", updated: iso(0), activity: iso(0), todos: [todo("1", 0, { description: PR(5) })] }] as unknown as WorkSession[];
  linkTodos(ended, { review: () => undefined, pr: (u) => (asked.push(u), undefined), tracked: [] }, at(61));
  assert.deepEqual(asked, []);
});

test("#299: each tracked pull request goes to the running todo that names it, whichever started last, and one no todo names to the session", () => {
  const view = [
    {
      id: SESSION,
      state: "busy",
      updated: iso(0),
      todos: [
        todo("1", 0, { text: "Fix the linking (#21)" }),
        todo("2", 10, { description: "Build the gate on branch feat/done-gate" }),
        todo("3", 20, { description: `Builds on #21; ships ${PR(23)}` }),
      ],
    },
  ] as unknown as WorkSession[];
  const states: Record<string, { state: "open"; branch?: string }> = {
    [PR(21)]: { state: "open" },
    [PR(22)]: { state: "open", branch: "feat/done-gate" },
    [PR(23)]: { state: "open" },
    [PR(24)]: { state: "open", branch: "main" },
  };
  linkTodos(
    view,
    {
      review: () => undefined,
      pr: (url) => states[url],
      // All opened after todo 3, the latest started.
      tracked: [21, 22, 23, 24].map((n) => ({ url: PR(n), session: SESSION, added: iso(30 + n) })),
    },
    at(100),
  );
  const [one, two, three] = view[0]!.todos;
  const urls = (t: WorkTodo | undefined) => t?.links?.map((l) => (l.kind === "pr" ? l.url : l.id));
  assert.deepEqual(urls(one), [PR(21)], "named by #N in its subject; todo 3's description names it too, as context");
  assert.deepEqual(urls(two), [PR(22)], "named by its branch");
  assert.deepEqual(urls(three), [PR(23)], "named by its URL");
  assert.deepEqual(
    view[0]!.prs?.map((l) => l.kind === "pr" && l.url),
    [PR(24)],
    "no todo names it, so it goes to the session",
  );
  // With one todo running when the session opened it, that todo has it.
  const alone = [{ id: SESSION, state: "busy", updated: iso(0), todos: [todo("1", 0)] }] as unknown as WorkSession[];
  linkTodos(alone, { review: () => undefined, pr: (url) => states[url], tracked: [{ url: PR(24), session: SESSION, added: iso(5) }] }, at(10));
  assert.deepEqual(urls(alone[0]!.todos[0]), [PR(24)]);
  assert.equal(alone[0]!.prs, undefined);
});

test("review: a todo started after the session opened a pull request never takes it, and a URL names only its own number", () => {
  const view = [
    {
      id: SESSION,
      state: "busy",
      updated: iso(0),
      todos: [
        todo("1", 0, { text: "Implement the gate" }),
        // Started after #21 opened, while todo 1 ran alone: "Builds on" is context.
        todo("2", 10, { description: "Builds on #21" }),
        todo("3", 0, { status: "queued", description: `Fix CI on ${PR(31)}` }),
      ],
    },
  ] as unknown as WorkSession[];
  linkTodos(
    view,
    {
      review: () => undefined,
      pr: () => ({ state: "open" }),
      tracked: [
        { url: PR(21), session: SESSION, added: iso(5) },
        { url: PR(3), session: SESSION, added: iso(5) },
      ],
    },
    at(20),
  );
  const [one, two] = view[0]!.todos;
  assert.deepEqual(
    one!.links?.map((l) => l.kind === "pr" && l.url),
    [PR(21), PR(3)],
    "todo 1 ran alone when both opened",
  );
  assert.equal(two!.links, undefined);
  assert.equal(view[0]!.prs, undefined);
});

test("review: a session's pull request says what it needs from the person and its checks, as a todo's link does", () => {
  assert.equal(prWords({ state: "open", ready: true, checks: "green" }), "open · ready for your merge · checks passed");
  assert.equal(prWords({ state: "open", review_requested: true, checks: "running" }), "open · needs your review · checks running");
  assert.equal(prWords({ state: "open", draft: true, checks: "failing" }), "draft · checks failing");
  assert.equal(prWords({ state: "unknown" }), "not read yet");
});

test("a draft is never ready to merge, and gh's opened and merged times are kept", () => {
  const open = prState({ state: "OPEN", mergeable: "MERGEABLE", isDraft: true, createdAt: iso(1), statusCheckRollup: [] });
  assert.deepEqual([open.ready, open.draft, open.opened_at], [false, true, iso(1)]);
  assert.equal(prState({ state: "MERGED", mergedAt: iso(9) }).merged_at, iso(9));
});

test("an approved plan read through the store counts from its approval, and a later reply doesn't make it the todo's outcome", async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home), SESSION);
  const plan = hoop.submit(example()).review_id;
  const thread = hoop.review(plan, { verdict: "comment", comments: [{ item: example().items[0].id, line: 1, body: "One more thing" }] }).comments[0]!.thread!;
  hoop.review(plan, { verdict: "approved", resolved_threads: [thread] });
  const approvedAt = hoop.store.meta(plan).approved_at!;
  const revisionAt = hoop.store.revisionAt(plan)!;
  await new Promise((r) => setTimeout(r, 20));
  const started = new Date().toISOString();
  workHook(
    home,
    hook("post-taskcreate", { tool_input: { subject: "Build it", description: `From http://localhost:4747/r/${plan}` }, tool_response: { task: { id: "1" } } }),
  );
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", status: "in_progress" } }), started);
  await new Promise((r) => setTimeout(r, 20));
  // The agent replies on the plan after the todo started, which moves the review's updated time.
  hoop.reply(thread, "Noted");
  assert.ok(hoop.store.meta(plan).updated > started);
  const server = createWebServer(hoop, [], { sessions: () => [{ session: SESSION, pid: 1, status: "busy" }] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const s = (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/work`)).json()).sessions[0];
    const t = s.todos[0];
    assert.deepEqual(t.links, [{ kind: "review", id: plan, title: example().title, status: "approved", at: revisionAt, approved_at: approvedAt }]);
    assert.equal(todoState(s, t, Date.now())!.state, "running", "the plan it started from isn't its outcome");
  } finally {
    server.close();
  }
});

test("the Work page shows a todo waiting on a merge as Waiting on you, with its pull request, and the counts keep focus by state", {
  skip: BROWSER_SKIP,
}, async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home));
  hoop.submit(example());
  const url = PR(189);
  const OTHER = "22222222-3333-4444-5555-666666666666";
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Release 0.1.1" }, tool_response: { task: { id: "1" } } }));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", status: "in_progress" } }));
  trackPr(home, url, SESSION);
  workHook(home, hook("post-taskcreate", { session_id: OTHER, tool_input: { subject: "Proofread" }, tool_response: { task: { id: "1" } } }));
  workHook(home, hook("post-taskupdate", { session_id: OTHER, tool_input: { taskId: "1", status: "in_progress" } }));
  // A pull request the other session opened before its todo ran, which no todo names: the session's.
  trackPr(home, PR(190), OTHER);
  const prs = JSON.parse(readFileSync(join(home, "prs.json"), "utf8"));
  prs.prs.find((p: { url: string }) => p.url === PR(190)).added = iso(-60);
  writeFileSync(join(home, "prs.json"), JSON.stringify(prs));
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
  const live: ClaudeSession[] = [
    { session: SESSION, pid: 1, status: "busy" },
    { session: OTHER, pid: 2, status: "busy" },
  ];
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => ((window as unknown as { HOOP_WORK_MS: number }).HOOP_WORK_MS = 200));
      await page.goto(`${base}/work`);
      const row = page.locator(`#todo-${SESSION}-1`);
      await row.locator(".why").waitFor();
      assert.match(await row.innerText(), /^Waiting on you\s*Release 0\.1\.1\s*for \d+ s/);
      assert.equal(await row.locator(".why").innerText(), "Waiting on you: PR #189 ready for your merge PR #189");
      assert.equal(await row.locator(".why a").getAttribute("href"), url);
      assert.equal(await row.locator(".state").getAttribute("title"), "Waiting on you: PR #189 ready for your merge");
      const other = page.locator(".work-session", { hasText: "Proofread" });
      assert.match(await other.locator(".up-next").last().innerText(), /^Pull requests no todo names: PR #190 open · ready for your merge · checks passed$/);
      assert.equal(await page.locator(".work-session", { hasText: "Release 0.1.1" }).getByText("Pull requests no todo names").count(), 0);
      const counts = page.locator(".work-counts");
      assert.equal(await counts.innerText(), "1 running · 1 waiting on you · 0 stalled · 0 not running");
      // The waiting link keeps the focus when the running count before it goes away.
      await counts.locator('[data-count="waiting"]').focus();
      live[1] = { ...live[1]!, status: "idle" };
      await page.waitForFunction(() => /0 running/.test(document.querySelector(".work-counts")?.textContent ?? ""));
      assert.equal(await counts.innerText(), "0 running · 1 waiting on you · 0 stalled · 1 not running");
      assert.equal(await hasFocus(counts.locator('[data-count="waiting"]')), true);
    },
    hoop,
    { sessions: () => live, gh },
  );
});
