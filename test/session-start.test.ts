import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { NOTE_MAX, readSnapshot, saveSnapshot, sessionNote, sessionStartOutput } from "../src/session-start.js";
import { Store } from "../src/store.js";
import { editWork, moveInQueue, workHook } from "../src/work.js";
import { example, hoopArgs, pagesFor, TEST_SESSION, tempHome } from "./helpers.js";

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/session-hooks.json", import.meta.url), "utf8"));
const WORK = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const startScript = new URL("../plugins/hoop/scripts/session-start.sh", import.meta.url).pathname;
const compactScript = new URL("../plugins/hoop/scripts/pre-compact.sh", import.meta.url).pathname;
const SOURCES = ["startup", "resume", "clear", "compact"] as const;

/** The session's transcript in the test's Claude Code folder, so its reviews sit in its `.hoop`. */
function transcript(folder = "-tmp-start") {
  const dir = join(process.env.HOOP_CLAUDE_DIR!, "projects", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${TEST_SESSION}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "Go" } })}\n`);
  return path;
}

const hook = (name: string, path: string) => ({ ...structuredClone(HOOKS[name]), transcript_path: path });

/** Todos created through the work hook, as Claude Code's TaskCreate reports them. */
function todos(home: string, path: string, subjects: string[]) {
  subjects.forEach((subject, n) =>
    workHook(home, {
      ...structuredClone(WORK["post-taskcreate"]),
      session_id: TEST_SESSION,
      transcript_path: path,
      tool_input: { subject },
      tool_response: { task: { id: String(n + 1), subject } },
    }),
  );
}

/** A session with two queued todos the person reordered, and a review or question in each state. */
function busySession() {
  const home = tempHome();
  const store = new Store(home);
  const path = transcript();
  const hoop = new Hoop(store);
  todos(home, path, ["Write the migration", "Ship it"]);
  editWork(home, TEST_SESSION, (r) => moveInQueue(r, "2", "before", "1"));
  const unread = hoop.submit({ ...example(), title: "Export plan" }).review_id;
  hoop.review(unread, { verdict: "changes_requested", reviewer: "ana", comments: [], summary: "Split it." });
  const owed = hoop.submit({ ...example(), title: "Storage design" }).review_id;
  hoop.review(owed, { verdict: "changes_requested", reviewer: "bo", comments: [], summary: "Use files." });
  hoop.receive(owed);
  const approved = hoop.submit({ ...example(), title: "Rollout" }).review_id;
  hoop.review(approved, { verdict: "approved", reviewer: "cy", comments: [] });
  const waiting = hoop.submit({ ...example(), title: "Naming" }).review_id;
  const ask = hoop.ask({
    questions: [{ question: "Keep the old endpoint?", options: [{ label: "Keep it", recommended: true }, { label: "Remove it" }] }],
  }).review_id;
  hoop.answer(ask, { question: "Q1", choice: "B" });
  return { home, store, path, ids: { unread, owed, approved, waiting, ask } };
}

test("every session start lists the queue in the person's order, unread feedback and what waits on Claude, under 1,500 characters", () => {
  const { store, path, ids } = busySession();
  for (const source of SOURCES) {
    const note = sessionNote(store, hook(source, path));
    assert.ok(note.length <= NOTE_MAX, `${source}: ${note.length} characters`);
    assert.match(note, /^Queued todos, in the person's order: #2 Ship it; #1 Write the migration\.$/m, source);
    assert.match(note, new RegExp(`"Export plan" \\(${ids.unread}\\) changes requested by ana`), source);
    assert.match(note, new RegExp(`"Rollout" \\(${ids.approved}\\) approved by cy`), `${source}: an approval not read yet is unread feedback`);
    assert.match(note, new RegExp(`"Keep the old endpoint\\?" \\(${ids.ask}\\) answered`), source);
    assert.match(note, new RegExp(`^Waiting on your answer: "Storage design" \\(${ids.owed}\\) changes requested\\.$`, "m"), source);
    assert.doesNotMatch(note, /hoop_|read it with/, `${source}: no instructions`);
    const naming = new RegExp(`"Naming" \\(${ids.waiting}\\) awaiting review`);
    if (source === "compact") assert.match(note, naming, "after a compaction, what is still open");
    else assert.doesNotMatch(note, naming, "a review waiting on the person isn't listed");
    assert.deepEqual(sessionStartOutput(note), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note } });
  }
});

test("a session with nothing in hoop, or an input that isn't a session start, gets no note", () => {
  const store = new Store(tempHome());
  const path = transcript("-tmp-start-empty");
  for (const source of SOURCES) assert.equal(sessionNote(store, hook(source, path)), "");
  const { store: busy, path: busyPath } = busySession();
  for (const input of [null, "x", {}, hook("pre-compact", busyPath), { ...hook("startup", busyPath), session_id: "../x" }])
    assert.equal(sessionNote(busy, input), "");
  assert.equal(sessionStartOutput(""), undefined);
});

test("a long queue is cut to fit, saying how many more there are", () => {
  const home = tempHome();
  const store = new Store(home);
  const path = transcript("-tmp-start-long");
  todos(
    home,
    path,
    Array.from({ length: 60 }, (_, n) => `Todo ${n + 1}: ${"a long description of the work ".repeat(4)}`),
  );
  const note = sessionNote(store, hook("resume", path));
  assert.ok(note.length <= NOTE_MAX, `${note.length} characters`);
  assert.match(note, /#1 Todo 1/);
  assert.match(note, /; \d+ more\.$/);
});

test("the snapshot before a compaction keeps what was open, and the session start after it lists the same items", () => {
  const { home, store, path, ids } = busySession();
  const snapshot = saveSnapshot(store, hook("pre-compact", path))!;
  assert.deepEqual(
    snapshot.todos.map((t) => t.id),
    ["2", "1"],
  );
  assert.deepEqual(new Set(snapshot.reviews), new Set([ids.unread, ids.owed, ids.waiting, ids.ask]), "approved reviews aren't open");
  assert.deepEqual(readSnapshot(home, TEST_SESSION), snapshot);
  assert.equal(saveSnapshot(store, hook("compact", path)), undefined, "only a PreCompact input takes a snapshot");

  // The queue's record is gone: the note keeps the snapshot's.
  rmSync(join(home, "work", `${TEST_SESSION}.json`));
  const note = sessionNote(store, hook("compact", path));
  assert.match(note, /^Queued todos: #2 Ship it; #1 Write the migration\.$/m);
  for (const id of snapshot.reviews) assert.match(note, new RegExp(id));
  // Something newer than the snapshot is listed too.
  const newer = new Hoop(store).submit({ ...example(), title: "Later doc" }).review_id;
  assert.match(sessionNote(store, hook("compact", path)), new RegExp(`"Later doc" \\(${newer}\\) awaiting review`));
});

test("the scripts fail open without a hoop folder, and the PreCompact snapshot reaches the next compact start", async () => {
  assert.equal(spawnSync("sh", ["-n", startScript]).status, 0, "POSIX sh");
  assert.equal(spawnSync("sh", ["-n", compactScript]).status, 0, "POSIX sh");
  const real = [process.execPath, ...hoopArgs].join(" ");
  const run = (script: string, input: unknown, env: Record<string, string>) =>
    spawnSync("/bin/sh", [script], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, HOOP_BIN: real, ...env } });

  const path = transcript();
  const missing = join(tmpdir(), `hoop-missing-${process.pid}`);
  for (const source of SOURCES) assert.deepEqual(pick(run(startScript, hook(source, path), { HOOP_HOME: missing })), [0, "", ""], source);
  assert.deepEqual(pick(run(compactScript, hook("pre-compact", path), { HOOP_HOME: missing })), [0, "", ""]);
  const direct = spawnSync(process.execPath, [...hoopArgs, "session-start"], {
    input: JSON.stringify(hook("resume", path)),
    encoding: "utf8",
    env: { ...process.env, HOOP_HOME: missing },
  });
  assert.deepEqual(pick(direct), [0, "", ""], "hoop session-start alone, too");
  assert.equal(existsSync(missing), false, "nothing creates the hoop folder");

  const { home, ids } = busySession();
  // No pages process: the snapshot is dropped, and none starts.
  assert.deepEqual(pick(run(compactScript, hook("pre-compact", path), { HOOP_HOME: home, HOOP_PORT: "1" })), [0, "", ""]);
  assert.equal(readSnapshot(home, TEST_SESSION), undefined);

  const pages = await pagesFor(home);
  assert.deepEqual(pick(run(compactScript, hook("pre-compact", path), pages)), [0, "", ""]);
  assert.ok(readSnapshot(home, TEST_SESSION)?.reviews.includes(ids.waiting), "the pages process wrote the snapshot");
  const out = run(startScript, hook("compact", path), pages);
  assert.equal(out.status, 0);
  const note: string = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  for (const id of Object.values(ids)) assert.match(note, new RegExp(id));
  assert.ok(note.length <= NOTE_MAX);

  const hooks = JSON.parse(readFileSync(new URL("../plugins/hoop/hooks/hooks.json", import.meta.url), "utf8")).hooks;
  assert.equal(hooks.SessionStart[0].matcher, "startup|resume|clear|compact");
  assert.match(hooks.SessionStart[0].hooks[0].command, /session-start\.sh/);
  assert.match(hooks.PreCompact[0].hooks[0].command, /pre-compact\.sh/);
  for (const h of [hooks.SessionStart[0].hooks[0], hooks.PreCompact[0].hooks[0]])
    assert.ok(h.timeout > 4, "Claude Code's timeout is longer than the script's wait");
});

const pick = (r: ReturnType<typeof spawnSync>) => [r.status, String(r.stdout), String(r.stderr)];
