import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { transcriptRequests } from "../src/requests.js";
import { addChanges, steerMessage } from "../src/steer.js";
import { Store } from "../src/store.js";
import { type ClaudeSession, editWork, readWork, settle, workHook, workView } from "../src/work.js";
import { BROWSER_SKIP, example, hasFocus, tempHome, withBrowser } from "./helpers.js";

// Each todo records the request its turn answered when the agent creates it, and the Work page lists
// a session's requests with the todos each became, flagging a prompt no todo came from (#209).

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = HOOKS["post-taskcreate"].session_id as string;
const iso = (s: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();
const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const human = (uuid: string, at: string, content: unknown) =>
  line({ type: "user", uuid, timestamp: at, origin: { kind: "human" }, message: { role: "user", content } });
const create = (at: string, call: string) =>
  line({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: call, name: "TaskCreate", input: {} }] } });
const notice = (uuid: string, at: string) =>
  line({ type: "user", uuid, timestamp: at, origin: { kind: "task-notification" }, message: { content: "<task-notification>done</task-notification>" } });
const wake = (uuid: string, at: string, review: string) =>
  line({
    type: "user",
    uuid,
    timestamp: at,
    origin: { kind: "peer" },
    message: {
      content: `Another Claude session sent a message:\nankur reviewed "Plan" in hoop: approved, 0 comments. Read it with hoop_feedback ${review} then go on.`,
    },
  });

/** A transcript in the temp Claude Code folder for SESSION. */
function transcriptOf(text: string) {
  const folder = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-proj");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${SESSION}.jsonl`);
  writeFileSync(path, text);
  return path;
}

/** The agent creates todo `id` in the tool call `call`. */
const created = (home: string, id: string, subject: string, call: string, now = iso(100)) =>
  workHook(home, { ...structuredClone(HOOKS["post-taskcreate"]), tool_use_id: call, tool_input: { subject }, tool_response: { task: { id, subject } } }, now);

test("a transcript's requests: the person's prompts and mid-turn messages, hoop's wakes and Work messages; nothing else", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hoop-requests-")), "t.jsonl");
  writeFileSync(
    path,
    [
      human("u1", iso(1), "Add CSV export\nwith a header row"),
      line({ type: "user", uuid: "u2", timestamp: iso(2), message: { content: [{ type: "tool_result", tool_use_id: "x" }] } }),
      line({ type: "user", uuid: "u3", timestamp: iso(3), isMeta: true, message: { content: "Base directory for this skill" } }),
      line({ type: "user", uuid: "u4", timestamp: iso(4), message: { content: "<command-name>/clear</command-name>" } }),
      line({ type: "attachment", uuid: "u5", timestamp: iso(5), attachment: { type: "queued_command", prompt: "also JSON", origin: { kind: "human" } } }),
      notice("u6", iso(6)),
      wake("u7", iso(7), "rv_plan0001"),
      line({ type: "user", uuid: "u8", timestamp: iso(8), message: { content: "From ankur via hoop's Work view: …\n\n(hoop-ref st_abc123)" } }),
      // Older transcripts mark no origin: plain text is a prompt.
      line({ type: "user", uuid: "u9", timestamp: iso(9), message: { content: "Fix the typo" } }),
    ].join(""),
  );
  const scan = transcriptRequests(path)!;
  assert.deepEqual(
    scan.requests.map((r) => [r.id, r.kind, r.review ?? r.ref ?? r.text]),
    [
      ["u1", "prompt", "Add CSV export\nwith a header row"],
      ["u5", "prompt", "also JSON"],
      ["u7", "review", "rv_plan0001"],
      ["u8", "change", "st_abc123"],
      ["u9", "prompt", "Fix the typo"],
    ],
  );
  assert.equal(transcriptRequests(join(path, "missing")), undefined);
});

test("two todos from one prompt both carry it; a todo from a wake turn carries the review; one from a notification's turn, the agent", () => {
  const home = tempHome();
  const path = transcriptOf(human("p1", iso(1), "Add CSV export") + create(iso(2), "c1") + create(iso(3), "c2"));
  created(home, "1", "Write the exporter", "c1");
  created(home, "2", "Test the exporter", "c2");
  // A later update and a TaskList keep the source; a TaskList's todos the hooks never saw created get none.
  workHook(home, { ...structuredClone(HOOKS["post-taskupdate"]), tool_input: { taskId: "1", status: "in_progress" } }, iso(4));
  workHook(
    home,
    {
      ...structuredClone(HOOKS["post-tasklist"]),
      tool_response: {
        tasks: [
          { id: "1", subject: "Write the exporter", status: "in_progress" },
          { id: "2", subject: "Test the exporter", status: "pending" },
          { id: "9", subject: "Old", status: "pending" },
        ],
      },
    },
    iso(5),
  );
  let r = readWork(home, SESSION)!;
  assert.deepEqual(
    r.todos.map((t) => [t.id, t.source?.kind, t.source && "request" in t.source ? t.source.request : undefined]),
    [
      ["1", "prompt", "p1"],
      ["2", "prompt", "p1"],
      ["9", undefined, undefined],
    ],
  );
  appendFileSync(path, wake("w1", iso(10), "rv_plan0001") + create(iso(11), "c3") + notice("n1", iso(12)) + create(iso(13), "c4"));
  created(home, "3", "Build PR 1", "c3");
  created(home, "4", "Tidy up", "c4");
  r = readWork(home, SESSION)!;
  assert.deepEqual(r.todos.find((t) => t.id === "3")!.source, {
    kind: "review",
    at: iso(10),
    review: "rv_plan0001",
    request: "w1",
    text: 'ankur reviewed "Plan" in hoop: approved, 0 comments. Read it with hoop_feedback rv_plan0001 then go on.',
  });
  assert.equal(r.todos.find((t) => t.id === "4")!.source?.kind, "agent");
});

