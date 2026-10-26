import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { personQueued, transcriptRequests } from "../src/requests.js";
import { steerMessage } from "../src/steer.js";
import { Store } from "../src/store.js";
import { type ClaudeSession, workHook, workView } from "../src/work.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

// Messages the person typed while the agent worked wait in Claude Code's queue until the agent picks
// them up; the Work page shows them under the Now line, with when each was sent and picked up, and the
// todos each became (#209). The entries have the shapes Claude Code 2.1 writes.

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = HOOKS["post-taskcreate"].session_id as string;
const iso = (s: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();
const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const op = (s: number, operation: string, content?: string) =>
  line({ type: "queue-operation", operation, timestamp: iso(s), ...(content !== undefined ? { content } : {}) });
const typed = (uuid: string, s: number, prompt: string, text: string, source = "typed") =>
  line({ type: "user", uuid, timestamp: iso(s), promptId: prompt, promptSource: source, origin: { kind: "human" }, message: { role: "user", content: text } });
const notice = "<task-notification>\n<status>completed</status>\n</task-notification>";
const absorbed = (uuid: string, s: number, text: string) =>
  line({ type: "attachment", uuid, timestamp: iso(s), attachment: { type: "queued_command", prompt: text, origin: { kind: "human" } } });
const work = `${steerMessage([{ id: "ch_1", kind: "comment", todo: "1", subject: "Write it", was: "queued", text: "Use semicolons", by: "ankur", at: iso(0), delivery: "pending" }])}\n\n(hoop-ref st_abc123)`;

const scan = (text: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "hoop-queue-")), "t.jsonl");
  writeFileSync(path, text);
  return transcriptRequests(path)!.queued;
};

test("the person's own queued text: not notifications, other agents' or hoop's messages; other text, even in a tag or naming a review, is theirs", () => {
  assert.equal(personQueued(notice), false);
  assert.equal(personQueued('<agent-message from="a1">\nDone\n</agent-message>'), false);
  assert.equal(personQueued(work), false);
  assert.equal(personQueued("Another Claude session sent a message:\nhi"), false);
  assert.equal(personQueued("<b>bold</b> is how I want the title"), true);
  assert.equal(personQueued("Why does hoop_feedback rv_abc1 say approved?"), true);
});

test("a dequeue takes the message the user entry after it holds, not the oldest; a removal, the one with its text, mid-turn", () => {
  const queued = scan(
    [
      // The tail starts after an enqueue: its dequeue and the entry that took it pick up nothing here.
      op(0, "dequeue"),
      typed("u0", 0.5, "P0", "Something queued before the tail", "queued"),
      op(1, "enqueue", "Also add a test"),
      op(2, "enqueue", notice),
      op(3, "enqueue", "And file an issue"),
      op(4, "enqueue", work),
      // Two dequeues at the turn's end: the notification, then the person's second message.
      op(5, "dequeue"),
      op(5, "dequeue"),
      line({
        type: "user",
        uuid: "n1",
        timestamp: iso(6),
        promptId: "P1",
        promptSource: "system",
        origin: { kind: "task-notification" },
        message: { content: notice },
      }),
      typed("u2", 7, "P2", "And file an issue", "queued"),
      // The agent takes the oldest mid-turn.
      op(8, "remove", "Also add a test"),
      absorbed("m1", 9, "Also add a test"),
      op(10, "enqueue", "Rename the flag"),
    ].join(""),
  );
  assert.deepEqual(queued, [
    { text: "Also add a test", at: iso(1), prompt: "P0", picked: iso(8), request: "m1" },
    { text: "And file an issue", at: iso(3), prompt: "P0", picked: iso(5), request: "u2" },
    { text: "Rename the flag", at: iso(10), prompt: "P2" },
  ]);
});

