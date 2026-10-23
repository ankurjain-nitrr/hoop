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

Reviews are JSON files, written through a temp file and a rename (`writeAtomic`), and only by the
pages process (see "One writer" below). There is no database, so `npx` installs need no native
modules (`node:sqlite` is still experimental in Node 22).

Each Claude Code session keeps its reviews in its own folder: the `.hoop` beside its transcript,
`<claude dir>/projects/<folder slug>/<session>/.hoop/reviews/<id>/` (`sessionHoop` in
`src/owner.ts`). A process without a session, or a session whose transcript hoop can't find, keeps
them in `~/.hoop/reviews` (`HOOP_HOME`). The index `~/.hoop/index.json` (`src/registry.ts`) maps each
review in a session folder to that `.hoop`, so the one pages process serves every session and links
stay valid. Claude Code deletes a session's folder after `cleanupPeriodDays`; its reviews go with it,
and the store drops their index entries the next time it lists reviews.

`src/migrate.ts` moves the reviews earlier releases kept in `~/.hoop/reviews`, once, when the pages
process first opens its store: each review whose owner (or plan hook record) names a session with a
folder is copied to a temp folder beside its destination, checked byte for byte, renamed into place,
indexed, and only then removed from `~/.hoop/reviews`. What moved goes to `pages.jsonl`. Each step can
be cut short and run again; until it runs, sessions and commands read the reviews where they are. Reviews without a session stay, and `~/.hoop/migrated.json` records the counts. `hoop clear`
(`src/clear.ts`) is the only way hoop deletes a review.

```
~/.hoop/
  index.json               each review kept in a session folder, with that folder's .hoop
  migrated.json            what the one-time move into session folders did
  reviews/rv_<id>/         a review from another agent's session or outside any session; in a Claude
                           Code session, the same files are in
                           <claude dir>/projects/<folder>/<session>/.hoop/reviews/rv_<id>/
    review.json            status, revision count, folder and git repository, owner (or opened_by and
                           source for a file a person opened), supersedes / superseded_by
    rev-N.json             each revision's document
    feedback-N.json        the feedback given on revision N
    replies.json           replies in threads
    proposals.json         edits Claude proposed, and their decisions
    applied.json           suggestions and edits materialized into revisions
    receipts.json          when the agent first received each submitted review, and which session
    deliveries.json        how each review from the page reached the owner's session
    renamed-N.json         sections matched by place in revision N
    build.json             a build's blocks (ID, kind, markdown, who wrote it) and its steps
    build-N.json           the block list after step N, each block's text by hash
    blocks/<hash>          each block text a build ever had, stored once
  names.json               the names people gave sessions on Home, by session ID
  sessions/                one entry per running `hoop mcp` session, with its Claude Code session
  plans/<session>.json     the plan hook's review for each Claude Code session
  prs.json                 tracked pull requests: URL, the session that opened it, when
  work/<session>.json      a Claude Code session's todos and subagents, from the plugin's hooks
  waits/<review>.<pid>.json  a wait on a review that runs, or just timed out
  pages.jsonl              the pages process's starts, restarts and stops, and the move of old reviews
```

Thread IDs (`th_<review>_<n>`) and edit IDs (`ed_<review>_<n>`) embed the review ID. An approved
review is frozen; a submit against it creates a new review that supersedes it. `src/rules.ts` holds
the rules on whether a review can change, and the thread lookup.

### One writer

The pages process is the only process that writes these files: every review's revisions, comments,
replies, answers, proposals, receipts, deliveries and renamed sections, the wait marks, the plan
hook's records, Work records and their gate files, tracked pull requests, `names.json` and
`index.json`. Sessions (`hoop mcp`), terminal commands and hooks read the files directly, through a
store opened read-only that refuses any write, and send each write to the pages process at
`POST /api/write/<action>` (`src/remote.ts`; the actions are `WRITES` in `src/writes.ts`):

- `op` runs an agent operation marked `writes` in `OPS` (submit, comment, reply, proposed edits,
  feedback with its receipts, tracking a pull request, starting a build and writing or suggesting
  into it) for the caller's session, with the caller's folder, git repository and `.hoop` folder, so
  the review records the session's place.
- `receive` and `wait` are a wait's receipts and its mark, `build_take` the requests
  `hoop_build_wait` takes, `plan` and `plan_cursor` the plan hook's submit and record, `work_hook`,
  `work_gate` and `pr_hook` the hooks', `open` is `hoop open` (the file by its full path) and `clear`
  is `hoop clear`.

