import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hoop } from "../src/hoop.js";
import { Store } from "../src/store.js";
import { parseMarkdown } from "../src/markdown.js";
import { earlierSessions, recordResume, resumedFrom } from "../src/resumes.js";
import { addChanges, replyToComment } from "../src/steer.js";
import { workHook } from "../src/work.js";
import { WRITES } from "../src/writes.js";
import { hoopHome } from "../src/util.js";
import { freePort, hoopArgs, pagesFor, runOp, tempHome } from "./helpers.js";

// Resuming a conversation whose session still runs, or forking one, goes on under a new session ID in
// a new process; hoop links the new session to the one it continues, from the SessionStart hook, once
// that one no longer runs, so it acts as that session.

const HOOKS = JSON.parse(readFileSync(new URL("./fixtures/work-hooks.json", import.meta.url), "utf8"));
const OLD = "11111111-2222-3333-4444-555555555555";
const NEW = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const STRANGER = "99999999-0000-0000-0000-000000000000";
const KEEP = { question: "Keep the old endpoint?", options: [{ label: "Keep it as an alias", recommended: true }, { label: "Remove it" }] };

/** A transcript in Claude Code's projects folder, saved as `name`.jsonl, holding one entry of each session in turn. */
function transcript(name: string, ...sessions: string[]) {
  mkdirSync(join(process.env.HOOP_CLAUDE_DIR!, "projects"), { recursive: true });
  const dir = mkdtempSync(join(process.env.HOOP_CLAUDE_DIR!, "projects", "-tmp-proj-"));
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, sessions.map((s) => `${JSON.stringify({ type: "user", sessionId: s, message: { role: "user", content: "hi" } })}\n`).join(""));
  return path;
}

const resume = (session: string, path: string, source = "resume") => ({
  session_id: session,
  transcript_path: path,
  cwd: "/tmp/proj",
  hook_event_name: "SessionStart",
  source,
});

test("a resume names the session it continues: the last other session in its transcript, else the transcript's name", () => {
  assert.equal(resumedFrom(resume(NEW, transcript(OLD, OLD))), OLD);
  assert.equal(resumedFrom(resume(NEW, transcript(NEW, OLD))), OLD, "a transcript under the new ID that holds the old entries");
  assert.equal(resumedFrom(resume(NEW, transcript(NEW, NEW))), undefined, "nothing earlier");
  for (const source of ["startup", "clear", "compact"]) assert.equal(resumedFrom(resume(NEW, transcript(OLD, OLD), source)), undefined, source);
  assert.equal(resumedFrom(resume(NEW, "/nowhere/x.txt")), undefined, "not a transcript");
  const outside = join(tempHome(), `${OLD}.jsonl`);
  writeFileSync(outside, `${JSON.stringify({ sessionId: OLD })}\n`);
  assert.equal(resumedFrom(resume(NEW, outside)), undefined, "a file outside Claude Code's projects folder");
  assert.equal(resumedFrom({ ...resume(NEW, transcript(OLD, OLD)), session_id: "../bad" }), undefined);
});

test("regression: a transcript resumed twice links to the session just before, not the first", () => {
  const A = "aaaaaaaa-0000-0000-0000-00000000000a";
  const B = "bbbbbbbb-0000-0000-0000-00000000000b";
  const C = "cccccccc-0000-0000-0000-00000000000c";
  assert.equal(resumedFrom(resume(C, transcript(C, A, B, C))), B);
  assert.equal(resumedFrom(resume(C, transcript(A, A, B))), B, "a transcript named after the first session");
});

test("regression: a fork, or a resume while the earlier session still runs, isn't linked to it", () => {
  const home = tempHome();
  const sessions = join(process.env.HOOP_CLAUDE_DIR!, "sessions");
  mkdirSync(sessions, { recursive: true });
  const RUNNING = "dddddddd-0000-0000-0000-00000000000d";
  // The earlier session's process is this one, so it runs.
  writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ sessionId: RUNNING, pid: process.pid }));
  try {
    const out = WRITES.resume!.run(new Store(home), { input: resume(NEW, transcript(RUNNING, RUNNING)) });
    assert.deepEqual(out, { linked: false, earlier: RUNNING, running: true });
    assert.deepEqual(earlierSessions(NEW, home), []);
  } finally {
    writeFileSync(join(sessions, `${process.pid}.json`), "{}");
  }
});

