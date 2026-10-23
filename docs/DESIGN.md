# How hoop works

hoop is one Node package (`src/`, built to `dist/`) with static pages in `web/`. It runs as an MCP
server on stdio (`hoop mcp`), as terminal commands, and as one background process that serves the
review pages.

## Contract

`src/contract.ts` defines both formats with zod: `hoop/review@0` (a document: title, TL;DR, kind,
and items with an ID, a type, a title and a body) and `hoop/feedback@0` (a verdict, comments,
answers to questions, resolved threads). The published JSON Schema files in `schemas/` and the
field tables in `docs/FORMATS.md` are generated from it by `scripts/schemas.ts`, and a test checks they match.

Every agent tool and terminal command comes from one list, `OPS` in `src/ops.ts`: a name, an input
schema, a `run` function and a `cli` mapping. `src/mcp.ts` and `src/cli.ts` only adapt it.

## Store

Reviews are JSON files under `~/.hoop` (`HOOP_HOME`), written through a temp file and a rename
(`writeAtomic`). There is no database, so `npx` installs need no native modules.

```
~/.hoop/
  config.json              the person's own settings (sign-in)
  signins.json             live sign-ins: login and expiry by the hash of each sign-in ID (0600)
  reviews/rv_<id>/
    review.json            status, revision count, repository, owner, supersedes / superseded_by
    rev-N.json             each revision's document
    feedback-N.json        the feedback given on revision N
    replies.json           replies in threads
    proposals.json         edits Claude proposed, and their decisions
    applied.json           suggestions and edits materialized into revisions
    renamed-N.json         sections matched by place in revision N
  sessions/                one entry per running `hoop mcp` session
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
`session_id`), with the session's title (`src/owner.ts`). The title is the last `custom-title`, or
else the last `ai-title`, in the end of the session's transcript,
`<claude dir>/projects/*/<session>.jsonl`; the Claude dir is `HOOP_CLAUDE_DIR`, `CLAUDE_CONFIG_DIR`
or `~/.claude`. Only the owner revises, replies or proposes edits (`mustOwn` in `src/rules.ts`);
another session comments with `hoop_comment`, which records `session` in its feedback; a process
without a session only reads. A review without an owner goes to the first session that changes it.
The page's own actions are people's and need no session.

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

On a new revision, section IDs stay stable: first by heading, then by place for a renamed heading
at the same level, under the same parent.

## Sign-in

Approving and requesting changes need a GitHub login; a comment needs none. The pages process runs
GitHub's device flow with hoop's OAuth App (or `github_client_id` in `config.json`), asking only for
the login and keeping no token. A sign-in lasts 24 hours. The browser holds its ID in `localStorage`
and sends it as `x-hoop-signin`. The pages process keeps the login and expiry under the ID's SHA-256
hash in `signins.json` (mode 0600), so a restart keeps sign-ins and the file alone signs no one in. `"signin": false` in
`config.json` turns it off. A repository can't change these settings.

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
