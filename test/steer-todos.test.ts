import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { ADD_GRACE_MS, addChanges, changeLine, Steer, workGate } from "../src/steer.js";
import { Store } from "../src/store.js";
import { readWork, type WorkChange, workHook, workQueue, workView } from "../src/work.js";
import { upNext } from "../web/activity.js";
import { BROWSER_SKIP, hasFocus, tempHome, withBrowser } from "./helpers.js";

// Adding, parking, putting next and editing a running todo from the Work page (#211).

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });
const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();
const start = (id: string, extra: Record<string, unknown> = {}) => hook("pre-taskupdate", { tool_input: { taskId: id, status: "in_progress", ...extra } });
const update = (id: string, input: Record<string, unknown>) => workHook(home0, hook("post-taskupdate", { tool_input: { taskId: id, ...input } }));
let home0 = "";

/** A session with three queued todos (#1 to #3) and a running one (#4). */
function seeded() {
  const home = tempHome();
  for (const [id, subject] of [
    ["1", "Read the code"],
    ["2", "Write the migration"],
    ["3", "Run the test suite"],
    ["4", "Plan the work"],
  ])
    workHook(home, hook("post-taskcreate", { tool_input: { subject }, tool_response: { task: { id, subject } } }), at(1));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "4", status: "in_progress" } }), at(2));
  home0 = home;
  return home;
}

const change = (home: string, kind: string) => readWork(home, SESSION)!.changes!.find((c) => c.kind === kind)!;

test("an added todo goes to the agent as a TaskCreate to make, and once it appears the change names it", () => {
  const home = seeded();
  const [add] = addChanges(home, SESSION, [{ kind: "add", text: "Write the docs", description: "Cover the new flags" }], {
    by: "ankur",
    reachable: true,
    now: at(10),
  })!;
  assert.deepEqual([add!.kind, add!.todo, add!.text, add!.description], ["add", undefined, "Write the docs", "Cover the new flags"]);
  assert.equal(
    changeLine(add!),
    'Added a todo "Write the docs" with the description "Cover the new flags". Create it with TaskCreate, with that subject and description, after the todos already queued.',
  );
  assert.throws(() => addChanges(home, SESSION, [{ kind: "add", text: "Write the docs" }], { reachable: true }), /already has a todo "Write the docs"/);
  assert.throws(() => addChanges(home, SESSION, [{ kind: "add", text: "Read the code" }], { reachable: true }), /already has a todo/);
  assert.throws(() => addChanges(home, SESSION, [{ kind: "add", text: " " }], { reachable: true }), /needs text/);
  workHook(
    home,
    hook("post-taskcreate", { tool_input: { subject: "Write the docs" }, tool_response: { task: { id: "5", subject: "Write the docs" } } }),
    at(20),
  );
  const seen = change(home, "add");
  assert.deepEqual([seen.delivery, seen.todo], ["seen", "5"]);
});

