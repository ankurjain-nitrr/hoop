# How hoop works

hoop is one Node package (`src/`, built to `dist/`) with static pages in `web/`. It runs as an MCP
server on stdio (`hoop mcp`), as terminal commands, and as one background process that serves the
review pages.

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
database, so `npx` installs need no native modules.

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
  reviews/rv_<id>/         a review from outside any session; in a session, the same files are in
                           <claude dir>/projects/<folder>/<session>/.hoop/reviews/rv_<id>/
    review.json            status, revision count, folder and git repository, owner, supersedes / superseded_by
    rev-N.json             each revision's document
    feedback-N.json        the feedback given on revision N
    replies.json           replies in threads
    proposals.json         edits Claude proposed, and their decisions
    applied.json           suggestions and edits materialized into revisions
    renamed-N.json         sections matched by place in revision N
  names.json               the names people gave sessions on Home, by session ID
  sessions/                one entry per running `hoop mcp` session, with its Claude Code session
  plans/<session>.json     the plan hook's review for each Claude Code session
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

A review's `owner` is the Claude Code session that submitted it (`CLAUDE_CODE_SESSION_ID`, which
Claude Code sets for the MCP server and shell commands; the plan hook also takes its input's
`session_id`), with the session's title (`src/owner.ts`). The title is the last `custom-title` in
the end of the session's transcript, `<claude dir>/projects/*/<session>.jsonl`, else the name given
on Home (`names.json`), else the last `ai-title`; the Claude dir is `HOOP_CLAUDE_DIR`,
`CLAUDE_CONFIG_DIR` or `~/.claude`. Titles are read again whenever the transcript's size or time
changes, so the pages show a rename at once. Only the owner revises, replies or proposes edits (`mustOwn` in `src/rules.ts`);
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
an answer to each, and **Other** is answered in a comment on the question.

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

## Plan hook

The hoop-plan plugin (`plugins/hoop-plan/`) runs `hoop plan-review` before `ExitPlanMode`
(`src/plan.ts`). The first plan of a session is submitted as a review, a changed plan becomes a
revision, and an approved, unchanged plan is allowed. Otherwise the hook waits for a review (up to
`HOOP_PLAN_WAIT_SECONDS`, 540 by default) and denies with the reviewer's answers and comments, or
with the link when no verdict comes. It fails closed.
