import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { type ClaudeSession, editWork, workHook, workView } from "../src/work.js";
import { BROWSER_SKIP, example, hasFocus, tempHome, withBrowser } from "./helpers.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const STALL = "22222222-3333-4444-5555-666666666666";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });

/** A transcript line: a tool call `id` of `name` at `at`, or its result when `result`. */
const call = (at: string, id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (at: string, id: string) => JSON.stringify({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id }] } });

/**
 * Three sessions: one working, whose transcript shows three steps in the last five minutes and whose
 * running todo sits behind two queued ones in the person's order; one working whose transcript went
 * quiet 47 minutes ago; and one ended, newest of all, that left a todo in progress.
 */
function seeded() {
  const home = tempHome();
  const now = Date.now();
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  const folder = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-proj");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, `${SESSION}.jsonl`),
    [
      JSON.stringify({ type: "custom-title", customTitle: "Order export" }),
      call(ago(600), "t0", "Read", { file_path: "/tmp/proj/README.md" }),
      result(ago(599), "t0"),
      call(ago(240), "t1", "Edit", { file_path: "/tmp/proj/web/work.js" }),
      result(ago(239), "t1"),
      call(ago(120), "t2", "Bash", { command: "npm test" }),
      result(ago(100), "t2"),
      call(ago(60), "t3", "Read", { file_path: "/tmp/proj/web/work.js" }),
      result(ago(59), "t3"),
      "",
    ].join("\n"),
  );
  const stallLog = join(folder, `${STALL}.jsonl`);
  writeFileSync(
    stallLog,
    `${JSON.stringify({ type: "custom-title", customTitle: "Docs pass" })}\n${call(ago(47 * 60), "s1", "Read", { file_path: "/tmp/proj/a.md" })}\n${result(ago(47 * 60), "s1")}\n`,
  );
  utimesSync(stallLog, new Date(now - 47 * 60_000), new Date(now - 47 * 60_000));
  const create = (session: string, id: string, subject: string, s: number) =>
    workHook(home, hook("post-taskcreate", { session_id: session, tool_input: { subject }, tool_response: { task: { id, subject } } }), ago(s));
  create(SESSION, "1", "Write the docs", 900);
  create(SESSION, "2", "Open a pull request", 900);
  create(SESSION, "3", "Run the test suite", 900);
  workHook(home, hook("post-taskupdate", { tool_input: { taskId: "3", status: "in_progress" } }), ago(2 * 3600 + 14 * 60));
  editWork(home, SESSION, (r) => {
    r.queue = ["2", "1", "3"];
  });
  create(STALL, "1", "Proofread the guide", 4000);
  workHook(home, hook("post-taskupdate", { session_id: STALL, tool_input: { taskId: "1", status: "in_progress" } }), ago(3000));
  workHook(home, hook("post-todowrite", { session_id: "ended-session", cwd: "/work/other-repo" }), ago(30));
  const sessions: ClaudeSession[] = [
    { session: SESSION, pid: 1, status: "busy", cwd: "/tmp/proj" },
    { session: STALL, pid: 2, status: "busy", cwd: "/tmp/proj" },
  ];
  return { home, sessions, now };
}

test("the Work API gives each session its last activity, what it does now and its last five minutes", () => {
  const { home, sessions, now } = seeded();
  const view = workView(home, () => sessions, now);
  assert.deepEqual(
    view.map((s) => [s.id, s.state]),
    [
      ["ended-session", "ended"],
      [STALL, "busy"],
      [SESSION, "busy"],
    ],
    "the API keeps newest first; the page puts working sessions first",
  );
  const busy = view[2]!;
  // The newest entry is a minute old, but the file was written since: its time counts.
  assert.ok(Date.parse(busy.activity!) >= now - 59_000);
  assert.deepEqual(busy.doing, { what: "reading web/work.js", at: new Date(now - 60_000).toISOString(), open: false });
  assert.deepEqual(
    busy.recent!.map((r) => r.what),
    ["reading web/work.js", "running tests: npm test", "editing web/work.js"],
  );
  assert.equal(view[1]!.activity, new Date(now - 47 * 60_000).toISOString());
  assert.equal(view[1]!.recent, undefined);
  assert.equal(view[0]!.doing, undefined, "an ended session does nothing now");
});

test("the Work page puts what runs first, flags stalled work, says what each session does now, and folds its last five minutes", {
  skip: BROWSER_SKIP,
}, async () => {
  const { home, sessions } = seeded();
  const hoop = new Hoop(new Store(home));
  hoop.submit(example());
  await withBrowser(
    async ({ base, page }) => {
      await page.addInitScript(() => ((window as unknown as { HOOP_WORK_MS: number }).HOOP_WORK_MS = 200));
      await page.goto(`${base}/work`);
      await page.locator("section.work-session").first().waitFor();
      // Working sessions first, though the ended one changed last.
      assert.deepEqual(await page.locator("section.work-session h2").allInnerTexts(), ["Docs pass", "Order export", "Unnamed session"]);
      const counts = page.locator(".work-counts");
      await page.waitForFunction(() => /waiting on you/.test(document.querySelector(".work-counts")?.textContent ?? ""));
      assert.equal(await counts.innerText(), "1 running · 2 stalled · 1 waiting on you");

      // The running todo comes first; the queued ones keep the person's order.
      const busy = page.locator("section.work-session").nth(1);
      assert.deepEqual(await busy.locator("ol.todos").first().locator(".t").allInnerTexts(), ["Run the test suite", "Open a pull request", "Write the docs"]);
      const running = busy.locator(".todo").first();
      assert.match(await running.innerText(), /Running\s*Run the test suite\s*running for 2 h 1[45] m · last activity \d+ s ago/);

      // Now, and the last five minutes, newest first, folded until opened and open across polls.
      assert.match(await busy.locator(".now").innerText(), /^Now: reading web\/work\.js 1 m ago$/);
      const recent = busy.locator("details.recent");
      assert.equal(await recent.getAttribute("open"), null);
      await recent.locator("summary").click();
      assert.deepEqual(await recent.locator(".steps .what").allInnerTexts(), ["reading web/work.js", "running tests: npm test", "editing web/work.js"]);
      await page.waitForTimeout(500);
      assert.notEqual(await busy.locator("details.recent").getAttribute("open"), null);

      // A todo whose session went quiet is stalled; one an ended session left is not running.
      const stalled = page.locator("section.work-session").first().locator(".todo").first();
      assert.match(await stalled.innerText(), /Stalled\s*Proofread the guide.*\nStalled: no activity for 47 m/s);
      const left = page.locator("section.work-session").nth(2).locator(".todo").first();
      assert.match(
        await left.innerText(),
        /Not running\s*Running tests\s*marked running for \d+ s.*Not running: the session ended; this todo was left in progress/s,
      );

      // The stalled count goes to the first stalled todo, opening its session if folded.
      await page.getByRole("button", { name: "Docs pass" }).click();
      await stalled.waitFor({ state: "hidden" });
      await page.locator(".work-counts a", { hasText: "stalled" }).click();
      assert.ok(await hasFocus(page.locator(`#todo-${STALL}-1`)));
    },
    hoop,
    { sessions: () => sessions },
  );
});
