# How hoop works

hoop is one Node package (`src/`, built to `dist/`) with static pages in `web/`, for Node 22.12 or
later. It runs as an MCP server on stdio (`hoop mcp`), as terminal commands, and as one background
process that serves the review pages.

## Contract

`src/contract.ts` defines both formats with zod: `hoop/review@0` (a document: title, TL;DR, kind,
and items with an ID, a type, a title and a body) and `hoop/feedback@0` (a verdict, comments,
answers to questions, resolved threads). Each field carries its description. The published JSON
Schema files in [`schemas/`](../schemas/) (`review.schema.json` and `feedback.schema.json`) are the
reference for both formats; `scripts/schemas.ts` generates them from the contract, and a test
checks they match.

Every agent tool and terminal command comes from one list, `OPS` in `src/ops.ts`: a name, an input
schema, a `run` function and a `cli` mapping. `src/mcp.ts` and `src/cli.ts` only adapt it.

## Store

Reviews are JSON files, written through a temp file and a rename (`writeAtomic`). There is no
database, so `npx` installs need no native modules (`node:sqlite` is still experimental in Node
22).

Each Claude Code session keeps its reviews in its own folder: the `.hoop` beside its transcript,
`<claude dir>/projects/<folder slug>/<session>/.hoop/reviews/<id>/` (`sessionHoop` in
`src/owner.ts`). A process without a session, or a session whose transcript hoop can't find, keeps
them in `~/.hoop/reviews` (`HOOP_HOME`). The index `~/.hoop/index.json` (`src/registry.ts`) maps each
review in a session folder to that `.hoop`, so the one pages process serves every session and links
stay valid. Claude Code deletes a session's folder after `cleanupPeriodDays`; its reviews go with it,
and the store drops their index entries the next time it lists reviews.

`src/migrate.ts` moves the reviews earlier releases kept in `~/.hoop/reviews`, once, when a store
first opens: each review whose owner (or plan hook record) names a session with a folder is copied to
a temp folder beside its destination, checked byte for byte, renamed into place, indexed, and only
then removed from `~/.hoop/reviews`, all under the review's lock. Each step can be cut short and run
again. Reviews without a session stay, and `~/.hoop/migrated.json` records the counts. `hoop clear`
(`src/clear.ts`) is the only way hoop deletes a review.

```
~/.hoop/
  index.json               each review kept in a session folder, with that folder's .hoop
  migrated.json            what the one-time move into session folders did
  reviews/rv_<id>/         a review from another agent's session or outside any session; in a Claude
                           Code session, the same files are in
                           <claude dir>/projects/<folder>/<session>/.hoop/reviews/rv_<id>/
    review.json            status, revision count, folder and git repository, owner, supersedes / superseded_by
    rev-N.json             each revision's document
    feedback-N.json        the feedback given on revision N
    replies.json           replies in threads
    proposals.json         edits Claude proposed, and their decisions
    applied.json           suggestions and edits materialized into revisions
    receipts.json          when the agent first received each submitted review, and which session
    renamed-N.json         sections matched by place in revision N
  names.json               the names people gave sessions on Home, by session ID
  sessions/                one entry per running `hoop mcp` session, with its Claude Code session
  plans/<session>.json     the plan hook's review for each Claude Code session
  prs.json                 tracked pull requests: URL, the session that opened it, when
  work/<session>.json      a Claude Code session's todos and subagents, from the plugin's hooks
  pages.jsonl              the pages process's starts, restarts and stops
```

Thread IDs (`th_<review>_<n>`) and edit IDs (`ed_<review>_<n>`) embed the review ID. An approved
review is frozen; a submit against it creates a new review that supersedes it. `src/rules.ts` holds
the rules on whether a review can change, and the thread lookup.

Every read-modify-write of a review holds its lock (`src/lock.ts`): a `.lock` file in its folder,
created exclusively with the holder's process ID and time. A waiter retries with a short backoff,
and breaks a lock whose process is gone or that is older than five seconds. The lock is re-entrant
inside a process, so an operation holds it from its first read to its last write.

## Owners