test("an add the session never got by message is told once by the gate, at its next todo start", () => {
  const home = seeded();
  addChanges(home, SESSION, [{ kind: "add", text: "Write the docs" }], { by: "ankur", reachable: false });
  assert.ok(existsSync(join(home, "work", `${SESSION}.gate`)), "the gate file says a change waits");
  assert.match(workGate(home, start("1"))!.deny, /^ankur in hoop's Work view: Added a todo "Write the docs"\. Create it with TaskCreate/);
  assert.equal(workGate(home, start("1")), undefined, "told once");
  // Told, it stays open until the todo appears.
  assert.deepEqual([change(home, "add").delivery, Boolean(change(home, "add").gated_at)], ["waiting", true]);
  workHook(home, hook("post-taskcreate", { tool_input: { subject: "Write the docs" }, tool_response: { task: { id: "9", subject: "Write the docs" } } }));
  assert.deepEqual([change(home, "add").delivery, change(home, "add").todo], ["seen", "9"]);
});

test("a parked todo leaves the queue and Up next; the gate refuses it once, and starting it anyway overrides the park", () => {
  const home = seeded();
  addChanges(home, SESSION, [{ kind: "park", todo: "1" }], { by: "ankur", reachable: true, now: at(10) });
  assert.deepEqual(readWork(home, SESSION)!.parked, ["1"]);
  assert.equal(changeLine(change(home, "park")), 'Parked todo #1 "Read the code". Keep it in your list, but don\'t start it until it is unparked.');
  assert.deepEqual(
    workQueue(home, SESSION).todos.map((t) => t.id),
    ["2", "3"],
    "the agent's queue leaves it out",
  );
  const [view] = workView(home, () => []);
  assert.deepEqual(view!.parked, ["1"]);
  assert.equal(upNext(view!)?.id, "2");
  assert.throws(() => addChanges(home, SESSION, [{ kind: "park", todo: "1" }], { reachable: true }), /already parked/);
  assert.throws(() => addChanges(home, SESSION, [{ kind: "move", todo: "1", before: "2" }], { reachable: true }), /parked: unpark it first/);
  assert.throws(() => addChanges(home, SESSION, [{ kind: "move", todo: "3", before: "1" }], { reachable: true }), /isn't a queued todo/);
  // The gate refuses starting it once, then lets it go, and the park reads overridden.
  assert.match(workGate(home, start("1"))!.deny, /^ankur parked todo #1 "Read the code" in hoop's Work view: keep it, but don't start it/);
  assert.equal(workGate(home, start("1")), undefined);
  update("1", { status: "in_progress" });
  const r = readWork(home, SESSION)!;
  assert.equal(change(home, "park").delivery, "overridden");
  assert.equal(r.parked, undefined, "a started todo is parked no more");
});

test("unparking puts a todo back in its place in the queue, and settles the park", () => {
  const home = seeded();
  addChanges(home, SESSION, [{ kind: "park", todo: "2" }], { by: "ankur", reachable: true, now: at(10) });
  assert.throws(() => addChanges(home, SESSION, [{ kind: "unpark", todo: "3" }], { reachable: true }), /isn't parked|is not parked/);
  const [unpark] = addChanges(home, SESSION, [{ kind: "unpark", todo: "2" }], { by: "ankur", reachable: true, now: at(11) })!;
  assert.equal(changeLine(unpark!), 'Unparked todo #2 "Write the migration". It is back in the queue: do it in its turn.');
  assert.equal(readWork(home, SESSION)!.parked, undefined);
  assert.deepEqual(
    workQueue(home, SESSION).todos.map((t) => t.id),
    ["1", "2", "3"],
  );
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", status: "completed" } }));
  assert.equal(change(home, "park").delivery, "seen");
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "2", status: "in_progress" } }));
  assert.equal(change(home, "unpark").delivery, "seen");
});

test("a running todo takes an edit: the agent carries on with it, and the gate won't let it be marked done without it", () => {
  const home = seeded();
  const [edit] = addChanges(home, SESSION, [{ kind: "edit", todo: "4", text: "Plan the work in two PRs" }], { by: "ankur", reachable: true, now: at(10) })!;
  assert.equal(edit!.was, "running");
  assert.equal(
    changeLine(edit!),
    'Edited todo #4 to "Plan the work in two PRs" (it said "Plan the work"). It is in progress: carry on with the edited version, and set its subject to the new text with TaskUpdate.',
  );
  // Still running, it isn't overridden.
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "1", status: "pending" } }));
  assert.equal(change(home, "edit").delivery, "pending");
  // Marking it done without the new text is refused once.
  assert.equal(workGate(home, start("4")), undefined, "setting it in progress again goes on");
  assert.match(
    workGate(home, start("4", { status: "completed" }))!.deny,
    /edited todo #4 \(in progress\) in hoop's Work view to "Plan the work in two PRs"\. .*then mark it done once the edited version is done\.$/,
  );
  assert.equal(change(home, "edit").delivery, "seen");

  // Done without it, and without the gate, it reads overridden.
  const other = seeded();
  addChanges(other, SESSION, [{ kind: "edit", todo: "4", text: "Plan it again" }], { by: "ankur", reachable: true });
  workHook(other, hook("post-taskupdate", { tool_input: { taskId: "4", status: "completed" } }));
  assert.equal(change(other, "edit").delivery, "overridden");
  assert.throws(() => addChanges(other, SESSION, [{ kind: "edit", todo: "4", text: "Again" }], { reachable: true }), /isn't queued any more/);
});

