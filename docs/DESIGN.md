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
  actions-index.json       each action item kept in a session folder, with that folder's .hoop
  actions/ac_<id>.json     an action item from a session without a folder; a Claude Code session's are in
                           <claude dir>/projects/<folder>/<session>/.hoop/actions/
  names.json               the names people gave sessions on Home, by session ID
  sessions/                one entry per running `hoop mcp` session, with its Claude Code session
  plans/<session>.json     the plan hook's review for each Claude Code session
  prs.json                 tracked pull requests: URL, the session that opened it, when
  work/<session>.json      a Claude Code session's todos and subagents, from the plugin's hooks
  waits/<review>.<pid>.json  a wait on a review that runs, or just timed out
  pages.jsonl              the pages process's starts, restarts and stops, and the move of old reviews
```

Thread IDs (`th_<review>_<n>`) and edit IDs (`ed_<review>_<n>`) embed the review ID. An approved
review's text is frozen (no Apply, no decisions on proposed edits, `editable`), and a submit against
it creates a new review that supersedes it, until a person reopens it (see Verdicts). `src/rules.ts` holds
the rules on whether a review can change, and the thread lookup.

### Thread status

`threadViews` in `src/rules.ts` gives Claude every thread on a review, from every revision, as the
review page shows it. A thread is `resolved` once a reviewer resolved it and nothing was added since
(the page's rule). Otherwise it is `answered` when the owner session replied or proposed an edit
after the thread's latest entry from anyone else (a reviewer's comment, another session's
`hoop_comment`, or a rejection of a proposed edit), and `unanswered` before. It is `applied` when
the reviewer's own Apply of its suggestion, or their accepting Claude's edit for it, came after
both and nothing was asked after what it settled (the suggestion it applied, or the edit when
proposed): Claude owes no reply, so it stays out of a revision's `unanswered_threads`. A comment or
a rejected edit after that point, before or after the Apply, keeps it unanswered. Neither answered nor applied means the thread is settled:
only a reviewer resolves, and approval waits for that. Each thread carries its line's text on the revision it
was left on and on the latest one, and is outdated when they differ (`web/place.js`). Feedback
results list the unresolved threads in `threads` and the resolved ones in `resolved`; a session's
revision repeats the unanswered ones in its submit result (`hoop open` at a terminal doesn't, since
no session answers that review). The owner is the review's session, an earlier ID of it from before
`/clear` (`owners` in `review.json`), or the session running in its process since. A `hoop_wait`
that times out returns `pending` without threads; `hoop_feedback` reads them. A review that
supersedes an approved one (one nobody reopened) starts with no threads: they stay on the review
they were left on. A reopened review is revised in place and keeps its threads.

### One writer

The pages process is the only process that writes these files: every review's revisions, comments,
replies, answers, proposals, receipts, deliveries and renamed sections, the wait marks, the plan
hook's records, Work records and their gate files, tracked pull requests, action items, `names.json`,
`index.json` and `actions-index.json`. Sessions (`hoop mcp`), terminal commands and hooks read the files directly, through a
store opened read-only that refuses any write, and send each write to the pages process at
`POST /api/write/<action>` (`src/remote.ts`; the actions are `WRITES` in `src/writes.ts`):

- `op` runs an agent operation marked `writes` in `OPS` (submit, comment, reply, proposed edits,
  feedback with its receipts, asking and withdrawing a quick question, tracking a pull request,
  adding or withdrawing an action item,
  starting a build and writing or suggesting into it) for the caller's session, with the caller's folder, git repository and `.hoop` folder, so
  the review records the session's place.
- `receive` and `wait` are a wait's receipts (a quick question's, for the session that asked) and its mark, `build_take` the requests
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
A revision is refused when its `base_revision` isn't the latest revision, or, with or without
`base_revision`, while any revision has a submitted review the owner session hasn't received
(`Hoop.notStale`). A receipt lists the sessions that received the review (`sessions`), and only the
owner's counts, for the refusal and for the wake; a review without an owner, or a receipt from
before `sessions`, counts for anyone. The refusal is a `HoopError` whose `detail`
(`latest_revision`, and `unread` shaped as `hoop_feedback` returns it) reaches the agent through the
write route, the MCP error and the command's stderr; it records the owner's receipts for the
reviews it hands over, so the next submit goes through. The plan hook turns the refusal into a
denial that carries those reviews (`submitPlan`), and receives an approval it passes on.
Known gaps: the receipts are saved before the refusal is sent, so a refusal lost on the way (the
pages process restarting, or the 60-second write timeout) leaves the agent without `detail`, and
its next submit goes through. A pages process from a release before `base_revision` drops the
field (its schema strips unknown keys), so only the unread-review check applies until it hands over.
A revision can also be a list of section edits (`hoop_revise_sections`, `src/section-edits.ts`):
`replace_section`, `insert_section`, `delete_section` and `replace_text`, by section ID, on the latest
revision, with the same refusals. They apply in order to a copy of the document, and after each one
the document must read back the same from its markdown (no heading inside a section's text, no code
block left open), or none of them apply. A replaced section keeps the blank lines around its old text,
so every byte outside the edits stays; sections keep their IDs without matching by heading. A new
section, from section edits or a full revision, takes an ID above every one any revision used
(`highestSection`), so a deleted section's comments never land on it.
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

## Colors

Every page takes its colors from the tokens at the top of `web/app.css`, defined for the light and
the dark theme, and each color means one thing. Status badges name their tone in `web/status.js`.

| Token | Means | Where |
| --- | --- | --- |
| `--live` (amber) | Agent work running now (a clock icon), or your move (a person icon) | Running, Working, Checks running, a live session; Awaiting review, Waiting on you, open action items, an unsent comment. Also the current page in the nav, its one use that isn't live |
| `--ok` (green) | Finished well | Approved, Done, Checks passed, Merged, a recommended option |
| `--warn` (red) | Needs fixing | Changes requested, Checks failing, Stalled, Not running, a change the agent overrode, the pages-stopped banner |
| `--info` (blue) | A neutral fact, nothing to do | Commented, Building, In review, Not read yet (Claude hasn't read your review), what Claude generated or changed, the TL;DR, a new revision |
| `--muted` (grey) | Everything else | Queued, Idle, Ended, Withdrawn, Replaced, how far a comment got |
| `--link` | A link, always underlined | Links in notes, descriptions and action items |
| `--focus` | Keyboard focus and the line jumped to | Focus rings, a block being edited |
| `--pressed` | A toggle that is on, or a chosen option | Notify me, a quick question's chosen answer |
| `--mark` | Text that a comment is on | Highlights and selections on the review page |

Primary buttons are filled with `--ink`, not a color, so the next step stands out without claiming
a meaning. Amber means agent work running or your move, and nothing else but the current nav page:
a link, a toggle, an in-page tab or a button is never amber, and a new state that is neither picks
one of the other meanings. Home shows a review's or pull request's status only where it differs from
its section's usual one: Pending doesn't repeat Awaiting review, and Completed doesn't repeat
Approved, Answered or Merged; the hidden status stays in the row for screen readers. Every color
pair passes axe's contrast check in both themes (`test/pages.test.ts`), and `--mark-line`, the only
cue for highlighted words, keeps at least 3:1 against the surface, the paper and `--mark`.

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

A block that isn't a heading takes a request of its own (`src/revise.ts`, `web/revise.js`):
Generate again on a block Claude wrote (`rewrite`, with an optional note). `hoop_build_wait`
returns it with the block's ID and text; `hoop_build_write` with `block` replaces that block alone,
with any blocks but a heading, and the block as it was waits in `changes` until the person accepts
or undoes the rewrite. A write answers only the rewrite Claude took on that block, and only while the
block still reads as it did when taken (`given`): an edit, removal or Undo by the person, or Claude
writing its section, closes the request as `overtaken`, so a late write can't replace the person's
text. Other requests on the block follow it to its new ID, and one taken but unanswered is queued
again with the new text. An edit that splits a changed block adds the new blocks to the change, so
Undo restores it byte for byte; a change whose blocks are all gone is dropped.

A comment the person leaves in Preview, on a block or on words selected in it, is a thread
(`bt_<review>_<n>`) beside the block and a `revise` request with `selection` (and which
`occurrence` of it), the comment and the thread, under the same rules as `rewrite`; a write names
its `request` when Claude took more than one on the block. Claude answers with a block write, or
with `hoop_reply` on the thread: a reply never changes the document, so it needs no request taken,
only an open thread on a block still there. Threads follow their block through a rewrite and its
Undo, and are marked outdated when the rewrite drops the quoted words. A thread whose block is
removed shows under "On removed blocks", where the person can still resolve it; resolving closes the
request, and a later write or reply is refused. Every block shows formatted (Preview) until the
person opens it in Edit, one at a time or all at once; the page keeps what is typed in each open
editor across redraws, and an editor whose block is gone keeps its text under "Unsaved text for
removed blocks" until the person discards it.

Finish (`POST /api/reviews/<id>/finish`, the person's alone) parses the build's markdown as the
review's next revision, with sections matched to the first revision's by heading, and drops
`build` from `review.json`, so the review flow takes over. It is refused while any of Claude's
changes waits ("Accept or undo Claude's N waiting changes first") or a comment is open ("Resolve N
open comments first"), and the page also refuses it while an editor has unsaved text ("Save or
cancel your open edits first"); the refusal shows beside Finish, and focus goes to the first thing
it names; `hoop_build_wait` then answers
`finished` with a cursor for `hoop_wait`. An unedited build exports from the review byte for byte. While a build is open, review actions on it are
refused.

## Quick questions

`hoop_ask` (`Hoop.ask`) stores one to four questions as a review of kind `questions` with `ask` in
its `review.json`, owned by the asking session, so its folder, receipts, deliveries and waits are a
review's. Each question is an item `Q<n>` with choices `A` to `D`, exactly one recommended. Each
answer from its page (`POST /api/reviews/<id>/answer`, `Hoop.answer`) is one feedback entry on
revision 1 with verdict `comment`, only `answers` and the note as `summary`; Go with your
recommendation is one entry with `recommended: true` on each answer it took. A changed answer whose
earlier answer has a receipt carries `corrects` and wakes the session (`answerMessage` in
`src/wake.ts`); one Claude hasn't read replaces it quietly, with no message. The state (`askState` in
`src/rules.ts`) follows from these: `withdrawn` once `hoop_withdraw` recorded its reason, `open` while
a question lacks an answer, `closed` once every latest answer has a receipt, else `answered`.
`waitForAsk` returns once every question is answered after the cursor, on each answer with
`partial`, or on a withdrawal; no timeout answers. Only the asking session waits on, reads or
withdraws an ask (`mustAsk`), and `notAsk` refuses approving, requesting changes, commenting on or
revising one.

An ask may point at a line in an open review (`anchor`: `review_id` with `words`, or `item` and
`line`). `Hoop.askPlace` resolves it against the review's latest revision and stores it in
`ask.anchor` with that revision and the line's text; a missing, approved or building review, or a
line that isn't there, is refused. The review's view lists its anchored asks (`asks`), and
`web/review.js` places each card the way it places a thread: on the same item and line in later
revisions, marked outdated when the line's text changed, and under the item's last line when the
line is gone. The card is `web/ask.js`'s questions, answered through the ask's own route, so the
review's feedback, verdict and drafts are untouched.

## Anchors and scope

A comment points at `{item, line}`. Line 0 is an item's heading and covers its section, with every
section nested in it. Item `DOC` line 1 is the title, line 2 the TL;DR and line 3 the subtitle,
when the document has one; all three cover the whole document. The subtitle shows under the title
but takes the next free line, so the title's and TL;DR's anchors, and every comment already on them,
stay where they were. A comment may also carry a `range` (start, end and the exact quote) inside its line, or an
agent may send `words`, which hoop resolves to the one place they occur (`src/quote.ts`).

## Materializing comments

Two ways change a document, both in `src/materialize.ts` on top of `src/edit.ts`:

- A reviewer applies an exact suggestion, which replaces only the suggested span in a new revision.
  A suggestion to remove a section (`remove: true` on a document heading, line 0) is the one change
  to structure: Apply drops the section and every section nested in it, and leaves every other
  item as it was; when the removed section ended the document, the section now last loses its
  trailing blank lines. It applies only while those sections have the same headings, levels and
  lines as when it was suggested (blank lines aside, and less any subsection an applied removal
  already took), and never to the title, the TL;DR, text before the first heading, or when nothing
  else would remain (`removalProblem` in `src/contract.ts`). Applying the removal of a question
  settles it, so one review can't both answer a question and suggest removing it. The page offers
  Apply only when the same check passes (`removals` in the view).
- Claude proposes span edits for a comment (`find` and `replace`, with or without item and line).
  Each must stay in the comment's scope and pass the rules in `RULES` (fourteen, each refusal named);
  in documents an edit can't change markdown structure or empty a line. The reviewer accepts or
  rejects each one as a tracked change. A proposal applies only while its line reads exactly as
  when proposed; accepting one rebases the others on that line.

Text outside an accepted span, or a removed section, stays byte-identical.

## Markdown

`src/markdown.ts` parses any markdown into a review document. The first `#` heading is the title,
other headings start `section` items with their level, and the first paragraph is the default TL;DR.
A default TL;DR longer than 280 characters is cut with `clip()` (`src/util.ts`): at a sentence end
in its second half, else at a space, never inside a word. Home shows every review's and pull
request's summary clipped the same way, so a TL;DR Claude wrote is shown at most 280 characters long
there; the review page shows it whole.
Each block (a paragraph, a list item with its continuation lines, a code fence, a table row, a quote
line, a break) is one line to comment on; a block's source lines are joined with U+2028, so an
unedited document exports byte for byte. `web/blocks.js` shares the block grammar with the page.