A review's `owner` is the session that submitted it (`src/owner.ts`): the Claude Code session
(`CLAUDE_CODE_SESSION_ID`, which Claude Code sets for the MCP server and shell commands; the plan
hook also takes its input's `session_id`), else `HOOP_SESSION`, which any agent may set, else, in
`hoop mcp` only, a session made once per server process and named after the MCP client's
`clientInfo.name` (`<8 hex>-codex-mcp-client`). Other agents start one server per conversation, so
each conversation is a session, named by that client name. A Claude Code session is named by its
title: the last `custom-title` in the end of the session's transcript,
`<claude dir>/projects/*/<session>.jsonl`, else the name given on Home (`names.json`), else the last
`ai-title`; the Claude dir is `HOOP_CLAUDE_DIR`, `CLAUDE_CONFIG_DIR` or `~/.claude`. Titles are read
again whenever the transcript's size or time changes, so the pages show a rename at once. Another
session's owner record carries `claude: false`: its name is the one given on Home, else its own, and
hoop never looks it up in, or appends it to, a transcript; its reviews stay in the hoop home folder.
Only the owner revises, replies or proposes edits (`mustOwn` in `src/rules.ts`);
another session comments with `hoop_comment`, which records `session` in its feedback; a process
without a session only reads. A review without an owner goes to the first session that changes it.
The page's own actions are people's and need no session.

hoop is organized around sessions, not projects. Home groups each section by owner, and reviews
without one go in a "No session" group. `/api/reviews` gives each review its `session` (`id`,
`name`, `label`, and `live` while a `hoop mcp` entry in `sessions/` records it) and its `place`: the
name of the folder it was written in, and of its git repository when that is another folder. Pages
see names, never paths. `POST /api/sessions/<id>/name` renames a session that owns a review: the
name must be one line of 1 to 100 characters; hoop writes it to `names.json` and appends
`{"type":"custom-title","customTitle":"<name>","sessionId":"<id>"}` to the transcript, the line
Claude Code's `/rename` writes. The transcript is only ever appended to.

## The pages process

The pages run on `127.0.0.1:4747` (`HOOP_PORT`) in one detached process that no session owns
(`src/pages.ts`). Before giving a link, a session or command probes `/api/info`: when the same store
answers, it reuses it; when nothing answers, it starts `hoop serve` in the background and waits for
it; when another program, another store or an older hoop holds the port, it leaves it alone and
returns the reason as `pages` beside the result.

Each `hoop mcp` session writes an entry in `sessions/` with its install and release. Every two
seconds the pages process compares its own code (a hash of `src`, `dist` and `web`) and release with
the live sessions' installs, and hands the port over to newer code when it changes. It exits after
an hour with no live session and no request.

The API (`src/web.ts`) refuses a Host other than `localhost` or `127.0.0.1` on its port, a foreign
Origin, and a write that isn't JSON.

## Anchors and scope

A comment points at `{item, line}`. Line 0 is an item's heading and covers its section, with every
section nested in it. Item `DOC` line 1 is the title and line 2 the TL;DR; both cover the whole
document. A comment may also carry a `range` (start, end and the exact quote) inside its line, or an
agent may send `words`, which hoop resolves to the one place they occur (`src/quote.ts`).

## Materializing comments

Two ways change a document, both in `src/materialize.ts` on top of `src/edit.ts`:

- A reviewer applies an exact suggestion, which replaces only the suggested span in a new revision.
- Claude proposes span edits for a comment (`find` and `replace`, with or without item and line).
  Each must stay in the comment's scope and pass the rules in `RULES` (fourteen, each refusal named);
  in documents an edit can't change markdown structure or empty a line. The reviewer accepts or
  rejects each one as a tracked change. A proposal applies only while its line reads exactly as
  when proposed; accepting one rebases the others on that line.

Text outside an accepted span stays byte-identical.

## Markdown

`src/markdown.ts` parses any markdown into a review document. The first `#` heading is the title,
other headings start `section` items with their level, and the first paragraph is the default TL;DR.
Each block (a paragraph, a list item with its continuation lines, a code fence, a table row, a quote
line, a break) is one line to comment on; a block's source lines are joined with U+2028, so an
unedited document exports byte for byte. `web/blocks.js` shares the block grammar with the page.

A section whose heading starts with `Question:` is a question; its top-level list items are the
options, named by a leading letter or in order, with `(recommended)` marking one. The page asks for
an answer to each, and **Other** is answered in a comment on the question. A comment or a request for
changes needs every answer. An approval (also **Looks good, go**, one click) takes the recommended
option for each unanswered question and sends it with `recommended: true`, so Claude knows the person
didn't pick it; a question with no recommended option stays unanswered. The contract accepts
`recommended` only on an approval and only for the recommended option.

An answer given on an earlier revision stays in force while later revisions ask the same question:
the same section ID, title and options (`carriedAnswers` in `src/rules.ts`). The page shows it as
the answer, it counts toward the answers a comment needs, and the next feedback sends it again, so
the feedback on the latest revision always carries every answer, an approval's included. Section
IDs can pass to a different question when a revision restructures the document; that question
starts unanswered, and an approval takes its recommended option.

A code fence marked `mermaid` is a diagram. `web/diagram.js` draws each one in its own iframe,
sandboxed without same-origin access, whose content policy allows only two scripts: Mermaid from a
pinned jsDelivr address, checked by Subresource Integrity, and `web/diagram-frame.js`. hoop doesn't
ship Mermaid, and a page without a diagram loads nothing for it. If the library doesn't load,
offline or with a changed file, the diagram shows its source. The tests serve that address from the
exact `mermaid` devDependency and check that its hash matches, so a version bump changes the address,
the hash and the devDependency together.

On a new revision, section IDs stay stable: first by heading, then by place for a renamed heading
at the same level, under the same parent.

## Verdicts

Approving and requesting changes need no sign-in: the page's Submit sends the verdict, and an
approval freezes the review. Only people approve. Claude has no tool to approve, and its instructions
tell it never to approve for the person; `hoop_comment` always records a comment. A verdict from the
page names the reviewer as the user running hoop, and the page can't set a session.

## Waiting

A cursor `"<revision>.<count>"` marks how much feedback the agent has seen. `hoop_wait` holds for up
to 45 seconds and returns `pending` with `again: true`; `hoop wait` runs until a review or its
timeout. Both return at once when a review came in after the cursor (`src/wait.ts`).

Each time the agent receives feedback (`hoop_wait`, `hoop_feedback`, `hoop wait`, `hoop feedback` or
the plan hook, through `Hoop.receive`), hoop records a receipt for each submitted review in it, keyed
`<revision>.<index>`: the first time it was read, and the reader's session label, or `agent` outside a
session. A later read keeps the first receipt, and the pages' own reads record none. The review page
shows each receipt in the history and beside the latest review, and while one is unread it asks
`/api/reviews/<id>/receipts` every ten seconds when the tab is visible.

## Plan hook

The hoop plugin (`plugins/hoop/`) runs `hoop plan-review` before `ExitPlanMode`
(`src/plan.ts`). The first plan of a session is submitted as a review, a changed plan becomes a
revision, and an approved, unchanged plan is allowed, with the approval's notes and answers (each
taken recommendation says "took the recommended option"). Otherwise the hook waits for a review (up to
`HOOP_PLAN_WAIT_SECONDS`, 540 by default) and denies with the reviewer's answers and comments, or
with the link when no verdict comes. It fails closed.

