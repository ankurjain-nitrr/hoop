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
/** Claude Code's change to a session's deferred tools, as its transcript records it. */
const delta = (added: string[], removed: string[] = []) =>
  line({
    type: "attachment",
    attachment: {
      type: "deferred_tools_delta",
      addedNames: added,
      addedLines: added.map((n) => `${n}: a tool`),
      removedNames: removed,
      wireHiddenNames: [],
      readdedNames: [],
      surfacedNames: [],
      pendingMcpServers: [],
      failedMcpServers: [],
    },
  });
const listed = (...names: string[]) => delta(names);
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
  // A later list that removes them takes them away again, and one that adds them back returns them.
  const s = session(listed("TaskCreate"));
  appendFileSync(s.path, delta([], ["TaskCreate", "TaskUpdate"]));
  assert.equal(s.tools(), "off");
  appendFileSync(s.path, listed("TaskCreate"));
  assert.equal(s.tools(), "on");
  // A multibyte character cut across reads and a rewritten file are read whole.
  const m = session(line({ type: "user", message: { content: "é".repeat(700_000) } }) + listed("TaskCreate"));
  assert.equal(m.tools(), "on");
  writeFileSync(m.path, listed("WebFetch"));
  assert.equal(m.tools(), "off");
});

test("a running session picks up the setting: the setting on means it has the tools before it lists them", () => {
  // As in a real transcript: a list without the todo tools, the setting turned on, then a later list adding them.
  const s = session(listed("WebFetch"));
  assert.equal(s.tools(), "off");
  userSettingOn(() => {
    assert.equal(s.tools(), "on");
    appendFileSync(s.path, listed("TaskCreate", "TaskGet", "TaskList", "TaskUpdate"));
    assert.equal(s.tools(), "on");
  });
  assert.equal(s.tools(), "on");
  // The project's settings count too.
  const p = session(listed("WebFetch"));
  mkdirSync(join(p.cwd, ".claude"));
  writeFileSync(join(p.cwd, ".claude", "settings.local.json"), ON);
  assert.equal(p.tools(), "on");
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

test("the Work page says No todos yet when the session has the todo tools, and the setup hint when not", { skip: BROWSER_SKIP }, async () => {
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
});