A subtitle is optional: one source line of emphasis (`*words*` or `_words_`, `subtitleWords` in
`web/blocks.js`) of at most 120 characters that doesn't end with a sentence-ending period, right
under a `#` title that starts the document, after one blank line and before a blank line or the end.
The length and the period keep a one-sentence italic summary the TL;DR rather than a subtitle, and
a paragraph wrapped over several lines is never one. It becomes the document's `subtitle` (with
`subtitle_mark: "_"` for underscores) instead of a line of the introduction, and exports back in
the same place, so the document still exports byte for byte. Any other line of emphasis stays an
ordinary paragraph. A submitted subtitle, and an edit to one, must still read back as a subtitle. In
the builder, such a block is the Subtitle only as the block right after a title that starts the
document (`settleKinds` in `src/build.ts`); moved away it is a paragraph. + offers Subtitle only
there, while the document has none, and its field edits the words without the markers, switching
to the other marker when the words hold the one it had.

A section whose heading starts with `Question:` is a question; its top-level list items are the
options, named by a leading letter or in order, with `(recommended)` marking one. The page asks for
an answer to each, and **Other** is answered in a comment on the question. A request for changes
needs every answer. No approval carries answers: a revision with a question in it can't be approved
(see Verdicts), so the person answers with a request for changes and Claude writes the decision in.
Approvals from before took the recommended option for each unanswered question, sent with
`recommended: true`; the page still shows those as they were, and the contract still accepts
`recommended` only on an approval and only for the recommended option.