test("a peer's message is queued as bare text: the entry that delivers it, with the socket's opening line and a note, takes it off the person's list", () => {
  const raw = "Please check PR 12 again";
  const queued = scan(
    [
      op(1, "enqueue", raw),
      op(2, "enqueue", "Keep going with the export"),
      op(3, "dequeue"),
      line({
        type: "user",
        uuid: "x1",
        timestamp: iso(3),
        promptId: "P1",
        promptSource: "system",
        origin: { kind: "peer", from: "unknown" },
        isMeta: true,
        message: { content: `Another Claude session sent a message:\n${raw}\n\n${"Reply with SendMessage to answer. ".repeat(15)}` },
      }),
      op(4, "dequeue"),
      line({
        type: "user",
        uuid: "x2",
        timestamp: iso(4),
        promptId: "P2",
        promptSource: "system",
        origin: { kind: "auto-continuation" },
        isMeta: true,
        message: { content: "Keep going with the export" },
      }),
    ].join(""),
  );
  assert.deepEqual(queued, [], "neither was the person's, and neither still waits");
});

test("a peer's message the agent takes mid-turn leaves the person's list once its attachment says it was a peer's", () => {
  const raw = "Done: Merge the export pull request (#12)";
  const queued = scan(
    [
      typed("p1", 0, "P1", "Add CSV export to the orders page"),
      op(1, "enqueue", raw),
      op(2, "enqueue", "Also fix the footer"),
      op(3, "remove", raw),
      line({
        type: "attachment",
        uuid: "m1",
        timestamp: iso(3),
        attachment: { type: "queued_command", prompt: `Another Claude session sent a message:\n${raw}`, origin: { kind: "peer", from: "unknown" } },
      }),
      op(4, "remove", "Also fix the footer"),
      absorbed("m2", 4, "Also fix the footer"),
    ].join(""),
  );
  assert.deepEqual(queued, [{ text: "Also fix the footer", at: iso(2), prompt: "P1", picked: iso(4), request: "m2" }]);
});

test("Claude Code's notice that background agents were stopped is queued as bare text, but isn't the person's", () => {
  const queued = scan(
    [
      typed("p1", 0, "P1", "Add CSV export to the orders page"),
      op(1, "enqueue", "Also fix the footer"),
      op(2, "enqueue", '2 background agents were stopped by the user: "Export", "Footer".'),
      line({ type: "system", subtype: "agents_killed", uuid: "k1", timestamp: iso(2), isMeta: false }),
    ].join(""),
  );
  assert.deepEqual(queued, [{ text: "Also fix the footer", at: iso(1), prompt: "P1" }]);
});

test("a dequeue pairs past a local command's caveat and command entries with the person's queued message", () => {
  const queued = scan(
    [
      typed("p1", 0, "P1", "Add CSV export to the orders page"),
      op(1, "enqueue", "Also fix the footer"),
      op(2, "dequeue"),
      line({
        type: "user",
        uuid: "c1",
        timestamp: iso(2),
        promptId: "P2",
        isMeta: true,
        message: { content: "<local-command-caveat>Caveat: …</local-command-caveat>" },
      }),
      line({
        type: "user",
        uuid: "c2",
        timestamp: iso(2),
        promptId: "P2",
        message: { content: "<command-name>/model</command-name>\n<command-args></command-args>" },
      }),
      typed("u1", 3, "P3", "Also fix the footer", "queued"),
    ].join(""),
  );
  assert.deepEqual(queued, [{ text: "Also fix the footer", at: iso(1), prompt: "P1", picked: iso(2), request: "u1" }]);
});

test("a queued slash command pairs with its command entry", () => {
  const queued = scan(
    [
      typed("p1", 0, "P1", "Add CSV export to the orders page"),
      op(1, "enqueue", "/review PR 12"),
      op(2, "dequeue"),
      line({
        type: "user",
        uuid: "c1",
        timestamp: iso(2),
        promptId: "P2",
        message: { content: "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>PR 12</command-args>" },
      }),
    ].join(""),
  );
  assert.deepEqual(queued, [{ text: "/review PR 12", at: iso(1), prompt: "P1", picked: iso(2), request: "c1" }]);
});

test("popAll takes what still waits back to the prompt: it never reached the agent", () => {
  assert.deepEqual(scan(op(1, "enqueue", "Edited again") + op(2, "popAll")), []);
});

