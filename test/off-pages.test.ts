import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeSession } from "../src/claude-sessions.js";
import { Hoop } from "../src/hoop.js";
import { isOff } from "../src/off.js";
import { parseMarkdown } from "../src/markdown.js";
import { Steer } from "../src/steer.js";
import { Store } from "../src/store.js";
import { agentState, deliverAction, deliverReview } from "../src/wake.js";
import { readWork, workHook } from "../src/work.js";
import { BROWSER_SKIP, example, op, postJson, tempHome, withBrowser, withServer } from "./helpers.js";
import { idleSession } from "./builders.js";

// The two switches in hoop's off list that the pages process reads (src/off.ts): `messages` sends
// nothing into a session, and `mermaid` loads no diagram library (decided in rv_mw7v3t9e01fc83).

const NOT_SENT = "Not sent: messages into a session are off in hoop's off list";
const SAVED = "Saved. Messages into a session are off in hoop's off list, so Claude wasn't told; it reads this with hoop_wait or hoop_feedback.";
const DIAGRAMS = "Diagrams are off in hoop's off list, so this shows its source.";
const HOOKS = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8")));

const off = (home: string, text: string) => writeFileSync(join(home, "off"), text);
const live = (extra: Partial<ClaudeSession> = {}): ClaudeSession[] => [idleSession({ socket: "/fake", ...extra })];

test("the pages process reads hoop's off list as the hooks do: a name alone on its line", () => {
  const home = tempHome();
  assert.equal(isOff(home, "messages"), false, "no list");
  for (const [text, want] of [
    ["messages\n", true],
    ["\tmessages  \r\n", true],
    ["mermaid\nmessages", true],
    ["# messages\n", false],
    ["messages_off\n", false],
    ["messages please\n", false],
    ['{"messages": false}\n', false],
  ] as const) {
    off(home, text);
    assert.equal(isOff(home, "messages"), want, JSON.stringify(text));
  }
});

test("with messages off, a review, a close and an action item are recorded as not sent, and nothing goes out", async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home));
  const sent: string[] = [];
  const opts = { sessions: () => live(), send: async (_s: string, t: string) => void sent.push(t) };
  const { review_id } = hoop.submit(example());
  off(home, "messages\n");
  const fb = hoop.review(review_id, { verdict: "changes_requested", reviewer: "ana", comments: [{ item: "FR-3", line: 1, body: "Inclusive?" }] }, true);
  assert.equal((await deliverReview(hoop.store, fb, opts))?.outcome, "off");
  assert.equal(hoop.store.deliveries(review_id)["1.0"]!.outcome, "off");
  const item = { id: "ai_1", title: "Run it", state: "done", owner: { session: hoop.store.meta(review_id).owner!.session }, closed_by: "ana" } as never;
  assert.equal((await deliverAction(home, item, opts))?.outcome, "off");
  assert.deepEqual(sent, []);
  // The review page doesn't promise a wake.
  const a = agentState(hoop.store, hoop.store.meta(review_id), () => live());
  assert.equal(a && "wakes" in a ? a.wakes : undefined, false);
  // Turned on again, the next one goes.
  off(home, "# messages\n");
  const again = hoop.review(review_id, { verdict: "approved", reviewer: "ana", comments: [], resolved_threads: [`th_${review_id.slice(3)}_1`] }, true);
  assert.equal((await deliverReview(hoop.store, again, opts))?.outcome, "sent");
  assert.equal(sent.length, 1);
});

test("with messages off, Work's changes wait for the gate, and /api/work says why", async () => {
  const home = tempHome();
  workHook(home, HOOKS["post-taskcreate"]);
  const session = HOOKS["post-taskcreate"].session_id;
  const sent: string[] = [];
  const steer = new Steer(home, () => [{ session, pid: 1, socket: "/fake/socket" }], { delayMs: 10, send: async (_s, t) => void sent.push(t) });
  off(home, "messages\n");
  const todo = readWork(home, session)!.todos[0]!.id;
  steer.record(session, [{ kind: "comment", todo, text: "Start here" }], "ana");
  await steer.flush(session);
  assert.deepEqual(sent, []);
  assert.deepEqual(
    readWork(home, session)!.changes!.map((c) => c.delivery),
    ["waiting"],
  );
  await withServer(
    { sessions: () => [] },
    async (base) => {
      assert.equal((await (await fetch(`${base}/api/work`)).json()).messages_off, true);
    },
    new Hoop(new Store(home)),
  );
  off(home, "");
  await withServer(
    { sessions: () => [] },
    async (base) => {
      assert.equal((await (await fetch(`${base}/api/work`)).json()).messages_off, undefined);
    },
    new Hoop(new Store(home)),
  );
});