test("Up next is the first queued todo in the person's order that isn't removed, parked or blocked", () => {
  const todo = (id: string, status: "queued" | "running" = "queued", blocked_by?: string[]) => ({
    id,
    text: `T${id}`,
    status,
    ...(blocked_by ? { blocked_by } : {}),
  });
  const s = {
    todos: [todo("4", "running"), todo("1"), todo("2", "queued", ["4"]), todo("3"), todo("5"), todo("6")],
    parked: ["3"],
    changes: [{ kind: "remove", todo: "1", delivery: "sent" }] as Pick<WorkChange, "kind" | "todo" | "delivery">[],
  };
  assert.equal(upNext(s)?.id, "5");
  assert.equal(upNext({ ...s, changes: [{ kind: "remove", todo: "1", delivery: "overridden" }] })?.id, "1");
  assert.equal(upNext({ ...s, todos: [todo("4", "running")] }), undefined);
});

test("an add matches only a todo created after it, by its subject's words, never a done one (regression)", () => {
  const home = seeded();
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "3", status: "completed" } }));
  // A done todo with the same words doesn't stop an add, nor count as it.
  const [add] = addChanges(home, SESSION, [{ kind: "add", text: "Run the test suite" }], { by: "ankur", reachable: true, now: at(10) })!;
  assert.throws(() => addChanges(home, SESSION, [{ kind: "add", text: "run the TEST suite!" }], { reachable: true }), /already has a todo/);
  assert.equal(change(home, "add").delivery, "pending");
  workHook(
    home,
    hook("post-taskcreate", { tool_input: { subject: "Run the  test-suite." }, tool_response: { task: { id: "6", subject: "Run the  test-suite." } } }),
    at(20),
  );
  assert.deepEqual([change(home, "add").delivery, change(home, "add").todo], ["seen", "6"], "case, spaces and punctuation aside");
  assert.equal(add!.id, change(home, "add").id);

  // A todo created before the add never counts as it.
  const before = seeded();
  workHook(before, hook("post-taskcreate", { tool_input: { subject: "Write docs" }, tool_response: { task: { id: "7", subject: "Write docs" } } }), at(5));
  workHook(before, hook("post-taskupdate-deleted", { tool_input: { taskId: "7", status: "deleted" } }), at(6));
  addChanges(before, SESSION, [{ kind: "add", text: "Write docs" }], { by: "ankur", reachable: true, now: at(10) });
  workHook(before, hook("post-taskupdate", { tool_input: { taskId: "1", status: "in_progress" } }), at(11));
  assert.equal(change(before, "add").todo, undefined);
});

test("an add the agent's turn or session ended without reads overridden, and can be added again (regression)", async () => {
  const home = seeded();
  const sent: string[] = [];
  const steer = new Steer(home, () => [{ session: SESSION, pid: 1, socket: "/fake/socket" }], { delayMs: 10_000, send: async (_s, t) => void sent.push(t) });
  steer.record(SESSION, [{ kind: "add", text: "Write the docs" }], "ankur");
  await steer.flush(SESSION);
  const sentAt = change(home, "add").sent_at!;
  const view = (state: "busy" | "idle" | "ended", activity: string) => [
    { ...workView(home, () => [{ session: SESSION, pid: 1, status: "busy" }])[0]!, state, activity },
  ];
  const later = new Date(Date.parse(sentAt) + 1000).toISOString();
  steer.settleAdds(view("busy", later), Date.parse(later) + ADD_GRACE_MS);
  assert.equal(change(home, "add").delivery, "sent", "not while the session works");
  steer.settleAdds(view("idle", later), Date.parse(later) + 1000);
  assert.equal(change(home, "add").delivery, "sent", "not in the grace a late TaskCreate hook may take");
  steer.settleAdds(view("idle", later), Date.parse(later) + ADD_GRACE_MS);
  assert.equal(change(home, "add").delivery, "overridden");
  // Overridden, it can be added again; an ended session overrides an open add at once.
  addChanges(home, SESSION, [{ kind: "add", text: "Write the docs" }], { by: "ankur", reachable: false });
  steer.settleAdds(view("ended", sentAt));
  assert.deepEqual(
    readWork(home, SESSION)!.changes!.map((c) => c.delivery),
    ["overridden", "overridden"],
  );
});

