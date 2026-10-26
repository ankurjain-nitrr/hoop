import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSettings } from "../src/init.js";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { workHook, workView } from "../src/work.js";
import { BROWSER_SKIP, tempHome, withBrowser } from "./helpers.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const ON = JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } });
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
/** Claude Code's list of a session's deferred tools, as its transcript records it. */
const listed = (...names: string[]) => line({ type: "attachment", attachment: { type: "deferred_tools_delta", addedNames: names, removedNames: [] } });
const called = (name: string) => line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name, input: {} }] } });

/** A session with a subagent and no todos, in its own folder with this transcript; its home and folder. */
function session(transcript?: string) {
  const home = tempHome();
  const cwd = mkdtempSync(join(tmpdir(), "hoop-proj-"));
  const path = join(cwd, "session.jsonl");
  if (transcript !== undefined) writeFileSync(path, transcript);
  workHook(home, { ...HOOKS["subagent-start"], transcript_path: path, cwd });
  return { home, cwd, path, tools: () => workView(home, () => [])[0]!.todo_tools };
}

/** Runs `fn` with the todo tools on in Claude Code's user settings, then removes them. */
function userSettingOn<T>(fn: () => T): T {
  mkdirSync(join(claudeSettings(), ".."), { recursive: true });
  writeFileSync(claudeSettings(), ON);
  try {
    return fn();
  } finally {
    rmSync(claudeSettings(), { force: true });
  }
}

test("a session whose transcript lists or calls a todo tool has them, whatever the settings say", () => {
  assert.equal(session(listed("WebFetch", "TaskCreate")).tools(), "on");
  assert.equal(session(listed("WebFetch") + called("TodoWrite")).tools(), "on");
  // A resumed session that got the tools later has them.
  const s = session(listed("WebFetch"));
  assert.equal(s.tools(), "off");
  appendFileSync(s.path, listed("TaskCreate"));
  assert.equal(s.tools(), "on");
});

test("a session listing tools without the todo tools gets the setup hint, or a restart once the setting is on", () => {
  assert.equal(session(listed("WebFetch")).tools(), "off");
  assert.equal(
    userSettingOn(() => session(listed("WebFetch")).tools()),
    "restart",
  );
  const p = session(listed("WebFetch"));
  mkdirSync(join(p.cwd, ".claude"));
  writeFileSync(join(p.cwd, ".claude", "settings.local.json"), ON);
  assert.equal(p.tools(), "restart");
});

test("without a tool list in its transcript, a session goes by Claude Code's settings", () => {
  assert.equal(session().tools(), "off");
  assert.equal(session("").tools(), "off");
  assert.equal(
    userSettingOn(() => session().tools()),
    "on",
  );
  const p = session(called("Read"));
  mkdirSync(join(p.cwd, ".claude"));
  writeFileSync(join(p.cwd, ".claude", "settings.json"), ON);
  assert.equal(p.tools(), "on");
  // A session with todos needs no verdict.
  const t = session(listed("WebFetch"));
  workHook(t.home, { ...HOOKS["post-taskcreate"], transcript_path: t.path, cwd: t.cwd });
  assert.equal(t.tools(), undefined);
});

test("the Work page says No todos yet, the setup hint or to restart, by the session's todo tools", { skip: BROWSER_SKIP }, async () => {
  const cases: [string, RegExp, RegExp | undefined][] = [
    [listed("TaskCreate"), /^No todos yet\.$/, /hoop init/],
    [listed("WebFetch"), /CLAUDE_CODE_ENABLE_TODO_TOOLS=1.*run hoop init/s, undefined],
  ];
  for (const [transcript, shows, hides] of cases) {
    const { home } = session(transcript);
    await withBrowser(
      async ({ page, base }) => {
        await page.goto(`${base}/work`);
        const none = page.locator("section.work-session .none").first();
        await none.waitFor();
        const text = (await none.innerText()).trim();
        assert.match(text, shows);
        if (hides) assert.doesNotMatch(text, hides);
      },
      new Hoop(new Store(home)),
      { sessions: () => [] },
    );
  }
  mkdirSync(join(claudeSettings(), ".."), { recursive: true });
  writeFileSync(claudeSettings(), ON);
  try {
    const { home } = session(listed("WebFetch"));
    await withBrowser(
      async ({ page, base }) => {
        await page.goto(`${base}/work`);
        const none = page.locator("section.work-session .none").first();
        await none.waitFor();
        const text = await none.innerText();
        assert.match(text, /started before that: restart it/);
        assert.doesNotMatch(text, /hoop init/);
      },
      new Hoop(new Store(home)),
      { sessions: () => [] },
    );
  } finally {
    rmSync(claudeSettings(), { force: true });
  }
});
