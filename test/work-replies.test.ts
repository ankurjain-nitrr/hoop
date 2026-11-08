import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Hoop } from "../src/hoop.js";
import { INSTRUCTIONS } from "../src/mcp.js";
import { OPS } from "../src/ops.js";
import { addChanges, REPLIES_MAX, replyToComment, Steer, steerMessage, workGate } from "../src/steer.js";
import { Store } from "../src/store.js";
import { createWebServer } from "../src/web.js";
import { type ClaudeSession, editWork, readWork, workHook } from "../src/work.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

// Claude answers a person's comment on the Work page with hoop_reply on the comment's ch_ ID.

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const AGENT = "a1b2c3d4e5f607182";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });
const start = (id: string) => hook("pre-taskupdate", { tool_input: { taskId: id, status: "in_progress" } });

/** A session with queued todos #1 and #2, running #3, and a running agent. */
function seeded() {
  const home = tempHome();
  for (const [id, subject] of [
    ["1", "Read the code"],
    ["2", "Write the migration"],
    ["3", "Plan the work"],
  ])
    workHook(home, hook("post-taskcreate", { tool_input: { subject }, tool_response: { task: { id, subject } } }));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "3", status: "in_progress" } }));
  workHook(home, hook("pre-agent"));
  workHook(home, hook("subagent-start"));
  return home;
}

const comment = (home: string, input: Record<string, unknown>, reachable = true) =>
  addChanges(home, SESSION, [{ kind: "comment", ...input }], { by: "ankur", reachable })![0]!;

const as = (home: string, session = SESSION) => new Hoop(new Store(home), { session, claude: true });
const reply = OPS.find((o) => o.name === "reply")!;

