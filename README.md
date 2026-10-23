# hoop

Review what an agent writes the way you review code. An agent such as Claude submits a document to
hoop: a plan, a set of requirements, a decision, a policy or a letter. You read it on a local page,
comment on lines or selected words, suggest changes and answer its questions. The agent reads your
review back as data, revises, and goes on only after you approve. Comments can be turned into edits
that change as few words as possible, and a markdown document comes back out byte for byte, with
only the reviewed changes in it.

> **Status: before 1.0.** Tool names, commands and stored files may still change. The
> `hoop/review@0` and `hoop/feedback@0` formats are versioned. See [`CHANGELOG.md`](CHANGELOG.md).

## Install

You need Node 18.18 or later. The package isn't on npm yet, so install it from source:

```sh
git clone https://github.com/ankurjain-nitrr/hoop && cd hoop
npm install && npm link          # builds dist/ and puts `hoop` on your PATH
claude mcp add hoop -- hoop mcp
```

Start Claude Code in your project folder; hoop treats the folder it starts in as the repository.
Any other MCP client can run `hoop mcp` the same way, with `HOOP_REPO_DIR` set to the repository
when the client doesn't start servers in the project folder.

To remove it: `claude mcp remove hoop`, `npm rm -g hoop`, and `rm -rf ~/.hoop` to delete every
stored review and your settings.

## The review loop, from the agent's side

| Tool | Does |
|---|---|
| `hoop_submit` | Submits a markdown document, or a new revision of one with `review_id`. Returns the review's link and a `cursor`. |
| `hoop_submit_decision` | Submits a structured `hoop/review@0` document, with requirements, options and questions. See [`examples/order-export.json`](examples/order-export.json). |
| `hoop_wait` | Waits up to 45 seconds for a review that came in after `after` (a cursor). Returns `pending` with `again: true` when none came, so the agent calls it again. |
| `hoop_feedback` | Returns `pending`, or the feedback on the latest revision: verdicts, comments with their scope, answers and replies. |
| `hoop_reply` | Replies in a comment thread. |
| `hoop_propose_edits` | Answers a comment with span edits (`find` and `replace`) that the reviewer accepts or rejects as tracked changes. |
| `hoop_export` | Returns the latest revision as markdown, with every applied change in place. |

A typical loop: submit, wait, read the feedback, reply or revise (submit again with the same
`review_id`), and go on only after an approval. Submitting against an approved review starts a new
review that supersedes it. The old name `hoop_submit_markdown` still works and returns a notice.

An edit that breaks one of fourteen rules is refused, and the refusal names the rule. For example,
`find` must occur exactly once in its line, and an edit never empties a line or changes markdown
structure. An edit applies only while its line reads exactly as when it was proposed.

## The review page, from a person's side

1. Open the link the agent gives you, such as `http://localhost:4747/r/<review_id>`. The outline at
   the side is a tree of the document's sections. Tables show as tables, and Mermaid diagrams are
   drawn in a sandboxed frame.
2. Comment on a line, or select words and comment on just those. A comment on a heading covers its
   section. A comment on the title or the TL;DR covers the whole document.
3. Suggest an exact change: select words and delete or replace them, or edit a line in place. A
   suggestion has **Apply**, which changes only that text in a new revision.
4. Answer the document's questions. In markdown, a section whose heading starts with `Question:`
   asks one; its top-level list items are the options (`A.` or `B)` names an option, and
   `(recommended)` at the end marks one). Every question needs an answer before you submit. Pick
   **Other** to answer in your own words, in a comment on the question.
5. Submit your review: comment, request changes or approve. A comment needs nothing more.
   Approving or requesting changes needs a GitHub sign-in in that browser: the page shows a code
   that you confirm on GitHub, and the sign-in lasts eight hours. Approving freezes the review.
6. The agent answers. It may reply in your threads, revise the document, or propose edits with
   **Accept** and **Reject**. A new revision shows what changed since the last one, and marks
   comments whose line changed as outdated.

`/` lists every review by status and project. Each review shows its history: every comment,
request for changes and approval, with who and when.

## Review plans before Claude Code acts

The hoop-plan plugin opens each plan as a review before Claude Code leaves plan mode. The agent
goes on only after you approve, and gets your comments otherwise. It fails closed: when `hoop` is
missing or gives no decision, the agent stops. It needs `hoop` and `perl` on your PATH.

```sh
claude plugin marketplace add ankurjain-nitrr/hoop
claude plugin install hoop-plan@hoop
```

## Markdown in and out

The first `#` heading is the title, other headings start sections, and each paragraph, list item,
table row, quote or code block is one line to comment on. The TL;DR defaults to the first
paragraph. `hoop_export` writes the document back: an unedited document comes out byte for byte,
and an edited one differs only inside the accepted edits.

## Commands

Every tool has a command, for agents without MCP. Commands print text, or JSON with `--json`, and
exit 1 with the tool's message on failure. `hoop help` lists them.

| Command | Does |
|---|---|
| `hoop mcp` | Runs the MCP server on stdio, and makes sure the pages are served. |
| `hoop serve` | Serves the pages in the foreground. |
| `hoop submit <file.md> [--review <id>] [--title <t>] [--tldr <t>] [--slug <s>]` | `hoop_submit`. |
| `hoop submit-decision <file.json>` | `hoop_submit_decision`. The old name `submit-json` still works. |
| `hoop feedback <review_id>` | `hoop_feedback`. |
| `hoop wait <review_id> [--timeout <seconds>]` | Runs until a review arrives, then prints it as JSON. Exits 0 on a review, 3 on a timeout. |
| `hoop propose <review_id> <thread> <edits.json> [--note <text>]` | `hoop_propose_edits`. |
| `hoop reply <thread> <text>` | `hoop_reply`. |
| `hoop export <review_id> [--out <file>]` | `hoop_export`. |
| `hoop plan-review` | The hook command the hoop-plan plugin runs. |