When nothing answers, the caller starts the pages process, as it does before giving a link, and
tries once more; if that fails, the write fails with the reason. It never falls back to writing the
files itself. A pages process from an older release, which has no write route, gets eight seconds
to hand the address over. The hooks that must stay fast and never fail (`pr-hook`, `work-hook`) don't
start one: when none answers they drop the write quietly, so a pull request opened or a todo changed
then doesn't show until the next one. `work-gate` starts one like a command; when it can't, it exits
with an error and the gate's script fails safe (below).

The route takes only hoop's own callers: besides the Host and JSON checks every write passes, it
refuses any request with `Origin` or `Sec-Fetch-*` headers (every browser request carries them, so
not even hoop's own pages can act as a session), and one whose `x-hoop-store` header doesn't name the
store this process serves. Another site's page can't set that header without a CORS preflight, which
the pages never grant.

Inside the pages process, writes run one at a time for each review, Work record or file (`Queue` in
`src/writes.ts`), so a write that waits midway, such as a person's review waiting to message the
session, never interleaves with another write to the same review. Each write still goes through a
temp file and a rename, so a reader never sees half a file. Each `hoop mcp` session's own entry in
`sessions/`, and `pages.jsonl` when the pages process can't start, are still written by the process
they describe: one file per process, never read, changed and written back.

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

`hoop open <file.md>` (`Hoop.open`, a terminal command only, with no agent tool) lets a person open
any markdown file for review, in or out of a session. The review has no `owner`; `opened_by` is the
person (`currentUser()`) and `source` the file's real path and the SHA-256 of its text. It lives in
the hoop home folder. Opening the same path again finds the newest review with that `source` that
nothing superseded: an unchanged hash only returns its link; a changed one adds a revision with
sections matched as for a submit, or, after an approval, starts a review that supersedes it. On such
a review `mustOwn` lets any session reply (the reply is named after the replying session, which
doesn't become the owner), and refuses every session's revision or proposed edits, so the file stays
the only source of revisions. Any session reads it and comments with `hoop_comment`, as on any
review; feedback carries `opened_by`. The command prints the link and opens it with `open` (macOS) or
`xdg-open`, unless `--no-browser` or `HOOP_NO_BROWSER` is set, or the pages can't be served.

hoop is organized around sessions, not projects. Home groups each section by owner, reviews a person
opened in an "Opened by <person>" group, and the rest in a "No session" group. `/api/reviews` gives
each review its `session` (`id`, `name`, `label`, and `live` while a `hoop mcp` entry in `sessions/`
records it) and its `place`: the name of the folder it was written in, and of its git repository
when that is another folder. Pages see names, never paths: the pages get neither `repo_dir`, `repo`
nor `source`. `POST /api/sessions/<id>/name` renames a session that owns a review: the name must be
one line of 1 to 100 characters; hoop writes it to `names.json` and appends
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
Origin, and a write that isn't JSON. It also takes every session's and command's writes (see "One
writer").

## Builds

A build (`src/build.ts`, `web/build.js`) is a review whose `review.json` says `build: "open"`. Its
first revision is the markdown Claude started it with; its page shows `build.json` instead: the
blocks, each with an ID that never changes, its kind (`h1`, `h2`, `h3`, `paragraph`, `list`,
`table`, `code`, `diagram`), its markdown and who wrote it last. Blank lines separate blocks outside
code fences, and a heading is always its own block. Each block keeps the exact text that follows it,
so a build's markdown is its blocks joined in order and exports byte for byte. The person adds,
edits, moves and removes blocks on the page (`POST /api/reviews/<id>/build`); an edit whose text is
several blocks becomes several blocks. The blocks read as an outline (`sectionRange`, `unitRange`,
`parentOf` and `swapRange` in `web/blocks.js`, shared by the server and the page): a heading owns
every block up to the next heading at its level or above. Moving a heading moves that whole unit past
the neighbouring section at its own level, never out of its parent; any other block moves only
among its section's own blocks. Removing a heading takes its section with it, or only the heading,
whose blocks then join the section above. Every change is a step: a snapshot of the block list
(`build-N.json`) whose block texts are stored once under their hash, so a step that changes one
block stores one new text, and any step reads back.

Generate on a section heading (`##` or `###`) adds a request to `build.json`, queued until the
build's owner session takes it with `hoop_build_wait`, which polls for queued requests and marks
them taken, then written by `hoop_build_write`. Claude's text replaces the section's blocks up to the
next heading at its level or above, and may not hold such a heading itself, so the outline stays the
person's. Its blocks carry `generated` until the person edits them, and the section's earlier blocks
are kept in `undo` for one Undo. Only the owner session takes requests or writes.

Suggest is the same request with a `kind`: `outline` on a `#` title, `subsections` on a section,
`next` on a section last among its siblings. `hoop_build_suggest` answers it with headings, starting
at the level the request allows (the anchor's for `next`, one below otherwise) and never more than
one level deeper than the one before. They are kept in `proposals`, outside the block list, so they
change neither the markdown nor its snapshots until the person accepts one: it becomes a heading
block after the nearest earlier accepted suggestion of its request, else at the end of the anchor's
section.

Finish (`POST /api/reviews/<id>/finish`, the person's alone) parses the build's markdown as the
review's next revision, with sections matched to the first revision's by heading, and drops
`build` from `review.json`, so the review flow takes over; `hoop_build_wait` then answers
`finished` with a cursor for `hoop_wait`. An unedited build exports from the review byte for byte. While a build is open, review actions on it are
refused.

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
to 600 seconds in Claude Code and 45 elsewhere, and returns `pending` with `again: true` and a
message, `Waiting for your review of "<title>" at <url>`; `hoop wait` prints the same line to stderr
and runs until a review or its timeout. Both return at once when a review came in after the cursor
(`src/wait.ts`). Claude Code ends an MCP tool call after `MCP_TOOL_TIMEOUT` (about 28 hours by
default) or, for a stdio server, after 30 silent minutes (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`); ten
minutes keeps a wide margin. Clients built on the MCP SDK give up on a request after 60 seconds
unless they set their own timeout, so other agents wait 45 seconds unless they pass `seconds`.

While a wait runs, it keeps `waits/<review>.<pid>.json` in the hoop folder. When it times out the
file says until when it still counts (30 seconds, the time to call again); when it returns a review
or is cancelled it counts no longer, and a file whose process is gone counts for nothing.

When a person submits a review on the page, the pages process tells the session that owns the review
(`src/wake.ts`), unless a wait is running or already read it: it finds the session's
`<claude dir>/sessions/<pid>.json` with a live process, and sends one message over its
`messagingSocketPath`, the same way as the Work page's steering: `<person> reviewed "<title>" in hoop:
<verdict>, N comments. Read it with hoop_feedback <id> and respond.` (for an approval, "then go on").
The outcome, `sent`, `waiting`, `no_session` or `failed`, is kept in `deliveries.json` by the receipt
key, returned with the submit for the page's notice, and shown beside an unread receipt. An agent's own
replies and comments are never sent. The review page's header says what the owner's session is doing:
waiting (a wait runs), idle or busy (and whether a submit can message it), or ended, with the
`claude --resume <session>` command to copy; it asks `/api/reviews/<id>/agent` every ten seconds while
visible. Home marks a review "Not read yet" while its latest review has no receipt and no wait runs.

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
`prs.json`, through the pages process (`src/prs.ts`); tracking it again changes nothing. The hoop
plugin's `PostToolUse` hook on Bash runs `hoop pr-hook`, which sends the URL a `gh pr create`
printed, for the hook's `session_id`, to the pages process; it always exits 0, and drops the URL
when no pages process answers. The pages process serves them at
`/api/prs`, reading each one's state with `gh pr view --json ...` only when Home asks, at most once
a minute, and never again once merged or closed. A failed `gh` reads as state unknown.

## Work

The plugin's hooks run `plugins/hoop/scripts/track-work.sh` on `PreToolUse` of the Agent tool,
`PostToolUse` of TaskCreate, TaskUpdate, TaskList, TaskGet, TaskStop, TodoWrite and Agent (once
named Task), and on `SubagentStart` and `SubagentStop`. Each hook is `async`, so Claude Code runs it
in the background; the script skips any other input without starting node and always exits 0. It
runs `hoop work-hook`, which sends an input that holds events (`workEvents` in `src/work.ts`) to the
pages process, which applies them to `work/<session>.json` (and drops it when none answers):

- Todos come from TaskCreate (`tool_response.task.id`), TaskUpdate (`tool_input.taskId`, status
  `pending`, `in_progress`, `completed` or `deleted`), and the whole list from TaskList or the
  legacy TodoWrite (which has no IDs, so a todo's ID is its place). They show as queued, running and
  done, ordered by their numeric ID. Background hooks can arrive out of order, so a creation never
  undoes a later update, a deleted task stays deleted, and an update before its creation shows the
  task by number until its text arrives. A todo keeps the latest `description` TaskCreate, TaskUpdate
  or TaskGet gave it (an empty one clears it); TodoWrite has none.
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
the file changes. For each review link in a todo's description (`http://localhost:4747/r/<id>`),
`titleReviews` adds the review's title from the store under the todo's `reviews`; the page shows a
description through `inlineHtml` in `web/inline.js`, a review link by its title in the same tab and
other links in a new tab. The Work page (`web/work.js`) asks every three seconds while visible; while a
form or confirmation is open it waits, so a refresh never drops what is being typed.

### Steering

`POST /api/work/<session>/changes` takes `{ changes: [{ kind, todo | agent, text?, description?, before | after? }] }`
behind the same Host, Origin and JSON checks as every write. `kind` is `remove`, `edit` or `move`
(a queued todo; an edit's `description`, when it differs from the todo's, edits that too), `comment` (a queued or running todo, or a running agent) or `stop` (a running
agent). `addChanges` in `src/steer.ts` checks a batch against the record and the changes before it,
all or none, and appends each to the record's `changes` with who (`currentUser()`), when and its
delivery: `pending` when the session runs and its `sessions/<pid>.json` names a
`messagingSocketPath`, else `waiting`. A move also changes the record's `queue`, the person's order
of todo IDs, at once (`moveInQueue`, starting from the order the page shows), and keeps the todo's
place among the queued todos before and after (`from`, `to`). Each hook keeps the queue to the
record's todos: deleted ones leave it and new ones join its end. Without a queue the agent's order
stands; `hoop_work_queue` gives the agent the queued todos in the order the page shows.

- **Message.** `Steer` batches a session's pending changes: three seconds after the last one it
  sends one message (`steerMessage`, with each run of moves of one todo as its last move) as one JSON line, `{"type":"user","message":{"role":"user",
  "content":…}}`, over the session's Unix socket, and marks them `sent`, or `waiting` when the send
  fails. A pages process that restarts sends what it left pending on the next `/api/work`.
- **Gate.** `plugins/hoop/scripts/gate-work.sh` runs on `PreToolUse` of every tool, synchronously.
  Each record write also writes small files beside it: `<session>.gate` while a todo change can
  stop a tool call, `<session>.agents` with `id<TAB>stop|note<TAB>person` lines, and
  `<session>.order` with the first queued todo in the person's order while there is a queue. Without
  any of them the script exits 0 once it has read the session ID, never starting node. It starts
  `hoop work-gate` only for a todo tool call (TaskUpdate, TodoWrite) while `.gate` exists, for one
  that sets `in_progress` on a todo other than the one `.order` names, or for a
  call whose input names an agent listed in `.agents`; the command sends the call to the pages
  process, which decides and records it. `workGate` refuses a removed todo whenever it is started or marked
  done, an edited todo once until the call sets its new subject and description, a waiting move or comment once, starting a queued todo while
  another queued todo comes first in the person's order once per pair (`queue_told`, so the agent can
  ask and go on), and every call whose top-level `agent_id` was stopped; it prints Claude Code's `deny` decision or `{}`.
- **Failing safe.** The gate fails open: a missing hoop, a crash, a timeout (a 20 s `perl` alarm,
  under the hook's 30 s) or output that isn't a decision lets the call go on, since every todo change
  also went by message and is recorded. The one exception is a stopped agent: when the input names an
  agent `.agents` lists as stopped (or that file can't be read), any of those failures refuses the
  call from the script itself (exit 2, with "Stopped by <person> in hoop's Work view" on stderr), so a
  stopped agent never runs on silently. Stops stay in the record and the file for good.
- **Seen or overridden.** After each hook, `settle` in `src/work.ts` compares open changes with the
  record: a removed todo deleted is `seen` and one started is `overridden`; an edit is `seen` when the
  todo reads the new subject and description or the gate told the agent, else `overridden` once it starts; a move is
  `seen` when its first todo starts first; a comment on a todo once the todo moves on; a stop once
  the agent ended or the gate refused it. The page shows the todos in the queue's order, one note per
  run of moves of one todo (each within ten seconds of the last), and every change with its delivery
  in a folded History under the todos.