test("the message and the gate's notes name a comment's ch_ ID and ask for hoop_reply on it", () => {
  const home = seeded();
  const onTodo = comment(home, { todo: "3", text: "Keep it short" });
  const onAgent = comment(home, { agent: AGENT, text: "Check the docs too" });
  assert.match(onTodo.id, /^ch_/);
  const msg = steerMessage([onTodo, onAgent]);
  assert.ok(
    msg.includes(`- Comment ${onTodo.id} on todo #3 "Plan the work": "Keep it short". Answer it with hoop_reply on ${onTodo.id}, as well as in chat.`),
    msg,
  );
  assert.ok(msg.includes(`Comment ${onAgent.id} on agent "Find API endpoints" (ID ${AGENT})`), msg);
  assert.ok(msg.includes(`hoop_reply on ${onAgent.id}`), msg);

  const gated = seeded();
  const waiting = comment(gated, { todo: "1", text: "Use the fast suite" }, false);
  const toAgent = comment(gated, { agent: AGENT, text: "Skip the vendored code" }, false);
  assert.match(workGate(gated, start("1"))!.deny, new RegExp(`commented on todo #1 in hoop's Work view \\(${waiting.id}\\).*hoop_reply on ${waiting.id}`));
  assert.match(workGate(gated, hook("pre-tool-from-subagent"))!.deny, new RegExp(`\\(${toAgent.id}\\).*hoop_reply on ${toAgent.id}`));
  assert.match(INSTRUCTIONS, /comment on a todo or agent in hoop's Work view names its ID \(ch_…\)\. Answer it with hoop_reply on that ID/);
});

test("hoop_reply stores the reply on the comment, settles it as seen, and /api/work returns it", async () => {
  const home = seeded();
  const c = comment(home, { todo: "3", text: "Keep it short" });
  const out = (await reply.run(as(home), { thread: c.id, body: "  Kept it to one page.  " }, { actor: "claude" })) as Record<string, unknown>;
  assert.equal(out.thread, c.id);
  assert.equal(out.body, "Kept it to one page.");
  const saved = readWork(home, SESSION)!.changes!.find((x) => x.id === c.id)!;
  assert.equal(saved.delivery, "seen");
  assert.equal(saved.replies!.length, 1);
  assert.deepEqual(Object.keys(saved.replies![0]!).sort(), ["at", "body", "by"]);
  assert.equal(saved.replies![0]!.body, "Kept it to one page.");
  // The conversation goes on while the todo runs: a second reply joins the first.
  await reply.run(as(home), { thread: c.id, body: "And trimmed the intro." }, { actor: "claude" });
  assert.equal(readWork(home, SESSION)!.changes!.find((x) => x.id === c.id)!.replies!.length, 2);

  const server = createWebServer(new Hoop(new Store(home)), [], { sessions: () => [{ session: SESSION, pid: 1, status: "busy" }] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/work`)).json();
    const got = body.sessions.find((s: { id: string }) => s.id === SESSION).changes.find((x: { id: string }) => x.id === c.id);
    assert.deepEqual(
      got.replies.map((r: { body: string }) => r.body),
      ["Kept it to one page.", "And trimmed the intro."],
    );
    assert.equal(got.delivery, "seen");
  } finally {
    server.close();
  }
});

test("a reply is refused from another session, to a change that isn't a comment or an add, with no text, and once its todo is done", () => {
  const home = seeded();
  const c = comment(home, { todo: "1", text: "Mind the old rows" });
  const [removal] = addChanges(home, SESSION, [{ kind: "remove", todo: "2" }], { by: "ankur", reachable: true })!;
  const onAgent = comment(home, { agent: AGENT, text: "Check the docs" });
  assert.throws(() => as(home, "99999999-0000-0000-0000-000000000000").reply(c.id, "Done"), /in another session's work: only the session it was made in/);
  assert.throws(() => as(home).reply(removal!.id, "Done"), /is a remove: only a comment or an added todo takes a reply/);
  assert.throws(() => as(home).reply(c.id, "   "), /a reply needs text/);
  assert.throws(() => as(home).reply("ch_nothing", "Done"), /no comment ch_nothing in this session's work/);
  assert.throws(() => new Hoop(new Store(home), null).reply(c.id, "Done"), /session/);
  // Comments close with their todo: a done one keeps its replies, read only.
  as(home).reply(c.id, "On it");
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", status: "completed" } }));
  assert.throws(() => as(home).reply(c.id, "Finished"), /todo #1 is done, so its comments are closed: answer in chat instead/);
  const r = readWork(home, SESSION)!;
  assert.deepEqual(
    r.changes!.find((x) => x.id === c.id)!.replies!.map((x) => x.body),
    ["On it"],
  );
  assert.equal(r.changes!.find((x) => x.id === onAgent.id)!.replies, undefined);
  assert.equal(r.changes!.find((x) => x.id === removal!.id)!.replies, undefined);
});

test("regression: the session that owns a finished agent still replies to a comment on it; another session can't", () => {
  const home = seeded();
  const onAgent = comment(home, { agent: AGENT, text: "331 and 325: why are they in draft?" });
  workHook(home, hook("subagent-stop"));
  assert.notEqual(readWork(home, SESSION)!.agents.find((a) => a.id === AGENT)!.status, "running");
  assert.throws(() => as(home, "99999999-0000-0000-0000-000000000000").reply(onAgent.id, "Draft until reviewed"), /another session's work/);
  as(home).reply(onAgent.id, "Draft until the review is done.");
  const saved = readWork(home, SESSION)!.changes!.find((x) => x.id === onAgent.id)!;
  assert.deepEqual(
    saved.replies!.map((x) => x.body),
    ["Draft until the review is done."],
  );
  assert.equal(saved.delivery, "seen");
});

/** Adds a todo from the Work page, as the person; with `reachable` false it waits for the gate. */
const added = (home: string, text: string, reachable = true) => addChanges(home, SESSION, [{ kind: "add", text }], { by: "ankur", reachable })![0]!;
const create = (home: string, id: string, subject: string) =>
  workHook(home, hook("post-taskcreate", { tool_input: { subject }, tool_response: { task: { id, subject } } }));

test("an added todo's message and the gate's note name its ch_ ID and ask for hoop_reply on it", () => {
  const home = seeded();
  const add = added(home, "Is there a need to publish for several Node versions?");
  assert.match(add.id, /^ch_/);
  const msg = steerMessage([add]);
  assert.ok(msg.includes(`If it asks something, answer it with hoop_reply on ${add.id}, as well as in chat, before you mark it completed`), msg);
  const gated = seeded();
  const waiting = added(gated, "Do we need a changelog entry?", false);
  assert.match(workGate(gated, start("1"))!.deny, new RegExp(`Do we need a changelog entry\\?.*hoop_reply on ${waiting.id}`));
});

test("regression: Claude replies to a todo the person added, under it, until the todo is done; after that it is read only", () => {
  const home = seeded();
  const question = "Is there a need to publish for several Node versions?";
  const add = added(home, question);
  // Not yet created, or created but its hook hasn't landed: the reply waits until hoop sees the todo,
  // so it shows under it, and the refusal doesn't claim Claude didn't create it.
  assert.throws(
    () => as(home).reply(add.id, "No"),
    /hoop hasn't seen the todo "Is there a need.*" created yet: if you just created it, reply again in a moment; otherwise create it with TaskCreate first/,
  );
  create(home, "4", question);
  assert.equal(readWork(home, SESSION)!.changes!.find((x) => x.id === add.id)!.todo, "4");
  as(home).reply(add.id, "No: one package runs on Node 22 and later.");
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "4", status: "completed" } }));
  assert.throws(() => as(home).reply(add.id, "Also…"), /todo #4 is done, so its replies are closed: answer in chat instead/);
  assert.throws(() => as(home, "99999999-0000-0000-0000-000000000000").reply(add.id, "No"), /another session's work/);
  assert.deepEqual(
    readWork(home, SESSION)!
      .changes!.find((x) => x.id === add.id)!
      .replies!.map((x) => x.body),
    ["No: one package runs on Node 22 and later."],
  );
  // A withdrawn add takes no reply.
  const gone = added(home, "Rename the flag?");
  addChanges(home, SESSION, [{ kind: "withdraw", of: gone.id }], { by: "ankur", reachable: true });
  assert.throws(() => as(home).reply(gone.id, "Yes"), /was withdrawn, so it takes no replies/);
});

test("the Work page shows Claude's reply under an added todo, and still shows it once the todo is done", { skip: BROWSER_SKIP }, async () => {
  const home = seeded();
  const question = "Is there a need to publish for several Node versions?";
  const add = added(home, question);
  create(home, "4", question);
  as(home).reply(add.id, "No: one package runs on Node 22 and later.");
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/work`);
      const note = page.locator('section.work-session .todo[data-todo="4"] .note', { hasText: "added it" });
      await note.waitFor();
      assert.deepEqual(await note.locator(".reply .said").allTextContents(), ["No: one package runs on Node 22 and later."]);
      assert.match((await note.locator(":scope > .delivery").textContent()) ?? "", /^Answered by Claude \d/);
      workHook(home, hook("post-taskupdate", { tool_input: { taskId: "4", status: "completed" } }));
      await page.reload();
      const done = page.locator(".item-fold.done");
      await done.locator(":scope > .fold-btn").click();
      const after = done.locator('.todo[data-todo="4"] .note', { hasText: "added it" });
      await after.waitFor();
      assert.deepEqual(await after.locator(".reply .said").allTextContents(), ["No: one package runs on Node 22 and later."]);
    },
    new Hoop(new Store(home)),
    { sessions: () => [{ session: SESSION, pid: 1, status: "busy", cwd: "/tmp/proj" }] },
  );
});