test("the pages say so where a message wasn't sent: the review page, a quick question, Home and Work", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  workHook(home, HOOKS["post-taskcreate"]);
  const session = HOOKS["post-taskcreate"].session_id;
  off(home, "messages\n");
  await withBrowser(
    async ({ hoop, base, page }) => {
      const { review_id } = hoop.submit(example());
      await page.goto(`${base}/r/${review_id}`);
      await page.locator('#finishBtn[data-verdict="approved"]').click();
      await page.locator("#submitReview").click();
      await page.getByText(SAVED).waitFor();

      const ask = hoop.ask({ questions: [{ question: "Keep it?", options: [{ label: "Keep", recommended: true }, { label: "Remove" }] }] }).review_id;
      await page.goto(`${base}/r/${ask}`);
      await page.locator(".ask-opt").first().click();
      await page.getByText(SAVED).first().waitFor();

      // An action item marked done says on Home that its session wasn't told.
      const item = op("action").run(hoop, { title: "Run the migration", description: "Do it.", done_when: { kind: "manual" } } as never, {
        actor: "claude",
      }) as { id: string };
      await postJson(`${base}/api/actions/${item.id}`, { action: "done" });
      await page.goto(`${base}/`);
      await page.getByRole("button", { name: /^Completed/ }).click();
      await page.locator(".action.closed .m", { hasText: NOT_SENT }).waitFor();

      const posted = await postJson(`${base}/api/work/${session}/changes`, {
        changes: [{ kind: "comment", todo: readWork(home, session)!.todos[0]!.id, text: "Start here" }],
      });
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
      await page.goto(`${base}/work`);
      await page.locator(".work-session").first().waitFor();
      const text = await page.locator("main, #app").first().innerText();
      assert.ok(text.includes(NOT_SENT), text.slice(0, 1500));
    },
    new Hoop(new Store(home)),
    { sessions: () => live({ session }) },
  );
});

const DIAGRAM_DOC = "# Flow\n\nHow it goes.\n\n## Steps\n\n```mermaid\ngraph TD\n  A --> B\n```\n";

test("with mermaid off, a diagram shows its source under a muted note, loads nothing, and tells Claude nothing", { skip: BROWSER_SKIP }, async () => {
  const home = tempHome();
  off(home, "mermaid\n");
  await withBrowser(
    async ({ hoop, base, page }) => {
      assert.equal((await (await fetch(`${base}/api/info`)).json()).diagrams_off, true);
      const asked: string[] = [];
      page.on("request", (r) => {
        if (!r.url().startsWith(base)) asked.push(r.url());
      });
      const { review_id } = hoop.submit(parseMarkdown(DIAGRAM_DOC));
      await page.goto(`${base}/r/${review_id}`);
      const note = page.locator(".diagram .diagram-off");
      await note.waitFor();
      assert.equal(await note.textContent(), DIAGRAMS);
      assert.equal((await page.locator(".diagram .diagram-src").textContent())?.trim(), "graph TD\n  A --> B");
      assert.equal(await page.locator(".diagram iframe, .diagram-error").count(), 0);
      assert.equal(
        await note.evaluate((el) => getComputedStyle(el).color),
        await page.locator(".top .rev").evaluate((el) => getComputedStyle(el).color),
        "muted",
      );
      await page.waitForTimeout(300);
      assert.deepEqual(asked, [], "no library is loaded");
      assert.deepEqual(hoop.store.diagramErrors(review_id), {}, "no diagram error for Claude");
    },
    new Hoop(new Store(home)),
  );
});