test("a prompt no todo came from is not registered until dismissed; asking the agent registers it once a todo comes from that message", () => {
  const home = tempHome();
  const path = transcriptOf("");
  created(home, "1", "Write the exporter", "c0", iso(0));
  appendFileSync(
    path,
    human("p1", iso(1), "Add CSV export") + create(iso(2), "c1") + human("p2", iso(3), "Also file an issue for JSON") + human("p3", iso(4), "Thanks"),
  );
  created(home, "2", "Write the CSV exporter", "c1");
  const view = (status: ClaudeSession["status"] = "idle") => workView(home, () => [{ session: SESSION, pid: 1, status }])[0]!;
  assert.deepEqual(
    view().requests!.map((q) => [q.id, q.todos, Boolean(q.unregistered)]),
    [
      ["p1", ["2"], false],
      ["p2", [], true],
      ["p3", [], true],
    ],
  );
  // While the session works on it, the latest request isn't flagged yet.
  assert.equal(view("busy").requests!.at(-1)!.unregistered, undefined);
  editWork(home, SESSION, (r) => void (r.dismissed = ["p3"]));
  assert.deepEqual(view().requests!.at(-1), { ...view().requests!.at(-1)!, dismissed: true });
  assert.equal(view().requests!.at(-1)!.unregistered, undefined);

  // Asking the agent sends a comment about the request; the todo created from that message counts for it.
  const [ask] = addChanges(home, SESSION, [{ kind: "comment", request: "p2", text: "Register todos for it" }], { by: "ankur", reachable: true, now: iso(5) })!;
  assert.match(steerMessage([ask!]), /About your request "Also file an issue for JSON", which no todo came from: "Register todos for it"/);
  editWork(home, SESSION, (r) => void Object.assign(r.changes![0]!, { delivery: "sent", ref: "st_ask0001" }));
  appendFileSync(
    path,
    line({ type: "user", uuid: "m1", timestamp: iso(6), message: { content: "From ankur … (hoop-ref st_ask0001)" } }) + create(iso(7), "c5"),
  );
  created(home, "5", "File the JSON issue", "c5");
  assert.deepEqual(view().requests!.find((q) => q.id === "p2")!.todos, ["5"]);
  editWork(home, SESSION, (r) => settle(r, iso(8)));
  assert.equal(readWork(home, SESSION)!.changes![0]!.delivery, "seen");
  assert.throws(() => addChanges(home, SESSION, [{ kind: "comment", request: "nope", text: "x" }], { reachable: true }), /no request nope/);
});

test("the Work page shows each todo's source, the shared one once, and the Requests fold; Dismiss keeps the focus in place", {
  skip: BROWSER_SKIP,
}, async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home));
  const { review_id } = hoop.submit({ ...example(), slug: "plan", title: "Export plan" });
  const path = transcriptOf("");
  created(home, "0", "Read the code", "c0", iso(0));
  appendFileSync(path, human("p1", iso(1), "Add CSV export") + ["c1", "c2", "c3"].map((c, n) => create(iso(2 + n), c)).join(""));
  for (const [n, subject] of ["Write the exporter", "Test it", "Document it"].entries()) created(home, String(n + 1), subject, `c${n + 1}`);
  appendFileSync(path, wake("w1", iso(10), review_id) + create(iso(11), "c4") + human("p2", iso(12), "Also file an issue for JSON"));
  created(home, "4", "Build PR 1", "c4");
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/work`);
      const s = page.locator("section.work-session");
      await s.waitFor();
      assert.match(await s.locator(".up-next", { hasText: "Source:" }).innerText(), /^Source: most todos from “Add CSV export” \d\d?:\d\d( [AP]M)?$/);
      // Rows with the shared source leave it out; the others show theirs.
      assert.deepEqual(await s.locator(".todo .why", { hasText: /^(from|added by)/ }).allInnerTexts(), ["added by the agent", "from review Export plan"]);
      await s.locator("details.requests > summary").click();
      assert.equal(await s.locator("details.requests > summary").innerText(), "Requests (1 not registered)");
      const reqs = s.locator(".request");
      assert.match(await reqs.nth(0).innerText(), /You asked Add CSV export.*#1 Write the exporter.*0 of 3 done/s);
      assert.match(await reqs.nth(1).innerText(), /Review Export plan.*#4 Build PR 1/s);
      assert.match(await reqs.nth(2).innerText(), /Not registered: no todo came from it\./);
      await reqs
        .nth(2)
        .getByRole("button", { name: /^Dismiss/ })
        .click();
      await reqs.nth(2).locator(".why", { hasText: "Dismissed" }).waitFor();
      assert.ok(await hasFocus(page.locator(`li.request[data-key="${SESSION}|request|p2"]`)));
      assert.deepEqual(readWork(home, SESSION)!.dismissed, ["p2"]);
    },
    hoop,
    { sessions: () => [{ session: SESSION, pid: 1, status: "idle" }] },
  );
});