test("resume links chain back, and a link that would loop is refused", () => {
  const home = tempHome();
  assert.equal(recordResume(home, NEW, OLD), true);
  assert.equal(recordResume(home, STRANGER, NEW), true);
  assert.deepEqual(earlierSessions(STRANGER, home), [NEW, OLD]);
  assert.equal(recordResume(home, OLD, STRANGER), false, "a loop");
  assert.equal(recordResume(home, OLD, OLD), false);
  assert.deepEqual(earlierSessions(OLD, home), []);
});

test("regression: after a resume, the session replies to the person's Work comment on its earlier work; a stranger can't", () => {
  const home = hoopHome();
  workHook(home, {
    ...structuredClone(HOOKS["post-taskcreate"]),
    session_id: OLD,
    tool_input: { subject: "Plan" },
    tool_response: { task: { id: "1", subject: "Plan" } },
  });
  const [c] = addChanges(home, OLD, [{ kind: "comment", todo: "1", text: "Why this order?" }], { by: "ankur", reachable: true })!;
  const refused = /in another session's work: only the session it was made in replies to it/;
  assert.throws(() => replyToComment(home, NEW, c!.id, "Tests first.", { by: "claude", sessions: () => [] }), refused, "before the link");
  const store = new Store(home);
  const out = WRITES.resume!.run(store, { input: resume(NEW, transcript(OLD, OLD)) }) as { linked: boolean; earlier: string };
  assert.deepEqual(out, { linked: true, earlier: OLD });
  assert.equal(replyToComment(home, NEW, c!.id, "Tests first.", { by: "claude", sessions: () => [] }).session, OLD);
  assert.throws(() => replyToComment(home, STRANGER, c!.id, "Mine", { by: "claude", sessions: () => [] }), refused);
});

test("regression: after a resume, the session waits on, reads and withdraws the quick question it asked before", async () => {
  // Sessions of their own: the Work test above linked NEW to OLD in this home already.
  const OLD = "22222222-2222-3333-4444-555555555555";
  const NEW = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
  const store = new Store(hoopHome());
  const before = new Hoop(store, { session: OLD, claude: true });
  const { review_id: id } = before.ask({ questions: [KEEP] });
  const after = new Hoop(store, { session: NEW, claude: true });
  const refusal = /Only the session that asked this question/;
  await assert.rejects(async () => runOp(after, "wait", { review_id: id, seconds: 1 }), refusal, "before the link");
  WRITES.resume!.run(store, { input: resume(NEW, transcript(NEW, OLD, NEW)) });
  const waited = (await runOp(after, "wait", { review_id: id, seconds: 1 })) as { status: string };
  assert.equal(typeof waited.status, "string");
  assert.equal((runOp(after, "feedback", { review_id: id }) as { review_id: string }).review_id, id);
  after.withdraw(id, "Found the answer in the code.");
  await assert.rejects(async () => runOp(new Hoop(store, { session: STRANGER, claude: true }), "wait", { review_id: id, seconds: 1 }), refusal);
});

test("hoop session-start on a resume records the link through the pages process", async () => {
  const home = tempHome();
  mkdirSync(home, { recursive: true });
  const pages = await pagesFor(home);
  const r = spawnSync(process.execPath, [...hoopArgs, "session-start"], {
    input: JSON.stringify(resume(NEW, transcript(OLD, OLD))),
    encoding: "utf8",
    env: { ...process.env, ...pages, HOOP_PAGES: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, "resumes.json")), r.stderr);
  assert.deepEqual(earlierSessions(NEW, home), [OLD]);
});

test("regression: hoop session-start on a resume with no pages process still prints the note, at once", async () => {
  const home = tempHome();
  const SESSION = "eeeeeeee-0000-0000-0000-00000000000e";
  const hoop = new Hoop(new Store(home), { session: SESSION, claude: true });
  const { review_id } = hoop.submit(parseMarkdown("# Plan\n\nShip it on Friday.\n"));
  hoop.review(review_id, { verdict: "changes_requested", reviewer: "ana", comments: [], summary: "Shorter." });
  const started = Date.now();
  const r = spawnSync(process.execPath, [...hoopArgs, "session-start"], {
    input: JSON.stringify(resume(SESSION, transcript(OLD, OLD, SESSION))),
    encoding: "utf8",
    env: { ...process.env, HOOP_HOME: home, HOOP_PORT: String(await freePort()), HOOP_PAGES: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /additionalContext/);
  assert.ok(Date.now() - started < 3500, "within the hook's watchdog");
  assert.equal(existsSync(join(home, "resumes.json")), false, "no link without a pages process");
});