An answer given on an earlier revision stays in force while later revisions ask the same question:
the same section ID, title and options (`carriedAnswers` in `src/rules.ts`). The page shows it as
the answer, it counts toward the answers a comment needs, and the next feedback sends it again, so
the feedback on the latest revision always carries every answer, an approval's included. Section
IDs can pass to a different question when a revision restructures the document; that question
starts unanswered.

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

Approving and requesting changes need no sign-in: the page's Submit sends the verdict. Only people approve. Claude has no tool to approve, and its instructions
tell it never to approve for the person; `hoop_comment` always records a comment. A verdict from the
page names the reviewer as the user running hoop, and the page can't set a session.
A person's review has one of two verdicts, `approved` or `changes_requested` (`checkVerdict` in
`src/rules.ts`). The API refuses `comment` from the page, an approval that carries new comments
(they would ask for changes it doesn't make; its notes go in `summary`), and a request for changes
with no comment, no summary and no new answer; answers carried from an earlier revision don't count.
The page turns Approve and Looks good, go off while the reviewer has new comments, replies or
suggestions, and says why. `comment` stays in `hoop/feedback@0` for a session's `hoop_comment`, a
quick question's answers and reviews stored before, which keep their status (Commented) and history.

An approval is of a text with nothing left open (`approvalHolds` and `approvable` in
`src/rules.ts`), in every kind of document. Every thread, from any revision, must be resolved by the
reviewer, in the approval itself or before; an Apply or an accepted edit doesn't resolve it. A
thread on a section a later revision removed shows under On removed sections, where the reviewer
resolves it. A revision is approved only once no question remains in it: the reviewer answers with a
request for changes, and Claude revises the same review into a text that states the decisions,
without the questions. A structured decision document (`hoop_submit_decision`) is revised the same
way, with `hoop_submit` into a markdown document. The review view carries `approval_holds`; the page
adds what the reviewer hasn't sent (new comments, threads they resolve in this review) and turns
Approve off with the reason. A session's comment that lands after the page loaded is refused by the
API; the page then loads the review again, so the new conversation shows with Resolve, and says why
in the same words as the API (no thread IDs). On a review a person opened from a file, no session
revises it, so the reason says to write the decisions into the file and open it again. When a
decision document is revised into markdown, its sections take no IDs by place from it (only by
heading), so threads on its requirements wait under On removed sections. A review reopened before
`reopened` was kept counts as reopened while no revision followed the approved one (`isReopened`).

An approval isn't final. An approved review keeps taking comments on its page, and a person's
request for changes reopens it (`afterApproval`): its status goes back to open, `approved_revision`
keeps the revision that was approved and its approval stays in that revision's feedback,
`reopened_at` records when, `reopened` stays set until the owner's next revision (a reviewer's
Apply makes a revision without clearing it), and the status key is `reopened` ("Changes requested after approval")
until Claude submits a revision, which needs approving again. The review is delivered to the session
as any review is. Only a person reopens a review: `hoop_comment` on an approved review is refused,
and an approved review isn't approved twice. The plan hook still lets Claude leave plan mode once
the plan is approved; a later request for changes reaches the session as feedback.

