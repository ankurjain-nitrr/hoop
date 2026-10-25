import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { failReason, outcomeOf, plainStep, reportLinks } from "../src/subagents.js";
import { type ClaudeSession, readWork, workHook, workView } from "../src/work.js";
import { BROWSER_SKIP, hasFocus, tempHome, withBrowser } from "./helpers.js";

// The Work page lists only the agents an Agent call started, in plain words. Claude Code's helper
// transcripts (summaries, titles, classifiers) sit beside them in `subagents/` and stay hidden.

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const SESSION = "11111111-2222-3333-4444-555555555555";
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ ...structuredClone(HOOKS[name]), ...extra });
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

const entry = (type: "user" | "assistant", content: unknown, extra: object = {}) =>
  JSON.stringify({ type, isSidechain: true, timestamp: ago(5), message: { role: type, content }, ...extra });
const ask = (text: string) => entry("user", text);
const use = (name: string, input: object, id = `toolu_${name}`) => entry("assistant", [{ type: "tool_use", id, name, input }]);

/**
 * A session folder as Claude Code keeps it, in HOOP_CLAUDE_DIR: four agents an Agent call started
 * (running, done with a handed-back report, done with plain last words, failed), each with its meta
 * file, and three helper transcripts with neither a meta file nor an Agent call.
 */