The plugin's scripts (`plugins/hoop/scripts/`) run `$HOOP_BIN`, else the `hoop` on PATH, else the
package through `npx` (`HOOP_PACKAGE` in `hoop.sh`), for the MCP server and both hooks alike. In the
npx case the plan hook first runs `hoop help`, so the build happens before the timed review, and
the review's wait gets the time left before the hook's alarm, less 30 seconds.

## Pull requests

`hoop_track_pr` and `hoop track-pr` record a pull request URL for the calling session in
`prs.json`, under its own lock (`src/prs.ts`); tracking it again changes nothing. The hoop
plugin's `PostToolUse` hook on Bash runs `hoop pr-hook`, which tracks the URL a `gh pr create`
printed for the hook's `session_id`; it always exits 0. The pages process serves them at
`/api/prs`, reading each one's state with `gh pr view --json ...` only when Home asks, at most once
a minute, and never again once merged or closed. A failed `gh` reads as state unknown.

## Work

The plugin's hooks run `plugins/hoop/scripts/track-work.sh` on `PreToolUse` of the Agent tool,
`PostToolUse` of TaskCreate, TaskUpdate, TaskList, TaskGet, TaskStop, TodoWrite and Agent (once
named Task), and on `SubagentStart` and `SubagentStop`. Each hook is `async`, so Claude Code runs it
in the background; the script skips any other input without starting node and always exits 0. It
runs `hoop work-hook`, which turns the input into events (`workEvents` in `src/work.ts`) and
applies them to `work/<session>.json` under its lock:

