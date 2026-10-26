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

// Each todo records the request of the turn that created it, by the turn's prompt ID, and the Work
// page lists a session's requests with the todos each became, flagging a prompt whose turn changed
// things without a todo (#209). The transcript entries below have the shapes Claude Code 2.1 writes.

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = HOOKS["post-taskcreate"].session_id as string;
const iso = (s: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, s)).toISOString();
const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const user = (uuid: string, s: number, prompt: string, content: unknown, extra: object = {}) =>
  line({ type: "user", uuid, timestamp: iso(s), promptId: prompt, message: { role: "user", content }, ...extra });
/** A prompt the person typed, starting turn `prompt`. */
const typed = (uuid: string, s: number, prompt: string, text: string) => user(uuid, s, prompt, text, { promptSource: "typed", origin: { kind: "human" } });
/** hoop's message over the session socket: Claude Code writes it as a meta entry from a peer. */
const peer = (uuid: string, s: number, prompt: string, text: string) =>
  user(uuid, s, prompt, `Another Claude session sent a message:\n${text}`, { promptSource: "system", origin: { kind: "peer", from: "unknown" }, isMeta: true });
const wake = (uuid: string, s: number, prompt: string, review: string) =>
  peer(uuid, s, prompt, `ankur reviewed "Plan" in hoop: approved, 0 comments. Read it with hoop_feedback ${review} then go on.`);
const notice = (uuid: string, s: number, prompt: string) =>
  user(uuid, s, prompt, "<task-notification>\n<status>completed</status>\n</task-notification>", {
    promptSource: "system",
    origin: { kind: "task-notification" },
  });
const result = (s: number, prompt: string) => user(`r${s}`, s, prompt, [{ type: "tool_result", tool_use_id: `t${s}`, content: "ok" }]);
const calls = (s: number, ...names: string[]) =>
  line({ type: "assistant", timestamp: iso(s), message: { content: names.map((name, n) => ({ type: "tool_use", id: `t${s}${n}`, name, input: {} })) } });

/** A transcript in the temp Claude Code folder for SESSION. */
function transcriptOf(text: string) {
  const folder = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-proj");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${SESSION}.jsonl`);
  writeFileSync(path, text);
  return path;
}

/** The agent creates todo `id` in the turn `prompt`, as the TaskCreate hook reports it. */
const created = (home: string, id: string, subject: string, prompt: string, extra: object = {}, now = iso(100)) =>
  workHook(
    home,
    { ...structuredClone(HOOKS["post-taskcreate"]), prompt_id: prompt, tool_input: { subject }, tool_response: { task: { id, subject } }, ...extra },
    now,
  );

/** A Work message as hoop sends it, with its reference on the last line. */
const workMessage = (ref: string) =>
  `${steerMessage([{ id: "ch_1", kind: "comment", todo: "1", subject: "Write the exporter", was: "queued", text: "Use semicolons", by: "ankur", at: iso(0), delivery: "pending" }])}\n\n(hoop-ref ${ref})`;