test("after /clear, the session running in a comment's or added todo's process replies to it; another process can't", () => {
  const home = seeded();
  const live: ClaudeSession[] = [{ session: SESSION, pid: 4242, start: "2026-10-26T10:00:00.000Z", socket: "/fake" }];
  // The Work page's comment keeps the process its session runs in.
  new Steer(home, () => live, { send: async () => {} }).record(SESSION, [{ kind: "comment", todo: "3", text: "Keep it short" }], "ankur");
  const c = readWork(home, SESSION)!.changes!.at(-1)!;
  assert.deepEqual(c.process, { pid: 4242, start: "2026-10-26T10:00:00.000Z" });
  const NEW = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const cleared = () => [{ ...live[0]!, session: NEW }];
  const out = replyToComment(home, NEW, c.id, "Shortened it", { by: "claude", sessions: cleared });
  assert.equal(out.session, SESSION);
  assert.equal(readWork(home, SESSION)!.changes!.at(-1)!.replies![0]!.body, "Shortened it");
  const elsewhere = () => [{ ...live[0]!, session: NEW, pid: 5151 }];
  assert.throws(() => replyToComment(home, NEW, c.id, "Again", { by: "claude", sessions: elsewhere }), /another session's work/);
  // A comment made without a process (a session that takes no messages) answers only to its own session.
  editWork(home, SESSION, (r) => void delete r.changes!.at(-1)!.process);
  assert.throws(() => replyToComment(home, NEW, c.id, "Again", { by: "claude", sessions: cleared }), /another session's work/);

  // An added todo keeps the process too: once created, the successor in that process replies under it.
  new Steer(home, () => live, { send: async () => {} }).record(SESSION, [{ kind: "add", text: "Do we need a changelog entry?" }], "ankur");
  const add = readWork(home, SESSION)!.changes!.at(-1)!;
  assert.deepEqual([add.kind, add.process], ["add", { pid: 4242, start: "2026-10-26T10:00:00.000Z" }]);
  create(home, "4", "Do we need a changelog entry?");
  assert.throws(() => replyToComment(home, NEW, add.id, "Yes", { by: "claude", sessions: elsewhere }), /another session's work/);
  assert.equal(replyToComment(home, NEW, add.id, "Yes, under Changed.", { by: "claude", sessions: cleared }).session, SESSION);
  assert.deepEqual(
    readWork(home, SESSION)!
      .changes!.find((x) => x.id === add.id)!
      .replies!.map((r) => r.body),
    ["Yes, under Changed."],
  );
});

test("regression: a reply to an added todo whose todo is in the record but not yet matched to it finds the todo", () => {
  const home = seeded();
  const add = added(home, "Rename the flag?");
  create(home, "4", "Rename the flag?");
  // As before hoop matched them: the add still open, without its todo.
  editWork(home, SESSION, (r) => {
    const c = r.changes!.find((x) => x.id === add.id)!;
    delete c.todo;
    c.delivery = "sent";
  });
  as(home).reply(add.id, "Yes: --out.");
  const saved = readWork(home, SESSION)!.changes!.find((x) => x.id === add.id)!;
  assert.deepEqual([saved.todo, saved.delivery, saved.replies!.map((r) => r.body)], ["4", "seen", ["Yes: --out."]]);
});

test("the Work page shows the agent's reply under the comment and in History, marked Answered by Claude", { skip: BROWSER_SKIP }, async () => {
  const home = seeded();
  const c = comment(home, { todo: "3", text: "Keep it short" });
  as(home).reply(c.id, "Kept it to one page.");
  // A reply is text on the page, never markup.
  as(home).reply(c.id, '<img src=x onerror="window.__hacked=1">');
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/work`);
      const todo = page.locator('section.work-session .todo[data-todo="3"]');
      const note = todo.locator(".note.person", { hasText: "Keep it short" });
      await note.waitFor();
      assert.deepEqual(await note.locator(".reply .said").allInnerTexts(), ["Kept it to one page.", '<img src=x onerror="window.__hacked=1">']);
      assert.equal(await note.locator("img").count(), 0, "a reply's HTML renders as text");
      assert.equal(await page.evaluate(() => (window as unknown as { __hacked?: number }).__hacked), undefined);
      assert.match(await note.locator(":scope > .delivery").innerText(), /^Answered by Claude \d/);
      const history = page.locator(".history");
      await history.locator(":scope > .fold-btn").click();
      const entry = history.locator(".note.person", { hasText: "Keep it short" });
      assert.equal(await entry.locator(".reply .said").first().innerText(), "Kept it to one page.");
      assert.equal(await entry.locator("img").count(), 0);
      assert.match(await entry.locator(":scope > .delivery").innerText(), /Answered by Claude/);
    },
    new Hoop(new Store(home)),
    { sessions: () => [{ session: SESSION, pid: 1, status: "busy", cwd: "/tmp/proj" }] },
  );
});

test("a comment keeps only its newest replies", () => {
  const home = seeded();
  const c = comment(home, { todo: "3", text: "Keep it short" });
  for (let i = 1; i <= REPLIES_MAX + 3; i++) as(home).reply(c.id, `Reply ${i}`);
  const replies = readWork(home, SESSION)!.changes!.find((x) => x.id === c.id)!.replies!;
  assert.equal(replies.length, REPLIES_MAX);
  assert.equal(replies[0]!.body, "Reply 4");
  assert.equal(replies.at(-1)!.body, `Reply ${REPLIES_MAX + 3}`);
});

test("regression: a comment closes when its TodoWrite place holds another todo, but stays open across the person's edit", () => {
  const home = tempHome();
  const list = (todos: [string, string][]) =>
    workHook(home, hook("post-todowrite", { tool_input: { todos: todos.map(([content, status]) => ({ content, status, activeForm: content })) } }));
  list([
    ["Read the code", "in_progress"],
    ["Write the migration", "pending"],
  ]);
  const c = comment(home, { todo: "2", text: "Mind the old rows" });
  // The person edits #2; a reply still reaches it once the agent takes the new text.
  addChanges(home, SESSION, [{ kind: "edit", todo: "2", text: "Write the migration and a rollback" }], { by: "ankur", reachable: true });
  list([
    ["Read the code", "in_progress"],
    ["Write the migration and a rollback", "pending"],
  ]);
  as(home).reply(c.id, "Adding the rollback too");
  // Place 2 now holds another queued todo: the comment's conversation is over.
  list([
    ["Read the code", "in_progress"],
    ["Update the docs", "pending"],
  ]);
  assert.equal(readWork(home, SESSION)!.todos.find((t) => t.id === "2")!.status, "queued");
  assert.throws(() => as(home).reply(c.id, "Done"), /todo #2 is gone, so its comments are closed/);
  assert.deepEqual(
    readWork(home, SESSION)!
      .changes!.find((x) => x.id === c.id)!
      .replies!.map((r) => r.body),
    ["Adding the rollback too"],
  );
});