/** A busy session whose transcript holds a message the agent took mid-turn and made a todo of, and one still waiting. */
function seeded(at: (s: number) => string) {
  const home = tempHome();
  const folder = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-proj");
  mkdirSync(folder, { recursive: true });
  const t = (uuid: string, s: number, text: string) =>
    line({ type: "user", uuid, timestamp: at(s), promptId: "P1", promptSource: "typed", origin: { kind: "human" }, message: { content: text } });
  const q = (s: number, operation: string, content?: string) => line({ type: "queue-operation", operation, timestamp: at(s), ...(content ? { content } : {}) });
  writeFileSync(
    join(folder, `${SESSION}.jsonl`),
    t("p1", 0, "Add CSV export to the orders page") +
      q(10, "enqueue", "Also add a JSON export") +
      q(20, "remove", "Also add a JSON export") +
      line({
        type: "attachment",
        uuid: "m1",
        timestamp: at(21),
        attachment: { type: "queued_command", prompt: "Also add a JSON export", origin: { kind: "human" } },
      }) +
      q(30, "enqueue", "And file an issue for the rest"),
  );
  const subject = "Write the JSON export";
  workHook(home, { ...structuredClone(HOOKS["post-taskcreate"]), prompt_id: "P1", tool_input: { subject }, tool_response: { task: { id: "1", subject } } });
  const sessions =
    (status: ClaudeSession["status"] = "busy"): (() => ClaudeSession[]) =>
    () => [{ session: SESSION, pid: 1, status, name: "Order export" }];
  return { home, sessions };
}

test("the Work API gives what still waits while busy, and what was picked up in the last five minutes with the todos it became", () => {
  const { home, sessions } = seeded(iso);
  const now = Date.parse(iso(60));
  const view = (status: ClaudeSession["status"], at = now) => workView(home, sessions(status), at)[0]!.waiting;
  assert.deepEqual(view("busy"), [
    { text: "Also add a JSON export", at: iso(10), picked: iso(20), todos: ["1"] },
    { text: "And file an issue for the rest", at: iso(30) },
  ]);
  assert.deepEqual(
    view("idle")?.map((q) => q.text),
    ["Also add a JSON export"],
    "an idle session has nothing still waiting",
  );
  assert.equal(workView(home, () => [], now)[0]!.waiting, undefined, "an ended session has none");
  assert.deepEqual(
    view("busy", Date.parse(iso(20)) + 6 * 60_000)?.map((q) => q.text),
    ["And file an issue for the rest"],
    "a message picked up over five minutes ago leaves the list",
  );
  assert.equal(view("busy", Date.parse(iso(30)) + 3 * 60 * 60_000), undefined, "nothing reads as waiting after two hours");
  // A later turn that started from another prompt took the queue: what nothing paired no longer waits.
  appendFileSync(
    join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-proj", `${SESSION}.jsonl`),
    line({
      type: "user",
      uuid: "p2",
      timestamp: iso(40),
      promptId: "P2",
      promptSource: "typed",
      origin: { kind: "human" },
      message: { content: "Now ship it" },
    }),
  );
  assert.deepEqual(
    view("busy")?.map((q) => q.text),
    ["Also add a JSON export"],
  );
});

test("the Work page says how many messages wait for the agent, with when each was sent, picked up, and became", { skip: BROWSER_SKIP }, async () => {
  const start = Date.now() - 60_000;
  const { home, sessions } = seeded((s) => new Date(start + s * 1000).toISOString());
  const clock = String.raw`\d{1,2}:\d\d(?:\s?[AP]M)?`;
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/work`);
      const box = page.locator("section.work-session .queued");
      await box.waitFor();
      assert.equal(await box.locator(".queued-head").innerText(), "Waiting for the agent: 1 message");
      const items = box.locator("li");
      assert.match(await items.nth(0).innerText(), new RegExp(`^Also add a JSON export sent ${clock}, picked up ${clock}, became #1 Write the JSON export$`));
      assert.match(await items.nth(1).innerText(), new RegExp(`^And file an issue for the rest sent ${clock}, waiting \\d+ [sm]$`));
    },
    new Hoop(new Store(home)),
    { sessions: sessions() },
  );
});