test("a transcript's requests, by who sent them: prompts, slash commands, and hoop's wakes, Work messages and action items in hoop's own format", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hoop-requests-")), "t.jsonl");
  writeFileSync(
    path,
    [
      typed("u1", 1, "P1", "Add CSV export\nwith a header row"),
      result(2, "P1"),
      user("u3", 3, "P1", [{ type: "text", text: "Base directory for this skill: …" }], { isMeta: true }),
      notice("u5", 5, "P2"),
      wake("u6", 6, "P3", "rv_plan0001"),
      peer("u7", 7, "P4", workMessage("st_abc123")),
      // Another agent repeating a Work message is the agent's, not the person's change.
      peer("u8", 8, "P5", `<agent-message from="a1">\n${workMessage("st_abc123")}\n</agent-message>`),
      // A person's prompt that mentions a review is still their prompt.
      typed("u9", 9, "P6", "Why did hoop_feedback rv_plan0001 say approved?"),
      peer("u10", 10, "P7", "Done: Merge the CSV export pull request\n\n(hoop-action ac_merge01)"),
      // A slash command: its caveat note comes first, under the same prompt ID.
      user("u11", 11, "P8", "<local-command-caveat>Caveat: …</local-command-caveat>", { isMeta: true }),
      user("u12", 12, "P8", "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>PR 12</command-args>"),
      // Local commands: one with no prompt ID, and one its output follows.
      user("u13", 13, "", "<command-name>/model</command-name>\n<command-args></command-args>", { promptId: undefined }),
      user("u14", 14, "P9", "<command-name>/clear</command-name>\n<command-args></command-args>"),
      user("u15", 15, "P9", "<local-command-stdout></local-command-stdout>"),
      user("u16", 16, "P10", "This session is being continued from a previous conversation …", { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    ].join(""),
  );
  const scan = transcriptRequests(path)!;
  assert.deepEqual(
    scan.requests.map((r) => [r.id, r.kind, r.review ?? r.ref ?? r.action ?? r.text]),
    [
      ["u1", "prompt", "Add CSV export\nwith a header row"],
      ["u6", "review", "rv_plan0001"],
      ["u7", "change", "st_abc123"],
      ["u9", "prompt", "Why did hoop_feedback rv_plan0001 say approved?"],
      ["u10", "action", "ac_merge01"],
      ["u12", "prompt", "/review PR 12"],
    ],
  );
  assert.deepEqual(
    [...scan.turns],
    [
      ["P1", "u1"],
      ["P2", null],
      ["P3", "u6"],
      ["P4", "u7"],
      ["P5", null],
      ["P6", "u9"],
      ["P7", "u10"],
      ["P8", "u12"],
      ["P9", null],
    ],
    "a compaction summary starts no turn",
  );
  assert.equal(transcriptRequests(join(path, "missing")), undefined);
});

test("older transcripts, with no prompt IDs or origins: plain text is a prompt, and hoop's messages are known by their format", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hoop-requests-")), "t.jsonl");
  const plain = (uuid: string, s: number, content: string) => line({ type: "user", uuid, timestamp: iso(s), message: { content } });
  writeFileSync(path, plain("o1", 1, "Fix the typo") + plain("o2", 2, workMessage("st_old0001")) + plain("o3", 3, "<task-notification>x</task-notification>"));
  const scan = transcriptRequests(path)!;
  assert.deepEqual(
    scan.requests.map((r) => [r.id, r.kind]),
    [
      ["o1", "prompt"],
      ["o2", "change"],
    ],
  );
  assert.equal(scan.current, "o2", "a notification with no origin asks nothing");
});

test("a request taken mid-turn is the turn's request from then on: the todos created after it are its", () => {
  const home = tempHome();
  const mid = (uuid: string, s: number, text: string, origin: string) =>
    line({ type: "attachment", uuid, timestamp: iso(s), attachment: { type: "queued_command", prompt: text, origin: { kind: origin } } });
  const path = transcriptOf(typed("p1", 1, "P1", "Add CSV export to the orders page") + calls(2, "TaskCreate"));
  created(home, "1", "Write the exporter", "P1");
  appendFileSync(path, mid("m1", 3, "Also add a JSON export next to it", "human") + calls(4, "TaskCreate"));
  created(home, "2", "Write the JSON export", "P1");
  appendFileSync(path, mid("m2", 5, `Another Claude session sent a message:\n${workMessage("st_mid0001")}`, "peer") + calls(6, "TaskCreate"));
  created(home, "3", "Use semicolons", "P1");
  const by = readWork(home, SESSION)!.todos.map((t) => (t.source && "request" in t.source ? [t.source.request, t.source.kind] : undefined));
  assert.deepEqual(by, [
    ["p1", "prompt"],
    ["m1", "prompt"],
    ["m2", "change"],
  ]);
  assert.equal(transcriptRequests(path)!.requests.find((q) => q.id === "m1")!.mid, true);
});