A person closes a review or quick question they no longer need, without approving it: Close on its
page confirms in place with an optional one-line reason, and `POST /api/reviews/<id>/close`
(`Hoop.close`) stores `closed: {by, at, reason}` in `review.json`. It is no tool: only people close.
An approved, replaced or withdrawn review is done already and isn't closed. `status` stays as it was,
so the status key is `closed` ("Closed") while `closed` is set, Home lists it under Completed, and no
tab counts it as waiting. If the owner's session is live and isn't waiting on it, it gets "Closed in
hoop: <title> — <reason>" (`deliverClose`); `hoop_feedback` and `hoop_wait` carry `closed`, and a
wait on it returns at once. `notClosed` refuses a revision with the reason, as well as reviews,
answers, Apply and edit decisions. Reopen (`POST /api/reviews/<id>/reopen`) drops `closed`, which
brings back the status the review had.

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
`<claude dir>/sessions/<pid>.json` with a live process (by session ID, else by the process the
owner record names), and sends one message over its
`messagingSocketPath`, the same way as the Work page's steering: `<person> reviewed "<title>" in hoop:
<verdict>, N comments. Read it with hoop_feedback <id> and respond.` (for an approval, "then go on").
The outcome, `sent`, `waiting`, `no_session` or `failed`, is kept in `deliveries.json` by the receipt
key, returned with the submit for the page's notice, and shown beside an unread receipt: `sent` and
`waiting` as "Sent to Claude at <time>, not read yet". The submit's answer also carries the review's
whole view, so the page shows the new status and receipt from it at once, with no further request. An
agent's own replies and comments are never sent. The review page's header says what the owner's
session is doing: waiting (a wait runs), idle or busy (and whether a submit can message it), or
ended, with the `claude --resume <session>` command to copy; it asks `/api/reviews/<id>/agent` every
ten seconds while visible. While the latest review reached the session and isn't read, the header
leaves that line out, since it still says what the agent did before; it asks again as soon as the
receipt arrives. Home marks a review "Not read yet" while its latest review has no receipt and no wait runs.
Every page asks `/api/reviews` every 15 seconds, hidden or not (`web/pending.js`), counts the reviews
awaiting review and not superseded into the title and the favicon, and refreshes Home's list when it
changed. A review or revision that starts waiting while the tab is hidden shows a notification, once
the person pressed Notify me and the browser granted it; the first answer after a page loads only
records what already waits. While notifications are on, every page also asks `/api/work` every 15
seconds (`workAlerts`): a todo or subagent that comes to wait on the person or stalls, as the Work
page's counts read it, notifies once (`newAlerts`: again only after it was gone for a minute, so a
wait between two `hoop_wait` calls notifies once), and opens the Work page. Waiting on a hoop review
or ask is left out, since the review notifies as a new review. On a review's page the same answer shows a bar when the review has a
newer revision; the page changes only when the person presses Show it.

A Claude Code session's ID changes while its process runs: `/clear` rewrites
`sessions/<pid>.json` with a new `sessionId`, and `pid`, `procStart` and `startedAt` stay
(`/compact` and `claude --resume` keep the ID). So a review's or action item's owner record keeps
the process it was made in (`owner.process`: `pid` and `procStart`, read from that file in the
pages process), and the session running in that process now acts as the owner (`actsAs` in
`src/work.ts`). The caller's process is looked up in the session files, never taken from the
caller. That session is woken, shown in the header and on Home (which groups a terminal's reviews
under it), and may revise, reply, propose, read and withdraw quick questions, and withdraw action
items (`mustOwn`, `mustAsk`). Its wake message adds that an earlier conversation in the terminal
started the review, so it reads the document with `hoop_export` first. Its receipts name the
owner's ID too, so its read counts as the owner's (Home's "Not read yet", the stale-revision check,
wakes). A revision it submits makes it the owner, and what the old ID read stays read. A session
file counts only while its process started when `procStart` says (checked with `ps`, at most every
30 seconds), so a file a killed process left behind doesn't match a reused process ID. A known gap:
`/resume <other>` inside a running process also changes its ID, and hoop then follows the process
into that other conversation.

Unsent drafts (comments, suggestions, answers, resolutions, the overall comment and words in an open
comment box) live in `localStorage` under `hoop:<id>:drafts`, with the revision they were written on
and each comment's line text, and are cleared once sent. On each load `web/drafts.js` carries them
to the shown revision: a draft stays on its `{item, line}` while that line reads the same, follows a
line that moved within its section, and otherwise goes to a stale list shown at the top of the page,
to place again or discard. An answer stays while its option reads the same.

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
a minute, and never again once merged. A `gh` that fails because GitHub can't resolve the
repository or pull request ("Could not resolve to a Repository/PullRequest") reads as gone, which
Home lists under Completed; any other failure (no `gh`, signed out, network, rate limit, 5xx, an
HTTP 404 from a misrouted host) reads as state unknown and is asked again after a minute. A closed
or gone one is asked again after 30 minutes, or as soon as `gh api user` names someone else, since
a closed pull request can be reopened and GitHub also says "Could not resolve" of a private
repository the signed-in account can't see. An open `pr_merged` action item whose pull request is
gone or closed says so, so the person can press Won't do.

## Action items

`hoop_action` (`hoop action add`) records something only the person can do, in `src/actions.ts`,
with a `done_when` check: `pr_merged` (`gh pr view`, through the same `PrStates` cache as tracked
pull requests), `review_approved` (the store), `npm_version` (`npm view <pkg>@<version> version`) or
`manual`. No tool closes an item. The pages process checks open items when Home asks for
`/api/actions?check=1` on its poll, at most once a minute per item for `gh` and `npm`; the person
ticks a `manual` item done or says Won't do with a reason (`POST /api/actions/<id>`); the session
may withdraw its own item. All of these run under one queue key. A close by check, tick or Won't do
messages the session like a review does (`deliverAction` in `src/wake.ts`): "Done: <title>" or
"Won't do: <title> — <reason>".

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
files whose process is gone (`status` `busy`, or `waiting` while a dialog waits on the person and a call runs, reads
working); a running agent of an ended session shows as stopped. Unlike a
review's owner, a session that `/clear` replaced reads as ended here: its todos belong to the
cleared conversation, and the process's hooks report work under its new ID. A running
agent's last step is the last tool call or text at the end of its transcript, read again only when
the file changes. For each review link in a todo's description (`http://localhost:4747/r/<id>`),
`titleReviews` adds the review's title from the store under the todo's `reviews`; the page shows a
description through `inlineHtml` in `web/inline.js`, a review link by its title in the same tab and
other links in a new tab.

`/api/work` lists only agents an Agent call started (`src/subagents.ts`): one hoop saw the call,
description or type of, or whose `agent-<id>.meta.json` beside its transcript names an
`agentType` (which also gives its description). Claude Code's helper transcripts (summaries,
titles, classifiers) end with a bare `SubagentStop` and have neither, so they stay in the record
but never show. Each agent comes in plain words: a running one's `step` only when it names no file,
path, raw command or tool; an ended one's `outcome`, the first one or two sentences of its report
(its `SubagentHandback` message, else its last words) without markdown or paths, and the PR,
issue and review `links` the report names; a stopped or failed one's `reason` (a transcript that
ends in an API error is failed). The page keeps running agents on top, folds the rest under
"N finished", puts the type, raw last step and transcript path behind Details, and counts agents
beside a folded session only while they run.

The Work page (`web/work.js`) asks every three seconds while visible; while a
form or confirmation is open it waits, so a refresh never drops what is being typed.

