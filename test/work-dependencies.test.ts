import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { addChanges, changeLine, Steer, workGate } from "../src/steer.js";
import { Store } from "../src/store.js";
import { firstQueued, readWork, workHook, workQueue, workView } from "../src/work.js";
import { upNext } from "../web/activity.js";
import { BROWSER_SKIP, hasFocus, hoopArgs, pagesFor, tempHome, withBrowser } from "./helpers.js";

// Todos that start after others (#210): the agent's own blocked-by links and the person's "Starts after".

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });
const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();
const start = (id: string, extra: Record<string, unknown> = {}) => hook("pre-taskupdate", { tool_input: { taskId: id, status: "in_progress", ...extra } });
const gateScript = new URL("../plugins/hoop/scripts/gate-work.sh", import.meta.url).pathname;
const view = (home: string) => workView(home, () => [{ session: SESSION, pid: 1, status: "busy", cwd: "/tmp/proj" }])[0]!;

/** A session with four queued todos (#1 to #4) and a running one (#5). */
function seeded() {
  const home = tempHome();
  for (const [id, subject] of [
    ["1", "Read the code"],
    ["2", "Write the migration"],
    ["3", "Run the test suite"],
    ["4", "Open a pull request"],
    ["5", "Plan the work"],
  ])
    workHook(home, hook("post-taskcreate", { tool_input: { subject }, tool_response: { task: { id, subject } } }), at(1));
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "5", status: "in_progress" } }), at(2));
  return home;
}
const blockBy = (home: string, id: string, by: string[]) => workHook(home, hook("post-taskupdate", { tool_input: { taskId: id, addBlockedBy: by } }));
const change = (home: string, kind: string) => readWork(home, SESSION)!.changes!.find((c) => c.kind === kind)!;

test("the person's first todo skips a blocked one, so the gate never sends the agent to a blocked todo (regression)", () => {
  const home = seeded();
  blockBy(home, "1", ["2"]);
  // The person sets an order that leaves the blocked #1 on top.
  addChanges(home, SESSION, [{ kind: "move", todo: "3", after: "2" }], { by: "ankur", reachable: true });
  const r = readWork(home, SESSION)!;
  assert.equal(firstQueued(r)?.id, "2", "the first unblocked todo, as Up next says");
  assert.equal(upNext(view(home))?.id, "2");
  assert.equal(readFileSync(join(home, "work", `${SESSION}.order`), "utf8"), "2\n");
  assert.equal(workGate(home, start("2")), undefined, "starting the todo the blocked one waits for goes on");
  assert.equal(workGate(home, start("3"))!.deny, "The person put #2 first in hoop's Work view; start #2, or ask them.");
});

test("the gate refuses starting a blocked todo once, naming its blocker; starting it again goes on", () => {
  const home = seeded();
  blockBy(home, "3", ["1", "5"]);
  assert.equal(readFileSync(join(home, "work", `${SESSION}.blocked`), "utf8"), "3\n");
  // A subagent's call doesn't use up the refusal.
  assert.equal(workGate(home, { ...start("3"), agent_id: "a1b2c3d4e5f607182" }), undefined);
  assert.equal(
    workGate(home, start("3"))!.deny,
    'Todo #3 "Run the test suite" starts after #1 "Read the code", #5 "Plan the work", not done yet (hoop\'s Work view). First start #1, finish #5 (in progress), or ask the person; starting #3 again goes on.',
  );
  assert.equal(existsSync(join(home, "work", `${SESSION}.blocked`)), false, "told: the gate script needn't start hoop for it again");
  assert.equal(workGate(home, start("3")), undefined, "told once: the agent may go on");
  // A done blocker blocks nothing, and marking done is never refused for it.
  const other = seeded();
  blockBy(other, "4", ["1"]);
  assert.equal(workGate(other, start("4", { status: "completed" })), undefined);
  workHook(other, hook("post-taskupdate", { tool_input: { taskId: "1", status: "completed" } }));
  assert.equal(workGate(other, start("4")), undefined);
  assert.deepEqual(
    workQueue(other, SESSION).todos.map((t) => [t.id, t.blocked_by]),
    [
      ["2", undefined],
      ["3", undefined],
      ["4", undefined],
    ],
  );
});