test("a todo takes the request before its call, though its hook lands after a later one was taken mid-turn (#269)", () => {
  const home = tempHome();
  const mid = (uuid: string, s: number, text: string) =>
    line({ type: "attachment", uuid, timestamp: iso(s), attachment: { type: "queued_command", prompt: text, origin: { kind: "human" } } });
  // A is taken mid-turn, the agent calls TaskCreate, then B is taken before that call's hook arrives.
  const path = transcriptOf(
    typed("p1", 1, "P1", "Add CSV export to the orders page") +
      mid("ma", 2, "Also add a JSON export next to it") +
      calls(3, "TaskCreate") +
      mid("mb", 4, "And an XML export too please"),
  );
  created(home, "1", "Write the JSON export", "P1", { tool_use_id: "t30" });
  appendFileSync(path, calls(5, "TaskCreate"));
  created(home, "2", "Write the XML export", "P1", { tool_use_id: "t50" });
  const r = readWork(home, SESSION)!;
  const src = (id: string) => {
    const s = r.todos.find((t) => t.id === id)!.source;
    return s && "request" in s ? s.request : s?.kind;
  };
  assert.deepEqual(["1", "2"].map(src), ["ma", "mb"]);
  const view = workView(home, () => [{ session: SESSION, pid: 1, status: "idle" }])[0]!;
  assert.deepEqual(
    view.requests!.map((q) => [q.id, q.todos]),
    [
      ["p1", []],
      ["ma", ["1"]],
      ["mb", ["2"]],
    ],
  );
});

/** A message the person sent, taken mid-turn. */
const taken = (uuid: string, s: number, text: string) =>
  line({ type: "attachment", uuid, timestamp: iso(s), attachment: { type: "queued_command", prompt: text, origin: { kind: "human" } } });
/** The source a todo has: its request's ID, or "agent". */
const sourceIn = (home: string, id: string) => {
  const s = readWork(home, SESSION)!.todos.find((t) => t.id === id)!.source;
  return s && "request" in s ? s.request : s?.kind;
};

test("a todo whose call came in a turn nobody asked for is the agent's, though a request is taken before its hook (#269)", () => {
  const home = tempHome();
  transcriptOf(notice("n1", 1, "P1") + calls(2, "TaskCreate") + taken("ma", 3, "Also add a JSON export next to it"));
  created(home, "1", "Tidy up", "P1", { tool_use_id: "t20" });
  assert.equal(sourceIn(home, "1"), "agent");
});

test("TodoWrite's new todos take the request before its call, though its hook lands after a later one was taken mid-turn (#269)", () => {
  const home = tempHome();
  transcriptOf(
    typed("p1", 1, "P1", "Add CSV export to the orders page") +
      taken("ma", 2, "Also add a JSON export next to it") +
      calls(3, "TodoWrite") +
      taken("mb", 4, "And an XML export too please"),
  );
  workHook(home, {
    ...structuredClone(HOOKS["post-todowrite"]),
    prompt_id: "P1",
    tool_use_id: "t30",
    tool_input: { todos: [{ content: "Write the JSON export", status: "pending", activeForm: "Writing the JSON export" }] },
  });
  const t = readWork(home, SESSION)!.todos;
  assert.deepEqual(
    t.map((x) => [x.text, x.source && "request" in x.source ? x.source.request : x.source?.kind]),
    [["Write the JSON export", "ma"]],
  );
});

test("a hook that lands before its call is in the transcript falls back to its turn's latest request (#269)", () => {
  const home = tempHome();
  const path = transcriptOf(typed("p1", 1, "P1", "Add CSV export to the orders page") + taken("ma", 2, "Also add a JSON export next to it"));
  created(home, "1", "Write the JSON export", "P1", { tool_use_id: "t30" });
  appendFileSync(path, calls(3, "TaskCreate"));
  assert.equal(sourceIn(home, "1"), "ma");
});