test("a person withdraws an add: one not sent yet goes quietly, one sent goes to the agent, and it can be added again (regression)", () => {
  const home = seeded();
  const [quiet] = addChanges(home, SESSION, [{ kind: "add", text: "Write the docs" }], { by: "ankur", reachable: true })!;
  const [back] = addChanges(home, SESSION, [{ kind: "withdraw", of: quiet!.id }], { by: "ankur", reachable: true })!;
  let r = readWork(home, SESSION)!;
  assert.deepEqual(
    r.changes!.map((c) => [c.kind, c.delivery]),
    [
      ["add", "withdrawn"],
      ["withdraw", "seen"],
    ],
    "nothing goes out for an add that never did",
  );
  assert.equal(back!.of, quiet!.id);
  assert.throws(() => addChanges(home, SESSION, [{ kind: "withdraw", of: quiet!.id }], { reachable: true }), /can be withdrawn/);
  // One the gate told goes to the agent, by the gate too.
  const [told] = addChanges(home, SESSION, [{ kind: "add", text: "Write the docs" }], { by: "ankur", reachable: false })!;
  workGate(home, start("1"));
  const [withdraw] = addChanges(home, SESSION, [{ kind: "withdraw", of: told!.id }], { by: "ankur", reachable: false })!;
  assert.equal(withdraw!.delivery, "waiting");
  assert.equal(
    changeLine(withdraw!),
    'Withdrew the todo "Write the docs" added earlier: don\'t create it, or delete it with TaskUpdate (status "deleted") if you already did.',
  );
  assert.match(workGate(home, start("2"))!.deny, /^ankur in hoop's Work view: Withdrew the todo "Write the docs"/);
  r = readWork(home, SESSION)!;
  assert.equal(r.changes!.find((c) => c.id === told!.id)!.delivery, "withdrawn");
});

test("a parked todo's moves settle, and starting it after the park was told isn't refused again for the order (regression)", () => {
  const home = seeded();
  addChanges(home, SESSION, [{ kind: "move", todo: "3", before: "1" }], { by: "ankur", reachable: false, now: at(10) });
  addChanges(home, SESSION, [{ kind: "park", todo: "3" }], { by: "ankur", reachable: false, now: at(11) });
  assert.match(workGate(home, start("3"))!.deny, /parked todo #3/);
  assert.equal(change(home, "move").delivery, "seen", "the park stands in for the move, so the gate never tells it");
  assert.equal(workGate(home, start("3")), undefined, "the person's order doesn't refuse it a second time");
});

test("a subagent's todo calls don't use up the one-time refusals meant for the session's agent (regression)", () => {
  const home = seeded();
  addChanges(
    home,
    SESSION,
    [
      { kind: "park", todo: "1" },
      { kind: "edit", todo: "2", text: "Write the migration and its test" },
      { kind: "add", text: "Write the docs" },
    ],
    { by: "ankur", reachable: false },
  );
  const sub = (id: string) => ({ ...start(id), agent_id: "a1b2c3d4e5f607182" });
  assert.equal(workGate(home, sub("1")), undefined);
  assert.equal(workGate(home, sub("2")), undefined);
  const r = readWork(home, SESSION)!;
  assert.deepEqual(
    r.changes!.map((c) => c.gated_at),
    [undefined, undefined, undefined],
  );
  assert.match(workGate(home, start("1"))!.deny, /parked todo #1/);
  assert.match(workGate(home, start("2"))!.deny, /edited todo #2/);
});

test("hoop_work_queue lists parked todos apart, with a note", () => {
  const home = seeded();
  addChanges(home, SESSION, [{ kind: "park", todo: "2" }], { by: "ankur", reachable: true });
  const q = workQueue(home, SESSION);
  assert.deepEqual(
    q.todos.map((t) => t.id),
    ["1", "3"],
  );
  assert.deepEqual(q.parked, [{ id: "2", text: "Write the migration" }]);
  assert.match(q.parked_note!, /don't start one until they unpark it/);
});

test("the Work page shows a sent add with its delivery and withdraws it from the keyboard (regression)", { skip: BROWSER_SKIP }, async () => {
  const home = seeded();
  const steer = new Steer(home, () => [{ session: SESSION, pid: 1, socket: "/fake/socket" }], { delayMs: 10_000, send: async () => undefined });
  steer.record(SESSION, [{ kind: "add", text: "Write the docs" }], "ankur");
  await steer.flush(SESSION);
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => ((window as unknown as { HOOP_WORK_MS: number }).HOOP_WORK_MS = 200));
      await page.goto(`${base}/work`);
      const added = page.locator(".todo.added", { hasText: "Write the docs" });
      await added.waitFor();
      assert.match(await added.locator(".note").innerText(), /added it .*Sent to the session/);
      await added.getByRole("button", { name: "Withdraw the new todo Write the docs" }).focus();
      await page.keyboard.press("Enter");
      await added.waitFor({ state: "detached" });
      assert.ok(await hasFocus(page.getByRole("button", { name: /^Add todo to / })), "focus goes to Add todo");
      assert.equal(change(home, "withdraw").delivery, "waiting", "a sent add's withdraw still has to reach the agent");
      assert.equal(change(home, "add").delivery, "withdrawn");
    },
    new Hoop(new Store(home)),
    { sessions: () => [{ session: SESSION, pid: 1, status: "busy", cwd: "/tmp/proj" }] },
  );
});

test("the Work page adds a todo, puts one next, parks and unparks one, and edits a running one, from the keyboard", { skip: BROWSER_SKIP }, async () => {
  const home = seeded();
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => ((window as unknown as { HOOP_WORK_MS: number }).HOOP_WORK_MS = 200));
      await page.goto(`${base}/work`);
      const session = page.locator("section.work-session");
      await session.waitFor();
      const todo = (id: string) => session.locator(`.todo[data-todo="${id}"]`);
      const order = () =>
        session
          .locator("ol.todos")
          .first()
          .locator(":scope > .todo")
          .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.todo ?? "added"));
      assert.match(await session.locator(".up-next").innerText(), /Up next: #1 Read the code/);

      // Add a todo, from the keyboard: it shows at the end of the queue until the agent creates it.
      await page.getByRole("button", { name: "Add todo" }).focus();
      await page.keyboard.press("Enter");
      await page.getByLabel("Subject of the new todo").fill("Write the docs");
      await page.getByLabel("Description of the new todo (optional)").fill("Cover the flags");
      await page.getByLabel("Subject of the new todo").press("Enter");
      await session.locator(".todo.added", { hasText: "Write the docs" }).waitFor();
      assert.match(await session.locator(".todo.added .note").innerText(), /added it, with the description “Cover the flags”/);
      assert.ok(await hasFocus(page.getByRole("button", { name: "Add todo" })), "focus goes back to Add todo");

      // Next: #3 goes to the top of the queue in one change.
      await todo("3")
        .getByRole("button", { name: /^Put next/ })
        .focus();
      await page.keyboard.press("Enter");
      await todo("3").locator(".note", { hasText: "moved #3 up, before #1" }).waitFor();
      assert.deepEqual(await order(), ["4", "3", "1", "2", "added"]);
      assert.match(await session.locator(".up-next").innerText(), /#3 Run the test suite/);
      assert.ok(await hasFocus(todo("3").getByRole("button", { name: /^Move down/ })), "focus goes to the todo's next control");

      // Park #3: it folds under Parked, focus on its Unpark, and Up next moves on.
      await todo("3").getByRole("button", { name: /^Park/ }).focus();
      await page.keyboard.press("Enter");
      await session.locator("details.parked[open] .todo[data-todo='3']").waitFor();
      assert.ok(await hasFocus(todo("3").getByRole("button", { name: /^Unpark/ })), "focus follows it to Unpark");
      assert.deepEqual(await order(), ["4", "1", "2", "added"]);
      assert.match(await session.locator(".up-next").innerText(), /#1 Read the code/);
      await page.keyboard.press("Enter");
      await session.locator("details.parked").waitFor({ state: "detached" });
      assert.deepEqual(await order(), ["4", "3", "1", "2", "added"]);
      assert.ok(await hasFocus(todo("3").getByRole("button", { name: /^Park/ })), "focus stays on the todo's Park");

      // Edit the running todo.
      await todo("4").getByRole("button", { name: /^Edit/ }).click();
      await page.getByLabel("New text for todo #4").fill("Plan the work in two PRs");
      await page.getByLabel("New text for todo #4").press("Enter");
      await todo("4").locator(".note", { hasText: "edited it to “Plan the work in two PRs”" }).waitFor();

      const r = readWork(home, SESSION)!;
      assert.deepEqual(
        r.changes!.map((c) => [c.kind, c.todo ?? c.text]),
        [
          ["add", "Write the docs"],
          ["move", "3"],
          ["park", "3"],
          ["unpark", "3"],
          ["edit", "4"],
        ],
      );
    },
    new Hoop(new Store(home)),
    { sessions: () => [{ session: SESSION, pid: 1, status: "busy", cwd: "/tmp/proj" }] },
  );
});