test("the gate script starts hoop for a blocked start only while the gate hasn't told it", async () => {
  const home = seeded();
  const pages = await pagesFor(home);
  const bin = mkdtempSync(join(tmpdir(), "hoop-gate-bin-"));
  const crash = join(bin, "crash");
  writeFileSync(crash, `#!/bin/sh\ncat >/dev/null\necho ran >> "${bin}/ran"\nexit 1\n`);
  chmodSync(crash, 0o755);
  const real = [process.execPath, ...hoopArgs].join(" ");
  const run = (hoopBin: string, input: object) =>
    spawnSync("sh", [gateScript], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...pages, HOOP_BIN: hoopBin } });
  const ran = () => (existsSync(join(bin, "ran")) ? readFileSync(join(bin, "ran"), "utf8").split("\n").length - 1 : 0);
  blockBy(home, "3", ["1"]);
  run(crash, start("2"));
  assert.equal(ran(), 0, "an unblocked start doesn't start hoop");
  run(crash, start("3"));
  assert.equal(ran(), 1);
  const denied = run(real, start("3"));
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /^Todo #3 "Run the test suite" starts after #1/);
  run(crash, start("3"));
  assert.equal(ran(), 1, "told: hoop doesn't start again");
});

test("a Starts after change blocks the todo at once, reaches the agent as a TaskUpdate to make, and settles", () => {
  const home = seeded();
  const [c] = addChanges(home, SESSION, [{ kind: "depend", todo: "1", after: "3" }], { by: "ankur", reachable: true, now: at(10) })!;
  assert.equal(
    changeLine(c!),
    'Todo #1 "Read the code" starts after #3: don\'t start it until #3 is done. Record it with TaskUpdate (taskId "1", addBlockedBy ["3"]); if you keep your list with TodoWrite, hoop keeps the link for you.',
  );
  assert.deepEqual(readWork(home, SESSION)!.starts_after, { "1": ["3"] });
  const s = view(home);
  assert.deepEqual(s.todos.find((t) => t.id === "1")!.blocked_by, ["3"], "the page shows it as Blocked by");
  assert.equal(upNext(s)?.id, "2");
  // The agent records it: the change is seen.
  blockBy(home, "1", ["3"]);
  assert.equal(change(home, "depend").delivery, "seen");

  // Told by the gate, it is seen; starting the todo anyway, before its blocker is done, overrides it.
  const gated = seeded();
  addChanges(gated, SESSION, [{ kind: "depend", todo: "2", after: "1" }], { by: "ankur", reachable: false });
  assert.match(workGate(gated, start("2"))!.deny, /^Todo #2 "Write the migration" starts after #1 "Read the code"/);
  assert.equal(change(gated, "depend").delivery, "seen");
  const ignored = seeded();
  addChanges(ignored, SESSION, [{ kind: "depend", todo: "2", after: "1" }], { by: "ankur", reachable: true });
  workHook(ignored, hook("post-taskupdate", { tool_input: { taskId: "2", status: "in_progress" } }));
  assert.equal(change(ignored, "depend").delivery, "overridden");
  assert.equal(readWork(ignored, SESSION)!.starts_after, undefined, "a started todo waits for nothing");
});

test("a Starts after that would make a cycle, or that is already there, is refused with a clear message", () => {
  const home = seeded();
  blockBy(home, "2", ["1"]);
  addChanges(home, SESSION, [{ kind: "depend", todo: "3", after: "2" }], { by: "ankur", reachable: true });
  const refused = (...inputs: object[]) => {
    try {
      addChanges(home, SESSION, inputs, { by: "ankur", reachable: true });
    } catch (err) {
      return (err as Error).message;
    }
    return "accepted";
  };
  assert.equal(refused({ kind: "depend", todo: "1", after: "3" }), "todo #3 already waits for #1, so #1 can't start after it: that would be a cycle");
  assert.equal(refused({ kind: "depend", todo: "2", after: "3" }), "todo #3 already waits for #2, so #2 can't start after it: that would be a cycle");
  assert.equal(refused({ kind: "depend", todo: "2", after: "1" }), "todo #2 already starts after #1");
  assert.equal(refused({ kind: "depend", todo: "3", after: "3" }), "todo #3 isn't a todo to wait for: it must be in the list and not done");
  assert.equal(refused({ kind: "depend", todo: "5", after: "1" }), "todo #5 isn't queued any more");
  addChanges(home, SESSION, [{ kind: "park", todo: "4" }], { by: "ankur", reachable: true });
  assert.equal(refused({ kind: "depend", todo: "1", after: "4" }), "todo #4 is parked: unpark it first");
  addChanges(home, SESSION, [{ kind: "unpark", todo: "4" }], { by: "ankur", reachable: true });
  // A batch is checked as a whole, all or none: its second change can't close a cycle the first opened.
  assert.equal(
    refused({ kind: "depend", todo: "4", after: "1" }, { kind: "depend", todo: "1", after: "4" }),
    "todo #4 already waits for #1, so #1 can't start after it: that would be a cycle",
  );
  assert.deepEqual(readWork(home, SESSION)!.starts_after, { "3": ["2"] });
});

test("a removed or parked blocker blocks nothing, so the gate never sends the agent to it (regression)", () => {
  const home = seeded();
  addChanges(home, SESSION, [{ kind: "depend", todo: "2", after: "1" }], { by: "ankur", reachable: true });
  addChanges(home, SESSION, [{ kind: "remove", todo: "1" }], { by: "ankur", reachable: true });
  addChanges(home, SESSION, [{ kind: "move", todo: "2", before: "3" }], { by: "ankur", reachable: true });
  assert.equal(firstQueued(readWork(home, SESSION)!)?.id, "2");
  assert.equal(upNext(view(home))?.id, "2");
  assert.equal(workGate(home, start("2")), undefined, "no refusal names the removed #1");

  const parked = seeded();
  addChanges(
    parked,
    SESSION,
    [
      { kind: "depend", todo: "2", after: "1" },
      { kind: "move", todo: "2", before: "3" },
    ],
    { by: "ankur", reachable: true },
  );
  addChanges(parked, SESSION, [{ kind: "park", todo: "1" }], { by: "ankur", reachable: true });
  assert.equal(firstQueued(readWork(parked, SESSION)!)?.id, "2");
  assert.deepEqual(workQueue(parked, SESSION).todos[0], { id: "2", text: "Write the migration" });
  assert.equal(workGate(parked, start("2")), undefined, "no refusal sends the agent to the parked #1");
});

test("a blocked todo the person parked stays out of the gate's blocked list (regression)", () => {
  const home = seeded();
  blockBy(home, "3", ["1"]);
  addChanges(home, SESSION, [{ kind: "park", todo: "3" }], { by: "ankur", reachable: true });
  assert.equal(existsSync(join(home, "work", `${SESSION}.blocked`)), false, "the park speaks for it");
  addChanges(home, SESSION, [{ kind: "unpark", todo: "3" }], { by: "ankur", reachable: true });
  assert.equal(readFileSync(join(home, "work", `${SESSION}.blocked`), "utf8"), "3\n");
});

test("a Starts after waiting while the session takes no messages reaches the agent through the gate", async () => {
  const home = seeded();
  const sent: string[] = [];
  const steer = new Steer(home, () => [], { delayMs: 0, send: async (_s, text) => void sent.push(text) });
  addChanges(home, SESSION, [{ kind: "depend", todo: "2", after: "1" }], { by: "ankur", reachable: false });
  await steer.flush(SESSION);
  assert.deepEqual(sent, [], "nothing goes by message");
  assert.equal(change(home, "depend").delivery, "waiting");
  assert.equal(readFileSync(join(home, "work", `${SESSION}.blocked`), "utf8"), "2\n");
  assert.match(workGate(home, start("2"))!.deny, /^Todo #2 "Write the migration" starts after #1 "Read the code"/);
  assert.equal(change(home, "depend").delivery, "seen");
});

test("the person withdraws a Starts after: the todo is free at once, and only a link that went out needs a message", () => {
  const home = seeded();
  const [dep] = addChanges(home, SESSION, [{ kind: "depend", todo: "2", after: "1" }], { by: "ankur", reachable: true })!;
  const [back] = addChanges(home, SESSION, [{ kind: "withdraw", of: dep!.id }], { by: "ankur", reachable: true })!;
  const r = readWork(home, SESSION)!;
  assert.equal(r.starts_after, undefined);
  assert.equal(r.changes!.find((c) => c.id === dep!.id)!.delivery, "withdrawn");
  assert.equal(back!.delivery, "seen", "never sent: no message needed");
  assert.throws(() => addChanges(home, SESSION, [{ kind: "withdraw", of: dep!.id }], { by: "ankur", reachable: true }), /no longer starts after #1/);

  const told = seeded();
  const [d2] = addChanges(told, SESSION, [{ kind: "depend", todo: "2", after: "1" }], { by: "ankur", reachable: false })!;
  workGate(told, start("2"));
  const [b2] = addChanges(told, SESSION, [{ kind: "withdraw", of: d2!.id }], { by: "ankur", reachable: true })!;
  assert.equal(b2!.delivery, "pending");
  assert.equal(changeLine(b2!), 'Todo #2 "Write the migration" no longer has to start after #1: start it in its turn.');
  workHook(told, hook("post-taskupdate", { tool_input: { taskId: "2", status: "in_progress" } }));
  assert.equal(readWork(told, SESSION)!.changes!.find((c) => c.id === b2!.id)!.delivery, "seen");
});

test("the Work page says what a todo starts after, refuses a cycle, and asks before moving a todo above its blocker, from the keyboard", {
  skip: BROWSER_SKIP,
}, async () => {
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
          .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.todo));

      // #2 starts after #1.
      await todo("2")
        .getByRole("button", { name: /^Say what todo #2/ })
        .focus();
      await page.keyboard.press("Enter");
      const pick = page.getByLabel("todo #2 starts after");
      assert.ok(await hasFocus(pick), "focus goes to the choice");
      await pick.selectOption("1");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await todo("2").locator(".note", { hasText: "said it starts after #1" }).waitFor();
      assert.match(await todo("2").locator(".why").innerText(), /Blocked by #1 “Read the code”/);
      assert.match(await session.locator(".up-next").innerText(), /#1 Read the code/);

      // #1 can't then start after #2.
      await todo("1")
        .getByRole("button", { name: /^Say what todo #1/ })
        .click();
      await page.getByLabel("todo #1 starts after").selectOption("2");
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByRole("alert").filter({ hasText: "that would be a cycle" }).waitFor();
      await page.keyboard.press("Escape");

      // The link shows Withdraw on its Blocked by line; withdrawing it frees #2, and focus goes to After….
      await todo("2").getByRole("button", { name: "Withdraw #1: todo #2, Write the migration starts after it" }).focus();
      await page.keyboard.press("Enter");
      await todo("2").locator(".note", { hasText: "withdrew that it starts after #1" }).waitFor();
      assert.equal(await todo("2").locator(".why").count(), 0);
      assert.ok(await hasFocus(todo("2").getByRole("button", { name: /^Say what todo #2/ })));
      await page.keyboard.press("Enter");
      await page.getByLabel("todo #2 starts after").selectOption("1");
      await page.getByRole("button", { name: "Save" }).click();
      await todo("2").locator(".why", { hasText: "Blocked by #1" }).waitFor();

      // Moving #2 above #1 asks first; Cancel keeps the order, Move moves it.
      await todo("2")
        .getByRole("button", { name: /^Move up/ })
        .focus();
      await page.keyboard.press("Enter");
      const ask = session.locator(".confirm");
      assert.match(await ask.innerText(), /Move todo #2 above #1 “Read the code”\? It starts after that todo\./);
      assert.ok(await hasFocus(page.locator("[data-confirm]")));
      await page.keyboard.press("Escape");
      assert.deepEqual(await order(), ["5", "1", "2", "3", "4"]);
      assert.ok(await hasFocus(todo("2").getByRole("button", { name: /^Move up/ })), "focus goes back to Up");
      // Moving #1 below #2 asks too.
      await todo("1")
        .getByRole("button", { name: /^Move down/ })
        .click();
      assert.match(await ask.innerText(), /Move todo #1 below #2 “Write the migration”\? #2 starts after it\./);
      await page.keyboard.press("Escape");
      await todo("2")
        .getByRole("button", { name: /^Move up/ })
        .click();
      await page.locator("[data-confirm]").press("Enter");
      await todo("2").locator(".note", { hasText: "moved #2 up, before #1" }).waitFor();
      assert.deepEqual(await order(), ["5", "2", "1", "3", "4"]);
      // Moving a todo with no blocker above it asks nothing.
      await todo("4")
        .getByRole("button", { name: /^Move up/ })
        .click();
      await todo("4").locator(".note", { hasText: "moved #4 up, before #3" }).waitFor();
      assert.deepEqual(
        readWork(home, SESSION)!.changes!.map((c) => [c.kind, c.todo]),
        [
          ["depend", "2"],
          ["withdraw", "2"],
          ["depend", "2"],
          ["move", "2"],
          ["move", "4"],
        ],
      );
    },
    new Hoop(new Store(home)),
    { sessions: () => [{ session: SESSION, pid: 1, status: "busy", cwd: "/tmp/proj" }] },
  );
});