test("todos take their turn's request by prompt ID: a prompt's two, a wake turn's, a notification turn's, a subagent's, and one an update made first", () => {
  const home = tempHome();
  const path = transcriptOf(typed("p1", 1, "P1", "Add CSV export to the orders page") + calls(2, "TaskCreate", "TaskCreate"));
  created(home, "1", "Write the exporter", "P1");
  created(home, "2", "Test the exporter", "P1");
  // A later update and a TaskList keep the source; a TaskList's todos the hooks never saw created get none.
  workHook(home, { ...structuredClone(HOOKS["post-taskupdate"]), prompt_id: "P1", tool_input: { taskId: "1", status: "in_progress" } }, iso(4));
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
  appendFileSync(path, wake("w1", 10, "P2", "rv_plan0001") + calls(11, "TaskCreate") + notice("n1", 12, "P3") + calls(13, "TaskCreate"));
  created(home, "3", "Build PR 1", "P2");
  created(home, "4", "Tidy up", "P3");
  // A subagent's hook gives the main turn's prompt ID.
  created(home, "5", "Check the docs", "P1", { agent_id: "a1b2c3d4e5f607182", agent_type: "Explore" });
  // An update that arrived before its creation made the todo first; the creation still gives it a source.
  workHook(home, { ...structuredClone(HOOKS["post-taskupdate"]), prompt_id: "P2", tool_input: { taskId: "6", status: "in_progress" } }, iso(14));
  created(home, "6", "Build PR 2", "P2");
  // A turn the transcript doesn't hold leaves the source unknown.
  created(home, "7", "Elsewhere", "P9");
  const r = readWork(home, SESSION)!;
  const src = (id: string) => {
    const s = r.todos.find((t) => t.id === id)!.source;
    return s && s.kind !== "agent" ? [s.kind, s.request] : s?.kind;
  };
  assert.deepEqual(["1", "2", "9", "3", "4", "5", "6", "7"].map(src), [
    ["prompt", "p1"],
    ["prompt", "p1"],
    undefined,
    ["review", "w1"],
    "agent",
    ["prompt", "p1"],
    ["review", "w1"],
    undefined,
  ]);
  assert.equal(r.todos.find((t) => t.id === "3")!.source!.at, iso(10));
});

test("TodoWrite's new todos take a source by text, not by place; one with an old one's text gets its own; a rename keeps it", () => {
  const home = tempHome();
  transcriptOf(
    typed("p1", 1, "P1", "Plan the release notes for this week") +
      typed("p2", 5, "P2", "Also add the migration guide please") +
      typed("p3", 6, "P3", "Draft the notes again for the beta"),
  );
  const write = (prompt: string, todos: string[]) =>
    workHook(home, {
      ...structuredClone(HOOKS["post-todowrite"]),
      prompt_id: prompt,
      tool_input: { todos: todos.map((content) => ({ content, status: "pending", activeForm: content })) },
    });
  write("P1", ["Draft the notes"]);
  write("P2", ["Write the guide", "Draft the notes"]);
  const sources = () => readWork(home, SESSION)!.todos.map((t) => [t.text, t.source && "request" in t.source ? t.source.request : undefined]);
  assert.deepEqual(sources(), [
    ["Write the guide", "p2"],
    ["Draft the notes", "p1"],
  ]);
  write("P3", ["Write the guide", "Draft the notes", "Draft the notes"]);
  assert.deepEqual(sources().at(-1), ["Draft the notes", "p3"], "a second todo with the same text is new");
  write("P3", ["Write the migration guide", "Draft the notes", "Draft the notes"]);
  assert.deepEqual(sources()[0], ["Write the migration guide", "p2"], "renamed in its place, it keeps its source");
});