## Settings

Your own settings live in `~/.hoop/config.json`; no repository can change them.

- `"signin": false` lets approving and requesting changes work without GitHub.
- `"github_client_id": "<client id>"` uses your own GitHub OAuth App for the sign-in. The sign-in
  asks GitHub only for your login and stores no token. See [`SECURITY.md`](SECURITY.md).

From the environment: `HOOP_HOME` moves `~/.hoop`, `HOOP_REPO_DIR` sets the repository (the current
folder by default), and `HOOP_PORT` sets the port (4747).

hoop writes only under `~/.hoop`: reviews in `reviews/<id>/`, a record per running session in
`sessions/`, each session's plan review in `plans/`, and the pages process's starts and stops in
`pages.jsonl`. It writes nothing into your repositories. One background pages process on
`127.0.0.1:4747` serves every session; a session or command starts it when nothing answers there,
it restarts into new code after an update, and it stops after an hour with no session and no page
open.

## Formats

A review document is `hoop/review@0`, and feedback is `hoop/feedback@0`. Both are published as JSON
Schema in [`schemas/`](schemas/), and the tables below come from the same source. An item's lines
are its body lines, then a question's choices, then its check. Line 0 is the item's heading. Item
`DOC` line 1 is the title and line 2 the TL;DR.

A review document:

<!-- fields:review -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema` | `"hoop/review@0"` | yes | The format and its version. |
| `review_id` | string or null | no | Set to revise an existing review. |
| `revision` | integer | no | Set by hoop: the revision number. |
| `kind` | `requirements`, `slice_map`, `plan`, `questions`, `decision`, `doc` | yes | What the document is; doc for any markdown document. |
| `slug` | string | yes | A short name for the document, such as order-export. |
| `title` | string | yes | The document's title. |
| `tldr` | string | yes | One or two sentences for the reviewer. |
| `context` | object | no | Where the document comes from: a repository, a branch and links. |
| `items` | list of object | yes | The document's items, in order. |
| `asks` | `approve_all`, `per_item`, `choose` | no | What the agent asks the reviewer to do. |
| `tldr_auto` | boolean | no | True when the TL;DR was copied from the first paragraph: edit that paragraph, not the TL;DR. |
| `spacing` | `"exact"` | no | With exact, blank lines around headings are kept in section bodies and exported as they are. |
<!-- /fields:review -->

An item:

<!-- fields:item -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | The item's ID, such as FR-3; unique in the document. |
| `type` | `requirement`, `slice`, `step`, `question`, `option`, `note`, `section` | yes | What the item is. |
| `title` | string | yes | The item's heading. |
| `body` | string | no | The item's text; each non-empty line is one line to comment on. |
| `check` | string | no | How a test or a reviewer checks the item. |
| `choices` | list of object | no | A question's options. |
| `risk` | `low`, `medium`, `high` | no | The agent's estimate of the item's risk. |
| `depends_on` | list of string | no | IDs of items this one needs first. |
| `level` | integer | no | A document section's heading level; 0 for text before the first heading. |
<!-- /fields:item -->

Feedback:

<!-- fields:feedback -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema` | `"hoop/feedback@0"` | yes | The format and its version. |
| `review_id` | string | yes | The review this feedback is on. |
| `revision` | integer | yes | The revision it was given on. |
| `verdict` | `comment`, `approved`, `changes_requested` | yes | The reviewer's verdict; approving or requesting changes on the page needs a GitHub sign-in. |
| `summary` | string | no | An overall comment, or an approval's notes. |
| `comments` | list of object | no | Comments and replies. |
| `answers` | list of object | no | Answers to questions: each question's ID and the chosen option, or the reviewer's own words. |
| `resolved_threads` | list of string | no | Threads this feedback resolves. |
| `viewed` | list of string | no | Items the reviewer marked as viewed. |
| `reviewer` | string | yes | Who gave it, as they named themselves. |
| `at` | string | yes | When, as an ISO 8601 time. |
| `signed_in` | object | no | The person's GitHub login, when the verdict came with their sign-in in the browser. |
<!-- /fields:feedback -->

A comment:

<!-- fields:comment -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `thread` | string | no | The thread a reply belongs to; leave out for a new comment. |
| `item` | string | yes | The item's ID, or DOC for the title and TL;DR. |
| `line` | integer | yes | The line, from 1; 0 is the item's heading, and DOC line 1 is the title and 2 the TL;DR. |
| `range` | object | no | The words the comment is about, inside the line. |
| `body` | string | no | The comment's text. |
| `suggestion` | string | no | Replacement text for the range, or for the whole line. |
<!-- /fields:comment -->

## Develop

[`docs/DESIGN.md`](docs/DESIGN.md) describes how hoop works. [`CONTRIBUTING.md`](CONTRIBUTING.md)
says how to build, test and send a change. Report a vulnerability as [`SECURITY.md`](SECURITY.md)
says.

## License

Apache License, Version 2.0. See [`LICENSE`](LICENSE).