function seed() {
  const home = tempHome();
  const folder = join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-proj");
  const subagents = join(folder, SESSION, "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(folder, `${SESSION}.jsonl`), `${JSON.stringify({ type: "custom-title", customTitle: "Order export" })}\n`);
  const agent = (id: string, lines: string[], meta?: object) => {
    const path = join(subagents, `agent-${id}.jsonl`);
    writeFileSync(path, `${lines.join("\n")}\n`);
    if (meta) writeFileSync(join(subagents, `agent-${id}.meta.json`), JSON.stringify({ agentType: "general-purpose", isBuiltIn: true, ...meta }));
    return path;
  };
  const transcript_path = join(folder, `${SESSION}.jsonl`);
  const base = { transcript_path, cwd: "/tmp/proj" };
  const start = (id: string, call: string, description: string, s: number) => {
    workHook(home, hook("pre-agent", { ...base, tool_use_id: call, tool_input: { description, prompt: "…", subagent_type: "general-purpose" } }), ago(s));
    workHook(home, hook("subagent-start", { ...base, agent_id: id, agent_type: "general-purpose" }), ago(s));
  };
  const stop = (id: string, s: number, last?: string) =>
    workHook(
      home,
      hook("subagent-stop", {
        ...base,
        agent_id: id,
        agent_type: "general-purpose",
        agent_transcript_path: join(subagents, `agent-${id}.jsonl`),
        ...(last ? { last_assistant_message: last } : {}),
      }),
      ago(s),
    );

  // Running: its current step names a file, so only its description and duration show.
  agent("a0running", [ask("Fix the gone PRs"), use("Read", { file_path: "/tmp/proj/src/prs.ts" })], { description: "Fix: deleted PRs stay Pending" });
  start("a0running", "toolu_run", "Fix: deleted PRs stay Pending", 720);
  // Done, with a report handed back.
  const report =
    "Opened PR https://github.com/acme/shop/pull/214: Home now shows a deleted PR as Gone. Tests pass.\n\nI changed /Users/me/Projects/shop/src/prs.ts and test/prs.test.ts. Review: http://localhost:4747/r/rv_abc123";
  agent("a1handback", [ask("Fix #183"), use("Bash", { command: "gh pr create" }), use("SubagentHandback", { message: report })], {
    description: "Fix #183 gone PRs",
    finished: true,
  });
  start("a1handback", "toolu_done", "Fix #183 gone PRs", 900);
  stop("a1handback", 600);
  // Done, its last words its report.
  agent(
    "a2words",
    [ask("Review PR #217"), entry("assistant", [{ type: "text", text: "**No blocking issues** in PR #217. Two nits, both in `web/work.js`." }])],
    {
      description: "Review PR #217 fresh",
      finished: true,
    },
  );
  start("a2words", "toolu_words", "Review PR #217 fresh", 800);
  stop("a2words", 700);
  // Failed on an API error.
  agent(
    "a3failed",
    [
      ask("Review PR #235"),
      entry("assistant", [{ type: "text", text: "API Error: Your computer went to sleep mid-response." }], { isApiErrorMessage: true, error: "server_error" }),
    ],
    {
      description: "Review PR #235 fresh",
    },
  );
  start("a3failed", "toolu_fail", "Review PR #235 fresh", 500);
  stop("a3failed", 400);
  // Helpers: a summary, a title and a classifier, each ending with no Agent call and no meta file.
  for (const [id, words] of [
    ["h1compact", "You're working on hoop. PR #207 is mergeable."],
    ["h2title", "Order export"],
    ["h3classify", "allow"],
  ] as const) {
    agent(id, [ask("Summarize"), entry("assistant", [{ type: "text", text: words }])]);
    workHook(
      home,
      hook("subagent-stop", {
        ...base,
        agent_id: id,
        agent_type: undefined,
        agent_transcript_path: join(subagents, `agent-${id}.jsonl`),
        last_assistant_message: words,
      }),
      ago(300),
    );
  }
  const sessions: ClaudeSession[] = [{ session: SESSION, pid: 1, status: "busy", cwd: "/tmp/proj" }];
  return { home, sessions };
}

test("the Work view lists only the agents an Agent call started, each in plain words", () => {
  const { home, sessions } = seed();
  const [s] = workView(home, () => sessions);
  const agents = s!.agents;
  assert.deepEqual(
    agents.map((a) => [a.description, a.status]),
    [
      ["Fix: deleted PRs stay Pending", "running"],
      ["Fix #183 gone PRs", "done"],
      ["Review PR #217 fresh", "done"],
      ["Review PR #235 fresh", "failed"],
    ],
    "helper transcripts are hidden",
  );
  const [running, handback, words, failed] = agents;
  assert.equal(running!.step, undefined, "a step that names a file doesn't show");
  assert.equal(handback!.outcome, "Opened PR #214: Home now shows a deleted PR as Gone. Tests pass.");
  assert.deepEqual(handback!.links, [
    { label: "PR #214", url: "https://github.com/acme/shop/pull/214" },
    { label: "Review", url: "http://localhost:4747/r/rv_abc123" },
  ]);
  assert.equal(words!.outcome, "No blocking issues in PR #217. Two nits, both in work.js.");
  assert.equal(failed!.reason, "Failed: Your computer went to sleep mid-response.");
  for (const a of agents) assert.doesNotMatch(`${a.outcome ?? ""} ${a.reason ?? ""} ${a.step ?? ""}`, /\/|SubagentHandback/);

  // An agent hoop saw only end, with no call, takes its description from Claude Code's meta file;
  // SubagentStop always names its type.
  workHook(
    home,
    hook("subagent-stop", { agent_id: "a2words", agent_type: "general-purpose", session_id: "other-session", agent_transcript_path: agents[2]!.transcript }),
  );
  const other = workView(home, () => sessions).find((x) => x.id === "other-session")!;
  assert.deepEqual(
    other.agents.map((a) => [a.description, a.type]),
    [["Review PR #217 fresh", "general-purpose"]],
  );
});

test("a report reads as its first plain sentences, with its links, and a step only when it names no file", () => {
  assert.equal(outcomeOf("## Result\n\n- Fixed it in `src/a.ts`. Pushed to ~/Projects/x/y. And more. And more."), "Fixed it in a.ts. Pushed to y.");
  assert.equal(outcomeOf("Done: see https://example.com/x for the log."), "Done: see a link for the log.");
  assert.equal(outcomeOf("```\ncode\n```"), undefined);
  assert.deepEqual(reportLinks("https://github.com/o/r/issues/9 and https://github.com/o/r/issues/9"), [
    { label: "Issue #9", url: "https://github.com/o/r/issues/9" },
  ]);
  // Review fixes: markdown links, words cut at a space, headings, lists, tables, code, dates, emphasis, "e.g.".
  assert.equal(outcomeOf("Opened [the fix](https://github.com/o/r/pull/3) today."), "Opened the fix today.");
  assert.equal(outcomeOf(`Done ${"word ".repeat(60)}`), `Done ${"word ".repeat(46).trim()}…`);
  assert.equal(outcomeOf("# Report\n## Summary\nAll green."), "All green.");
  assert.equal(outcomeOf("- Opened PR #5.\n- Fixed the docs."), "Opened PR #5.");
  assert.equal(outcomeOf("| a | b |\n|---|---|\n\nTable above."), "Table above.");
  assert.equal(outcomeOf("```\nline one\n\nline two\n```\n\nThe code ran."), "The code ran.");
  assert.equal(outcomeOf("Shipped on 10/25/2026."), "Shipped on 10/25/2026.");
  assert.equal(outcomeOf("It is *really* done."), "It is really done.");
  assert.equal(outcomeOf("Tried tools, e.g. grep. Then stopped. Then more."), "Tried tools, e.g. grep. Then stopped.");
  assert.equal(
    failReason('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens"}}'),
    "Failed: prompt is too long: 210000 tokens",
  );
  assert.equal(failReason(`API Error: could not read /Users/me/x/y.ts. Retrying. ${"x".repeat(300)}`), "Failed: could not read y.ts.");
  assert.ok(failReason(`API Error: ${"word ".repeat(80)}`).length <= "Failed: ".length + 160);
  assert.equal(plainStep("running tests: npm test -- test/a.test.ts"), "running tests");
  assert.equal(plainStep("searching for router"), undefined);
  assert.equal(plainStep("finding files: *.ts"), undefined);
  assert.equal(plainStep("waiting on a review in hoop"), "waiting on a review in hoop");
  assert.equal(plainStep("reading src/prs.ts"), undefined);
  assert.equal(plainStep("running: cd /tmp && ls"), undefined);
  assert.equal(plainStep("SubagentHandback"), undefined);
});

test("the Work page keeps running agents on top and folds finished ones, with outcomes, links and details", { skip: BROWSER_SKIP }, async () => {
  const { home, sessions } = seed();
  await withBrowser(
    async ({ base, page }) => {
      await page.goto(`${base}/work`);
      const s = page.locator("section.work-session").first();
      await s.locator(".agent").first().waitFor();
      const top = s.locator("ul.agents").first().locator(":scope > .agent");
      assert.equal(await top.count(), 1);
      assert.match(await top.innerText(), /Running\s*Fix: deleted PRs stay Pending\s*running for 12 m/);
      const finished = s.locator("details.finished");
      assert.equal(await finished.locator(":scope > summary").innerText(), "3 finished");
      assert.equal(await finished.locator(":scope > summary").getAttribute("aria-label"), "3 finished agents");
      assert.equal(await finished.getAttribute("open"), null, "finished agents are folded");
      await finished.locator(":scope > summary").click();
      const done = finished.locator(".agent").first();
      assert.match(await done.locator(".outcome").innerText(), /^Opened PR #214: Home now shows a deleted PR as Gone\. Tests pass\.$/);
      assert.deepEqual(await done.locator(".links a").allInnerTexts(), ["PR #214", "Review"]);
      assert.match(await finished.locator(".agent").nth(2).innerText(), /Failed\s*Review PR #235 fresh[\s\S]*Failed: Your computer went to sleep/);
      // Paths and tool names wait behind Details.
      const details = done.locator("details.agent-details");
      assert.equal(await details.locator(".path").isVisible(), false);
      assert.doesNotMatch(await s.innerText(), /agent-a1handback\.jsonl|SubagentHandback/);
      await details.locator("summary").focus();
      await page.keyboard.press("Enter");
      assert.match(await details.locator(".path").innerText(), /agent-a1handback\.jsonl$/);
      // A poll that paints again keeps the folds and the focus.
      await s.evaluate((el) => el.setAttribute("data-old", ""));
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.locator("section.work-session:not([data-old])").first().waitFor();
      assert.equal(await hasFocus(page.locator("details.agent-details[open] summary").first()), true);
      // So does a report's link inside the finished fold, rather than jumping to the fold's summary.
      await page.locator(".agent .links a", { hasText: "PR #214" }).focus();
      await page
        .locator("section.work-session")
        .first()
        .evaluate((el) => el.setAttribute("data-old", ""));
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.locator("section.work-session:not([data-old])").first().waitFor();
      assert.equal(await hasFocus(page.locator(".agent .links a", { hasText: "PR #214" })), true);
      // The session's folded summary counts only the agents that run.
      await page.getByRole("button", { name: "Order export", exact: true }).click();
      assert.equal(await s.locator(".session-head .fold-summary").innerText(), "1 agent running");
    },
    new Hoop(new Store(home)),
    { sessions: () => sessions },
  );
});

test("an agent that starts again after it ended runs again; a late start hook leaves it ended", () => {
  const home = tempHome();
  const t = (s: number) => new Date(Date.UTC(2026, 9, 25, 12, 0, s)).toISOString();
  const start = hook("subagent-start", { agent_id: "a7", agent_type: "general-purpose" });
  workHook(home, start, t(0));
  workHook(home, hook("subagent-stop", { agent_id: "a7", agent_type: "general-purpose" }), t(10));
  workHook(home, start, t(11));
  assert.equal(readWork(home, SESSION)!.agents[0]!.status, "done", "a start hook that ran late");
  workHook(home, start, t(40));
  const a = readWork(home, SESSION)!.agents[0]!;
  assert.equal(a.status, "running");
  assert.equal(a.ended, undefined);
});