Activity (`src/activity.ts`) comes from the last 256 KB of the session's transcript (the hook's
`transcript_path`, else found by session ID) and of each running subagent's, cached by size and
time: the newest entry's `timestamp` or the file's time, whichever is later, is the last sign of
life; its `tool_use` entries are steps in plain words, and one with no `tool_result` yet is still
running. `/api/work` adds `activity`, `doing` (the running call, else the latest, while busy) and
`recent` (the last five minutes, newest first, at most ten). Each todo keeps `since`, when its
status last changed, `started`, when it first ran (kept once done), and `blocked_by` from
TaskUpdate's `addBlockedBy` and `addBlocks` and TaskList's `blockedBy`; `/api/work` adds a running
todo's `links` (`linkTodos`): the reviews its description names (with `approved_at`, and the latest
revision's time), the pull requests it names that are open or not read yet (a merged one it names is
context), and those its session tracked that it owns (`prOwners`). A tracked pull request belongs to,
of the todos started by the time the session opened it, those whose subject names it, by its URL
(not as the start of a longer number), its `#N` or its head branch (one with a "/", "-" or "_"), else
those whose description does, else the one todo running then: a todo started later ("Builds on
#N") never takes it.
When no todo names it and several todos ran then, or none, it is the session's: `/api/work` gives it
under the session's `prs` while it is open or unread, and the page lists it as "Pull requests no todo
names", with what it needs from the person and its checks as a todo's link says them, since with parallel agents the todo that started last is often not the one that opened it.
Pull requests are read from `gh` in the background (draft, opened and merged times and head branch
too), so a state shows on the next poll; an unread one is "unknown", and an ended session's aren't
read an hour on.
The page (`web/activity.js`, `todoState`) derives each todo's state, first rule first: waiting on
the person, in review or done from its links (a merge or approval counts only after the todo first
started, so the plan or pull request it builds on doesn't, and never while a pull request is
unread), blocked, then for the session's
latest-started todo or one a running subagent works on, waiting (its open call is a hoop wait, ask
or build wait, or AskUserQuestion, `waitsOn`), stalled after 10 quiet minutes with no call running,
or running; any other todo in progress, or one whose session ended or idles with no subagent at
work, is not running. A permission prompt leaves no trace in the transcript until answered, and
leaves the session `busy`, so the script also runs on `PermissionRequest` and on the `Notification`
hook's `permission_prompt` (in the background, for a session with a record only). The first sets
the record's `prompts[agent_id or "main"]` (tool, a digest of each input field, time); the second
marks the prompts of its tool `shown`, since PermissionRequest also runs for calls a hook or a
headless session decides without a dialog. While a shown prompt's session or subagent has an open
call of its tool, started before it, whose input fields agree with the prompt's where both have
them (`prompted`), its `doing` waits on `permission`: "Waiting on you: a permission prompt in
Claude Code". Answering it, either way, gives the call its result, which ends it. A session file's
`waiting` status counts as busy only while a call runs, and a call that waits on nothing else then
waits on the dialog its `waitingFor` names: "Waiting on you: a dialog in Claude Code". It reads only;
the record keeps what the hooks said.

The script also runs on `Stop` (in the background) and `SessionEnd` (with a 2 s timeout, since
Claude Code's exit waits for its longest one; `hoop work-hook` gives up on the pages process after
1.5 s), for a session that has a record only. A turn's end sets the record's `turn_ended`, which
dates a todo left in progress in an idle session (unless it is from before the todo started, or a
minute before the last activity: an interrupted turn has no `Stop`). A session's end sets `ended`:
the session reads ended from then while no process runs it, or one does that hasn't updated more
than five seconds after it (a resumed session reads running again), and each subagent still
running stops. A hook more than five seconds later also means the session was resumed, and clears
it. Each todo keeps a `history` of `{ state, at }`, at most 20: the hooks add a status when it
changes (one they repeat adds nothing), and the pages process (`recordStates` in
`src/history.ts`, whose failure never fails the answer) adds each state `todoState` reads as it
answers `/api/work`, from that state's `since` when that comes after the last entry, else from
the last entry when that is the status it refines, else from now. A todo left in progress while
its session idles between turns keeps its status there, so turns don't fill it. The page adds
the state before the current one to the clock of a todo waiting on you, in review or blocked:
"for 3 h · after running for 40 m"; a running, stalled or not running todo's clock already says
how long it was marked running.

### Hooks and how they fail

`plugins/hoop/hooks/hooks.json` installs these hooks; each runs a script in
`plugins/hoop/scripts/`, which runs `$HOOP_BIN`, the `hoop` on PATH, or the pinned package through
`npx` (`hoop.sh`). An async hook runs in the background, so it never slows or fails the call;
Claude Code lets a call go on when a sync hook times out or exits with anything but 2. "No pages
process" means none answers on hoop's port.

| Hook (matcher) | Script: what it records or enforces | Sync, timeout | When it fails, times out, or hoop isn't running | What the person sees |
|---|---|---|---|---|
| PreToolUse (ExitPlanMode) | `plan-review.sh`, `hoop plan-review`: submits the plan as a review, waits for a verdict, then allows or denies the call with the review | sync, 600 s; hoop's alarm ends at 570 s | Fails closed: no hoop or npx, no `perl`, a crash, output with no decision or the alarm all exit 2 with the reason. No pages process: it starts one | Claude stops and says the plan wasn't reviewed; with no verdict in time, the deny carries the review's link |
| PreToolUse (Agent, Task) | `track-work.sh`, `hoop work-hook`: the Agent call's description and type, for its SubagentStart | async, 30 s | Fails open: dropped. No pages process: dropped, never started | The subagent shows by its type, without its description |
| PreToolUse (every tool) | `gate-work.sh`, `hoop work-gate` (only while a gate file names this call): refuses a todo call or start the person changed, a start out of their order or of a blocked todo, and a stopped agent's calls | sync, 30 s; hoop gets 20 s (`HOOP_GATE_ALARM`) | Fails open, allowing the call, except for an agent a person stopped: no hoop, a crash, a timeout or no decision refuse it (exit 2). No pages process: it starts one | A change stays "Waits for the gate"; a stopped agent is told to end its turn |
| PostToolUse (Bash) | `track-pr.sh`, `hoop pr-hook` (only for a command naming `gh pr create`): the pull request it opened, for the session | sync, 120 s; hoop is skipped for any other command | Fails open: exits 0, prints nothing. No pages process: dropped, never started | The pull request is missing from Home until `hoop_track_pr` adds it |
| PostToolUse (TaskCreate, TaskUpdate, TaskList, TaskGet, TaskStop, TodoWrite, Agent, Task) | `track-work.sh`, `hoop work-hook`: todos and their statuses, and each Agent call's result | async, 30 s | Fails open: dropped. No pages process: dropped | Todos lag until a later todo call; with no PostToolUse at all, "Hooks not firing" (below) |
| SubagentStart | `track-work.sh`: a subagent starts, matched to its Agent call | async, 30 s | Dropped | The subagent shows once the Agent call's result arrives |
| SubagentStop | `track-work.sh`: a subagent ends, with its last message and transcript | async, 30 s | Dropped | The Agent call's result ends it; a background one shows running until TaskStop or its session ends |
| Stop | `track-work.sh`: every session's turn end (for the stamp); `turn_ended` for a session with work. Without a global `hoop`, every turn pays an npx start, in the background | async, 30 s | Dropped | A todo left in progress isn't dated by the turn's end; with no hook at all, "Hooks not firing" |
| Stop | `stop-gate.sh`, `hoop stop-gate` (only while `work/<session>.stop` exists or a review in the session's folder has feedback newer than its receipts): blocks the turn's end once per unread review, answer or Work change (Steering, Stop gate) | sync, 6 s; hoop runs in the background and a watchdog stops it after 4 s (`HOOP_STOP_WAIT`; POSIX sh, no `perl`, so an npx start is bounded too), and hoop gives up on the pages process after 2 s | Fails open: no hoop, a crash, the watchdog or output with no block let the turn end; it always exits 0. No pages process: the turn ends, and none starts. Never runs for `stop_hook_active` or SubagentStop | Claude ends its turn with feedback unread, as before the gate; the feedback still waits for `hoop_feedback`, and a Work change for its message |
| SessionEnd | `track-work.sh` (a session with work only): `ended`, and stops its running subagents | sync, 2 s; `hoop work-hook` gives up after 1.5 s | Dropped; the exit waits at most 2 s | The session reads ended once its process is gone anyway; a resumed one runs again |
| PermissionRequest | `track-work.sh` (a session with work only): the prompt's tool and input digest | async, 30 s | Dropped | The row doesn't say "Waiting on you: a permission prompt" |
| Notification (permission_prompt) | `track-work.sh` (a session with work only): marks the prompt shown | async, 30 s | Dropped | As for PermissionRequest |

Every input that reaches the pages process through `work_hook`, `work_gate` or `pr_hook` stamps
`hooks/<session>.json`: `{ session, events, plugin? }`, the last time each `hook_event_name` arrived,
`PostToolUse:todo` for a todo tool's PostToolUse, and the plugin version of the latest
(`src/hook-health.ts`). `hoop.sh` exports that version as `HOOP_PLUGIN_VERSION`, read from the
plugin's `plugin.json`, and the hook commands send it on; an older plugin sends none. The pages
process, the one writer, writes the stamp in the same write, so no hook does more work or waits
longer: the gate and SessionEnd stamp only when they already reach hoop, and `track-work.sh` passes
every Stop on (in the background) so a session with no todos still stamps once a turn.

`/api/work` adds `hooks`, the running sessions whose hooks don't reach hoop (`hookWarnings`),
counting from the session file's `startedAt` or this pages process's start, whichever is later,
since a hook drops its input while no pages process runs. For an idle session whose transcript has
an assistant entry since then, over a minute old, that no interruption or API error follows (such a
turn runs no Stop hook; an API error runs StopFailure): `missing: "all"` with no stamp since then,
and `missing: "outdated"` with stamps but no Stop among them, or none naming a plugin version. Else
`missing: "todos"` for a todo call that old whose result isn't an error (PostToolUse runs only on
success, and the gate refuses some calls by design) and no `PostToolUse:todo` since then. A session
with no turn since it started is only idle and isn't listed. The Work page shows them under "Hooks
not firing", with the likely causes (the plugin missing, disabled or out of date, or `hoop` not on
the hooks' PATH) and what to do: `claude plugin list`, `claude plugin update hoop@hoop`, then restart
the session; for an outdated plugin, only the update.

### Steering

`POST /api/work/<session>/changes` takes `{ changes: [{ kind, todo | agent, text?, description?, before | after? }] }`
behind the same Host, Origin and JSON checks as every write. `kind` is `remove`, `move`, `park` or
`unpark` (a queued todo), `depend` (a queued todo starts `after` another in the list, not done or parked; refused when
that todo already waits for it, through blocked-by links, which would make a cycle), `edit` (a queued or running todo; its `description`, when it differs from
the todo's, edits that too; `was` keeps whether it ran), `add` (a new todo's `text` and optional
`description`, refused while a todo not done or an open add has that subject, case, spaces and
punctuation aside), `withdraw` (an open add the agent hasn't created, or a depend whose link holds, by `of`: a depend's link leaves `starts_after` at once; the add reads
`withdrawn` at once, and the withdraw needs no message when the add never went out), `comment` (a queued or running todo, or a running agent) or `stop` (a running
agent). A park adds the todo to the record's `parked` and an unpark takes it out; a parked todo
leaves the person's queue (`firstQueued`, `hoop_work_queue`, Up next and moves skip it) and keeps
its place for when it comes back. A depend adds its `after` to the record's `starts_after[todo]`
at once, which counts with the todo's own `blocked_by` (`blockersOf`): the Work view shows both as
Blocked by (with Withdraw on a link the person made), and `firstQueued`, Up next and
`hoop_work_queue`'s `blocked_by` skip or name the blockers that aren't done, removed or parked; a todo keeps them while it is queued. The page asks before a move that puts a todo
above one it starts after. The page's **Next** is a move before the first queued todo. `addChanges` in `src/steer.ts` checks a batch against the record and the changes before it,
all or none, and appends each to the record's `changes` with who (`currentUser()`), when and its
delivery: `pending` when the session runs and its `sessions/<pid>.json` names a
`messagingSocketPath`, else `waiting`. A move also changes the record's `queue`, the person's order
of todo IDs, at once (`moveInQueue`, starting from the order the page shows), and keeps the todo's
place among the queued todos before and after (`from`, `to`). Each hook keeps the queue to the
record's todos: deleted ones leave it and new ones join its end. Without a queue the agent's order
stands; `hoop_work_queue` gives the agent the queued todos in the order the page shows, and the
parked ones apart (`parked`, with `parked_note`).

- **Message.** `Steer` batches a session's pending changes: three seconds after the last one it
  sends one message (`steerMessage`, with each run of moves of one todo as its last move) as one JSON line, `{"type":"user","message":{"role":"user",
  "content":…}}`, over the session's Unix socket, and marks them `sent`, or `waiting` when the send
  fails. A pages process that restarts sends what it left pending on the next `/api/work`.
- **Read.** Each message ends with `(hoop-ref st_…)`, kept on its changes as `ref`, with the
  session transcript's size just before it went out (`sent_offset`). `transcriptReads` reads the
  transcript from the smallest offset of the sent changes on, each byte once (the next call goes on
  from where the last stopped), and gives each reference it finds in a user message, or in a
  `queued_command` attachment (a message queued while the agent worked, attached to its next step;
  the `queue-operation` entries only wait), with that entry's time. `workView` shows a sent change
  whose reference is there as `read`, with `read_at`, and one the whole read didn't find as
  `unread`; `/api/work` records only the newly read ones (`newlyRead`, `Steer.markRead`). The page
  shows the read time, and flags an `unread` change while its session idles after activity later
  than `sent_at`: the turn ended without it.
- **Replies.** The message names a comment by its ID (`ch_…`), and so do the gate's notes about
  it. Claude answers with `hoop_reply` on that ID (`replyToComment`), which appends `{by, body, at}`
  to the comment's `replies` and settles it `seen`. Only the session whose record holds the comment
  replies, or the session running now in the Claude Code process the comment recorded (`process`,
  from the Work page's comment), as after `/clear`. A reply to another kind of change, or with no
  text, is refused, and so is one once the todo is done or gone or the agent isn't running: the
  conversation lasts as long as its todo or agent, and a done one keeps its replies, read only. The
  page shows each reply under its comment and in History, and the comment's delivery as **Answered
  by the agent** with the latest reply's time.
- **Done from evidence.** When `/api/work` reads a todo the agent still has in progress as done
  from a pull request or review its own description names (`todoState`), `Steer.noteDone` adds a
  `done` change by `hoop` once per todo (by ID and subject, so a TodoWrite place holding another
  todo is a new one), for a session that takes messages and idles, and sends it the same way, in a
  paragraph of its own: "hoop sees PR #12 merged; if that finishes todo #3 …, mark it completed …,
  or say what's left". It is seen once the todo is done or gone. The gate never tells it.
- **One forward reader** (`src/transcript.ts`, `follow`). Read receipts and requests read a
  transcript through it, each byte once, in 1 MB chunks. It keeps each reader's place, and the last
  64 bytes before that place, in the pages process. A file that shrank or was rewritten is read again
  from the start.
- **Sources and requests** (`src/requests.ts`). Claude Code gives each turn a prompt ID, on every
  user entry of that turn (`promptId`) and in each hook input (`prompt_id`; a subagent's hook gives
  its session's). `transcriptRequests` maps each prompt ID to the request that started the turn, or
  to none. It decides by origin first:
  - a person's message (`origin.kind` "human") is a prompt, whatever it mentions
  - a peer's message (hoop's arrive as meta entries from a peer, after "Another Claude session sent
    a message:") is a request only in hoop's own format: a wake that starts as `wakeMessage` or
    `answerMessage` does and names `hoop_feedback rv_…`; a Work message that opens "From … " with
    `WORK_VIA` and ends with `(hoop-ref st_…)`; or a closed action item ("Done: …", "Won't do: …")
    that ends with `(hoop-action ac_…)`. Anything else a peer sends, such as another agent repeating
    one of these, is the agent's
  - a notification or continuation is the agent's
  - an entry with no origin is a slash command, as `/name args`, unless it is a local one (no
    prompt ID where the transcript has them, or followed by `<local-command-stdout>`); in older
    transcripts without origins, it is hoop's message by format, else plain text is a prompt

  Compaction summaries and entries only the transcript view shows start no turn. A person's
  message, wake or Work message the agent takes mid-turn (`queued_command`, `mid`) becomes the
  turn's request from then on, so the todos created after it are its. The work hook records a todo's `source` when TaskCreate creates
  it (by ID, even after an early update made it) or TodoWrite adds it (by text: past as many todos
  with that text as the list had, and a todo renamed in its place keeps its source), from the hook's
  `prompt_id`. Only the request's first line, at most 200 characters, is stored on disk; the full
  text stays in the reader's memory, for the page's Full text.
- **Waiting messages.** The same reader follows Claude Code's queue (`queue-operation` entries):
  an enqueue waits; a removal takes the entry with its text (the agent took it mid-turn, and the
  `queued_command` attachment after it is the request it became); a user entry delivers the queued
  message it reads as (a slash command as `/name args`, a socket message without its opening line),
  picked up at the dequeue just before it, so a dequeue whose enqueue came before the read, or one
  a local command's notes took, leaves the rest alone; popAll takes them all back to the prompt.
  Text in Claude Code's or another agent's tags (`task-notification`, `agent-message` and the like),
  hoop's own (ending with its `hoop-ref` or `hoop-action`) and the notice an `agents_killed` entry
  marks aren't the person's. Another session's message is queued as bare text: the entry that
  delivers it has origin `peer` and takes it off the list, as does any other origin but `human`.
  In a transcript with no origins (a headless run's), plain text that isn't a meta note delivers
  as the person's, as it reads as a prompt. Until then a queued message may be anyone's, so the
  page lists it as **Queued for the agent** and never as the person's. `/api/work` gives
  `waiting`: what is still in the queue while the session is busy, under two hours old and with no
  turn the person started (origin `human`) gone ahead of it, since a turn a notification, a peer
  or an interrupt starts leaves the queue alone; and the person's messages picked up in the last
  five minutes, with the todos each request became.
- **Requests view.** `/api/work` lists a session's last 30 requests with the todos each became
  (`requestOf`: a todo from a Work message that asked the agent to register a request counts for
  that request). A prompt is `unregistered` when all of these hold:
  - its turn edited files (Edit, MultiEdit, Write, NotebookEdit) and ran no TaskCreate, TaskUpdate
    or TodoWrite
  - it has at least five words and isn't a question: it doesn't end in "?" or start with what, how,
    is, are, did, can, why, should, do or does
  - it was made after `sources_from` and answered

  It stays so until the person dismisses it (`dismissed`, `POST /api/work/<session>/dismiss`).
- **Gate.** `plugins/hoop/scripts/gate-work.sh` runs on `PreToolUse` of every tool, synchronously.
  Each record write also writes small files beside it: `<session>.gate` while a todo change can
  stop a tool call, `<session>.agents` with `id<TAB>stop|note<TAB>person` lines, and
  `<session>.order` with the first queued todo in the person's order while there is a queue (never a
blocked one), and `<session>.blocked` with the queued todos blocked by one not done whose start the
gate hasn't refused yet. Without
  any of them the script exits 0 once it has read the session ID, never starting node. It starts
  `hoop work-gate` only for a todo tool call (TaskUpdate, TodoWrite) while `.gate` exists, for one
  that sets `in_progress` on a todo other than the one `.order` names or on one `.blocked` lists, or for a
  call whose input names an agent listed in `.agents`; the command sends the call to the pages
  process, which decides and records it. `workGate` refuses a removed todo whenever it is started or marked
  done, a parked todo once, an edited todo once until the call sets its new subject and description (a running
  todo's only when marked done), a waiting move, comment, add or withdraw once, starting a queued todo while
  another queued todo comes first in the person's order once per pair (`queue_told`, so the agent can
  ask and go on; never right after a parked todo's refusal), starting a queued todo blocked by one not
done once per blocker (`blocked_told`, naming each to start, or to finish when it runs; a parked todo's park speaks for it; the order then says nothing of it, and an open
depend on it counts as told), and every call whose top-level `agent_id` was stopped; it
  prints Claude Code's `deny` decision or `{}`. Only the session's own calls use up the one-time refusals: a subagent's
  todo call meets only the removed-todo rule.
- **Stop gate** (`src/stop.ts`). `plugins/hoop/scripts/stop-gate.sh` runs on `Stop`,
  synchronously, beside the async `track-work.sh`. It exits at once for any other event, for
  `stop_hook_active` (a stop the gate already blocked) and, without starting node, unless the
  record's `<session>.stop` file exists (written with the gate files while a Work change is `sent`,
  or `waiting` and not told by the PreToolUse gate, and not yet in `stop_told`) or a review in the session's `.hoop` beside its
  transcript has a `feedback-N.json` newer than its `receipts.json` (or no receipts). `hoop
  stop-gate` sends the input to the pages process (`stop_gate`, never starting one, 2 s at most),
  which reads the turn from the transcript's last 256 KB (`readTurn`). The turn opens at the first
  user message, not a tool result, after the previous turn's end (an assistant entry with
  `stop_reason` "end_turn", a `turn_duration` note or an interruption), or after the file's start
  when the tail holds the whole file; a later message that isn't a meta note, before any assistant
  entry, takes its place (a local command's notes come before the prompt). A message taken mid-turn
  opens nothing, so it never moves the start. The record's `turn_ended` (the previous Stop) starts
  the turn instead when it is later than that opener, inside the tail, and before the agent's last
  entry (this turn's own Stop, recorded in the background, comes after it). When neither is in the
  tail, as after one call larger than 256 KB, the turn ends. It blocks for each cause not in the
  record's `stop_told`:
  - feedback since the turn started on a review or quick question in the session's folder (not
    withdrawn, with no wait running on it) that the session has no receipt for
    (`feedback:<review>:<receiptKey>`): read it with `hoop_feedback`;
  - a Work change since the turn started (not a stop or hoop's own `done`) that `readChanges` finds
    `sent` but unread, or `waiting` and not yet told by the gate (`change:<id>`), with its
    `changeLine`.

  A check for a todo left in progress by a turn that did no work on it was dropped: replayed over
  485 real Stops, it blocked three times, each wrongly (a person's side question while the todo
  rightly waited on a merge or a review), and caught no real stall. #286 tracks a stall check from
  a real stall signal. All of a turn's causes go in one block, one line (`{ decision: "block", reason }`), and are added
  to `stop_told` (at most 50) in the same write; a session with no record gets one for it. Anything
  unreadable lets the turn end.
- **Failing safe.** The gate fails open: a missing hoop, a crash, a timeout (a 20 s `perl` alarm,
  under the hook's 30 s) or output that isn't a decision lets the call go on, since every todo change
  also went by message and is recorded. The one exception is a stopped agent: when the input names an
  agent `.agents` lists as stopped (or that file can't be read), any of those failures refuses the
  call from the script itself (exit 2, with "Stopped by <person> in hoop's Work view" on stderr), so a
  stopped agent never runs on silently. Stops stay in the record and the file for good.
- **Seen or overridden.** After each hook, `settle` in `src/work.ts` compares open changes with the
  record: a removed todo deleted is `seen` and one started is `overridden`; an edit is `seen` when the
  todo reads the new subject and description or the gate told the agent, else `overridden` once it starts (a running
  todo's, once it is done); an add is `seen` once a todo with its subject (as above) appears after it,
  not done (each todo keeps `created`, when hoop first saw it), which it then names (`todo`), and
  `overridden` by `Steer.settleAdds` on `/api/work` once its session ended, or idles 15 s after
  activity later than the add reached it; a withdraw is `overridden` if the todo appears anyway; a
  move whose first todo is parked is `seen`; a depend is `seen` once the todo's own `blocked_by` names
its blocker, the blocker is done or gone, or the gate told it, and `overridden` when the todo starts
before its blocker is done; a park is `seen` once unparked and `overridden` when the todo starts, which unparks it; an
  unpark once the todo starts; a move is
  `seen` when its first todo starts first; a comment on a todo once the todo moves on; a stop once
  the agent ended or the gate refused it. The page shows the todos in the queue's order, one note per
  run of moves of one todo (each within ten seconds of the last), and every change with its delivery
  in a folded History under the todos.


## Agent evals

hoop's tests check its code; the agent evals (`scripts/evals/`) check how Claude behaves with it.
Each trial runs `claude -p` with this checkout's plugin (`--plugin-dir plugins/hoop`, hoop through
`HOOP_BIN`, `--setting-sources project` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`, so the person's own
plugins, settings and claude.ai connectors stay out), in a fresh git repository with a fresh
`HOOP_HOME` and pages process on a free port, under a fresh session ID. The session runs on the
person's own Claude Code folder, so its transcript and hoop's review data for it live under
`~/.claude/projects/<repository>/`, found through the trial's `HOOP_HOME` index. A scripted person
(`person.ts`) plays the reviewer: it reads hoop's files read-only and writes only through the pages
API, one fixed step at a time, when hoop records Claude waiting on the review or Claude has stopped.
When Claude had stopped, the runner resumes the session with the message hoop would have sent it
(`wakeMessage`). Checks (`checks.ts`, `scenarios.ts`) are deterministic rules over the stream-json
transcript, the hoop data the trial left, and whether the repository changed before the person
approved; no model grades anything.

The scenarios (`scenarios.ts`):

1. `asks-for-review`: one review, a title that names the decision, a summary, well-formed questions
   and the link given once.
2. `waits-properly`: the person holds the review until a wait times out; every `hoop_wait` passes
   the cursor, a wait that says `again: true` is followed by another, the link isn't repeated, and
   nothing is written before approval.
3. `answers-every-comment`: five comments of different kinds; each gets a revision, a changed line,
   a proposed edit, or a reply (after a request for changes, only with a later revision).
4. `uses-exact-edits`: the person asks, with a request for changes, to rename a word on one line;
   Claude proposes it with `hoop_propose_edits`, the person accepts every edit (one hoop refuses as
   stale stays proposed and fails; any other refusal stops the person), and the revision the edit
   made reads as the commented one with only that line renamed.
5. `revises-after-changes`: the person picks the option Claude didn't recommend and asks for a
   rollback step; Claude revises the same review, the question is gone, one line of the latest
   revision names the chosen option and no other (a name is an option's label outside brackets or
   a bracketed part, up to its first comma, colon or dash, without words the heading or every other
   option has, in any word order), the rollback step is added or proposed as an edit, Claude waits
   again, and writes nothing before approval. A paraphrase that leaves out the option's name fails.

A trial's record (`evals/runs/<time>/<scenario>-<n>.json`, ignored by git) holds the model, the
hoop release, the plugin's commit (`-dirty` with uncommitted changes), the scenario's script
version, the transcript and the reviews. The report gives each scenario's and each check's pass
rate, with the trials, turns and spend; a failed check prints its reason and the calls around the
one at fault. A passing trial's repository, hoop folder and Claude Code state (`claude purge`) are
removed; a failing or timed-out one keeps all three and prints where. Cost guards, for each trial
across its resumes: `--max-turns` and `--max-usd`, no resume after a run stopped at either limit,
at most four resumes, and a time limit that kills the run (the trial is marked timed out, and its
turns and spend are a lower bound); `--max-trials` caps the run. The suite runs on the person's own
Claude Code sign-in and never in CI; `test/evals.test.ts` runs the checks on recorded trials in
`test/fixtures/evals/`, and the trial loop against a fake `claude` that plays recorded stream-json.