- Todos come from TaskCreate (`tool_response.task.id`), TaskUpdate (`tool_input.taskId`, status
  `pending`, `in_progress`, `completed` or `deleted`), and the whole list from TaskList or the
  legacy TodoWrite (which has no IDs, so a todo's ID is its place). They show as queued, running and
  done, ordered by their numeric ID. Background hooks can arrive out of order, so a creation never
  undoes a later update, a deleted task stays deleted, and an update before its creation shows the
  task by number until its text arrives.
- Subagents: `SubagentStart` carries `agent_id` and `agent_type` but no description, so it takes
  the oldest unmatched Agent call of its type seen by `PreToolUse` (or a later call takes an agent
  that started first). `SubagentStop` ends it, with `agent_transcript_path` and
  `last_assistant_message`; the Agent tool's result (`agentId`, `status` `completed` or
  `async_launched`) fills in what the hooks missed, and TaskStop marks one stopped. A finished or
  stopped agent stays so.

The pages process serves `/api/work`: every session with work, newest first, at most 30. Whether a
session is working, idle or ended comes from Claude Code's `<claude dir>/sessions/<pid>.json`
(`sessionId`, `status`, `cwd`, `name`), read through a reader the server can be given, skipping
files whose process is gone; a running agent of an ended session shows as stopped. A running
agent's last step is the last tool call or text at the end of its transcript, read again only when
the file changes. The Work page (`web/work.js`) asks every three seconds while visible; while a
form or confirmation is open it waits, so a refresh never drops what is being typed.

### Steering

`POST /api/work/<session>/changes` takes `{ changes: [{ kind, todo | agent, text?, before | after? }] }`
behind the same Host, Origin and JSON checks as every write. `kind` is `remove`, `edit` or `move`
(a queued todo), `comment` (a queued or running todo, or a running agent) or `stop` (a running
agent). `addChanges` in `src/steer.ts` checks a batch against the record and the changes before it,
all or none, and appends each to the record's `changes` with who (`currentUser()`), when and its
delivery: `pending` when the session runs and its `sessions/<pid>.json` names a
`messagingSocketPath`, else `waiting`.

- **Message.** `Steer` batches a session's pending changes: three seconds after the last one it
  sends one message (`steerMessage`) as one JSON line, `{"type":"user","message":{"role":"user",
  "content":…}}`, over the session's Unix socket, and marks them `sent`, or `waiting` when the send
  fails. A pages process that restarts sends what it left pending on the next `/api/work`.
- **Gate.** `plugins/hoop/scripts/gate-work.sh` runs on `PreToolUse` of every tool, synchronously.
  Each record write also writes two small files beside it: `<session>.gate` while a todo change can
  stop a tool call, and `<session>.agents` with `id<TAB>stop|note<TAB>person` lines. Without either
  file the script exits 0 once it has read the session ID, never starting node. It starts
  `hoop work-gate` only for a todo tool call (TaskUpdate, TodoWrite) while `.gate` exists, or for a
  call whose input names an agent listed in `.agents`. `workGate` refuses a removed todo whenever it is started or marked
  done, an edited todo once until its subject is the new text, a waiting move or comment once, and
  every call whose top-level `agent_id` was stopped; it prints Claude Code's `deny` decision or `{}`.
- **Failing safe.** The gate fails open: a missing hoop, a crash, a timeout (a 20 s `perl` alarm,
  under the hook's 30 s) or output that isn't a decision lets the call go on, since every todo change
  also went by message and is recorded. The one exception is a stopped agent: when the input names an
  agent `.agents` lists as stopped (or that file can't be read), any of those failures refuses the
  call from the script itself (exit 2, with "Stopped by <person> in hoop's Work view" on stderr), so a
  stopped agent never runs on silently. Stops stay in the record and the file for good.
- **Seen or overridden.** After each hook, `settle` in `src/work.ts` compares open changes with the
  record: a removed todo deleted is `seen` and one started is `overridden`; an edit is `seen` when the
  todo reads the new text or the gate told the agent, else `overridden` once it starts; a move is
  `seen` when its first todo starts first; a comment on a todo once the todo moves on; a stop once
  the agent ended or the gate refused it. The page applies open moves to the queued todos' order.