test("only a prompt whose turn changed things without a todo is not registered; dismissing it holds; asking the agent registers it", () => {
  const home = tempHome();
  const path = transcriptOf("");
  created(home, "1", "Read the code", "P0", {}, iso(0));
  appendFileSync(
    path,
    typed("p1", 1, "P1", "Add CSV export to the orders page") +
      calls(2, "TaskCreate") +
      typed("p2", 3, "P2", "Also rename the flag in the settings page") +
      calls(4, "Edit", "Bash") +
      typed("p3", 5, "P3", "thanks, looks good") +
      calls(6, "Edit") +
      typed("p4", 7, "P4", "how does the export handle archived orders") +
      calls(8, "Edit") +
      typed("p6", 8.2, "P6", "Run the full test suite on the branch") +
      calls(8.4, "Bash") +
      typed("p7", 8.6, "P7", "Finish the export and mark its todo done") +
      calls(8.8, "Edit", "TaskUpdate") +
      typed("p5", 9, "P5", "Write the changelog entry for this release") +
      calls(10, "Write"),
  );
  created(home, "2", "Write the CSV exporter", "P1");
  const view = (status: ClaudeSession["status"] = "idle") => workView(home, () => [{ session: SESSION, pid: 1, status }])[0]!;
  assert.deepEqual(
    view().requests!.map((q) => [q.id, q.todos, Boolean(q.unregistered)]),
    [
      ["p1", ["2"], false],
      ["p2", [], true],
      // A short reply and a question, even one without its "?", aren't flagged, though their turns edited files.
      ["p3", [], false],
      ["p4", [], false],
      // A turn that only ran commands, and one that updated a todo, aren't either.
      ["p6", [], false],
      ["p7", [], false],
      ["p5", [], true],
    ],
  );
  // While the session works on it, the latest request isn't flagged yet.
  assert.equal(view("busy").requests!.at(-1)!.unregistered, undefined);
  editWork(home, SESSION, (r) => void (r.dismissed = ["p5"]));
  assert.equal(view().requests!.at(-1)!.dismissed, true);
  assert.equal(view().requests!.at(-1)!.unregistered, undefined);

  // Asking the agent sends a comment about the request; the todo created in the turn of that message counts for it.
  const [ask] = addChanges(home, SESSION, [{ kind: "comment", request: "p2", text: "Register todos for it" }], { by: "ankur", reachable: true, now: iso(11) })!;
  assert.equal(ask!.subject, "Also rename the flag in the settings page");
  assert.match(steerMessage([ask!]), /About your request "Also rename the flag in the settings page", which no todo came from: "Register todos for it"/);
  editWork(home, SESSION, (r) => void Object.assign(r.changes![0]!, { delivery: "sent", ref: "st_ask0001" }));
  appendFileSync(path, peer("m1", 12, "P8", workMessage("st_ask0001")) + calls(13, "TaskCreate"));
  created(home, "3", "Rename the flag", "P8");
  assert.deepEqual(view().requests!.find((q) => q.id === "p2")!.todos, ["3"]);
  editWork(home, SESSION, (r) => settle(r, iso(14)));
  assert.equal(readWork(home, SESSION)!.changes![0]!.delivery, "seen");
  assert.throws(() => addChanges(home, SESSION, [{ kind: "comment", request: "nope", text: "x" }], { reachable: true }), /no request nope/);
});

test("only a prompt's first line, at most 200 characters, is stored on a todo", () => {
  const home = tempHome();
  transcriptOf(typed("p1", 1, "P1", `${"word ".repeat(60)}\nsecond line with more`));
  created(home, "1", "Do it", "P1");
  const s = readWork(home, SESSION)!.todos[0]!.source!;
  assert.ok("text" in s && s.text.length <= 200 && !s.text.includes("second line"));
});

test("the Work page shows each todo's source, the shared one once, and the Requests fold; Dismiss keeps the focus in place", {
  skip: BROWSER_SKIP,
}, async () => {
  const home = tempHome();
  const hoop = new Hoop(new Store(home));
  const { review_id } = hoop.submit({ ...example(), slug: "plan", title: "Export plan" });
  const path = transcriptOf("");
  created(home, "0", "Read the code", "P0", {}, iso(0));
  appendFileSync(path, typed("p1", 1, "P1", "Add CSV export") + calls(2, "TaskCreate", "TaskCreate", "TaskCreate", "TaskCreate"));
  for (const [n, subject] of ["Write the exporter", "Test it", "Document it", "Release it"].entries()) created(home, String(n + 1), subject, "P1");
  appendFileSync(
    path,
    wake("w1", 10, "P2", review_id) + calls(11, "TaskCreate") + typed("p2", 12, "P3", "Also rename the flag in the settings page") + calls(13, "Edit"),
  );
  created(home, "5", "Build PR 1", "P2");
  // A todo from a turn nobody asked for says so, though most todos share a source.
  appendFileSync(path, notice("n1", 14, "P4") + calls(15, "TaskCreate"));
  created(home, "6", "Tidy up", "P4");
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/work`);
      const s = page.locator("section.work-session");
      await s.waitFor();
      assert.match(await s.locator(".up-next", { hasText: "Source:" }).innerText(), /^Source: most todos from “Add CSV export” \d{1,2}:\d\d(\s?[AP]M)?$/);
      // Rows with the shared source leave it out; the others show theirs.
      assert.deepEqual(await s.locator(".todo .why", { hasText: /^(from|added by)/ }).allInnerTexts(), ["from review Export plan", "added by the agent"]);
      await s.locator("details.requests > summary").click();
      assert.equal(await s.locator("details.requests > summary").innerText(), "Requests");
      const reqs = s.locator(".request");
      assert.match(await reqs.nth(0).innerText(), /You asked Add CSV export.*#1 Write the exporter.*0 of 4 done/s);
      assert.match(await reqs.nth(1).innerText(), /Review Export plan.*#5 Build PR 1/s);
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
