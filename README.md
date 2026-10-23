# hoop

Keep a person in the loop on what an agent writes. Claude puts a plan, a design, a decision or any
document into hoop; you review it on a local page the way you review code: comment on lines or
words, suggest changes, answer its questions, then approve or ask for changes. Claude reads your
review, revises, and goes on only after you approve.

Every Claude session on your machine uses the same hoop, at `http://localhost:4747`.

> **Status: before 1.0.** Tool names, commands and stored files may still change. See
> [`CHANGELOG.md`](CHANGELOG.md).

## Get started

You need Node 18.18 or later and Claude Code. Install hoop's plugin, which holds the MCP server,
the plan hook and the pull request hook:

```sh
claude plugin marketplace add ankurjain-nitrr/hoop
claude plugin install hoop@hoop
```

`hoop init` (or `npx -y github:ankurjain-nitrr/hoop init`) runs these two for you, and
`hoop init --print` only prints them. If you installed the old `hoop-plan@hoop` plugin, run
`claude plugin uninstall hoop-plan@hoop` first, and if you added hoop with `claude mcp add`, run
`claude mcp remove hoop`, so its tools aren't listed twice.

The plugin runs the `hoop` on your PATH, or, without one, the package from GitHub through `npx`;
the first run builds it, which takes under a minute. For other setups, add the MCP server alone:

```sh
claude mcp add hoop -- npx -y github:ankurjain-nitrr/hoop mcp
```

The package isn't on npm yet. Once it is, its spec becomes `@ankurjain-nitrr/hoop`, in place of
`github:ankurjain-nitrr/hoop` here and in `HOOP_PACKAGE` in `plugins/hoop/scripts/hoop.sh`.

Then ask Claude for something you want to review, for example:

> Draft a plan for moving our invoices to the new billing service, and send it to hoop for my
> review.

Claude replies with a link. Review the document there and submit your review. Claude picks it up,
answers your comments, revises, and repeats until you approve.

No skill is needed for this: when a session connects, hoop tells Claude when to ask for a review,
how to write the document and its questions, and to go on only after you approve.

## Reviewing a document

- **Comment** on a line, or select words and comment on just those. A comment on a heading covers
  its section; a comment on the title covers the whole document.
- **Suggest a change**: select words and replace or delete them, or edit a line in place. You can
  **Apply** a suggestion yourself; Claude can also propose edits that you **Accept** or **Reject**,
  shown as tracked changes.
- **Answer questions.** Claude asks one in a section headed `Question: …`, with lettered options and
  one marked recommended. Pick an option, or pick **Other** and answer in a comment. Every question
  needs an answer before you submit.
- **Submit** your review as a comment, a request for changes, or an approval. Approving or
  requesting changes needs a GitHub sign-in in that browser, so a verdict is always a person's:
  the page shows a code you confirm on GitHub, and the sign-in lasts 24 hours, across restarts of
  the pages. An approved review is frozen.
- **Each revision** shows what changed since the last one, and marks comments whose line changed
  as outdated. Every review keeps its history: each comment, request for changes and approval,
  with who and when.

Home, at `http://localhost:4747/`, lists every review in two sections, Pending and Completed
(approved or superseded), newest first. Each shows its title and its TL;DR in at most two lines.
Home also lists the pull requests Claude sessions opened: open ones under Pending, with the start
of their description, whether checks are running, failing or passed, conflicts with the base
branch, a review asked of you, or ready to merge, and the session that opened them; merged or
closed ones under Completed. hoop reads their state with `gh` only while Home is open, at most once
a minute each; without `gh` or a sign-in, Home says "State unknown".

## Review Claude's plans before it acts

The plugin opens each plan as a review before Claude Code leaves plan mode, and Claude goes on only
after you approve it. If hoop is missing or gives no decision, Claude stops rather than going
ahead. It also tracks each pull request a session opens with `gh pr create`, for Home, and never
blocks or fails that command. The plan hook needs `perl` on your PATH.

## For agents

hoop is an MCP server. These are its tools:

| Tool | Does |
|---|---|
| `hoop_submit` | Submits a markdown document, or a new revision of one with `review_id`. Returns the review's link. |
| `hoop_submit_decision` | Submits a structured `hoop/review@0` document with items, options and questions. See [`examples/order-export.json`](examples/order-export.json). |
| `hoop_wait` | Waits for the next review. Returns `pending` with `again: true` when none came yet, so the agent calls it again. |
| `hoop_feedback` | Returns the feedback on the latest revision: the verdict, comments with their scope, answers and replies. |
| `hoop_reply` | Replies in a comment thread. |
| `hoop_propose_edits` | Answers a comment with small `find` and `replace` edits that the reviewer accepts or rejects. |
| `hoop_comment` | Comments on a review that another Claude session submitted. |
| `hoop_export` | Returns the document as markdown, with every accepted change in place. |
| `hoop_track_pr` | Tracks a pull request the session opened, so Home shows it. The plugin tracks `gh pr create` on its own. |

The loop: submit, wait, read the feedback, reply or revise with the same `review_id`, and go on
only after an approval. Markdown goes out byte for byte: an unedited document exports exactly as it
came in, and an edited one differs only inside the accepted edits. The first `#` heading is the
title, other headings start sections, and each paragraph, list item, table row, quote or code block
is one line to comment on. Tables show as tables, and Mermaid diagrams are drawn.

Each review belongs to the Claude session that submitted it. Only that session may revise it, reply
in its threads or propose edits. Any other session may read it and comment with `hoop_comment`, and
a terminal outside any session only reads. The page and the feedback name a session by its title
and the start of its ID, such as `Order export (ac57df4d)`.

Every tool also has a command, for agents without MCP. `hoop help` lists them:

| Command | Does |
|---|---|
| `hoop submit <file.md> [--review <id>]` | Submits a document, or a revision. |
| `hoop submit-decision <file.json>` | Submits a structured document. |
| `hoop wait <review_id> [--timeout <seconds>]` | Waits for a review and prints it as JSON. Exits 0 on a review, 3 on a timeout. |
| `hoop feedback <review_id>` | Prints the feedback. |
| `hoop reply <thread> <text>` | Replies in a thread. |
| `hoop comment <review_id> <item> <line> <text>` | Comments on another session's review. |
| `hoop propose <review_id> <thread> <edits.json>` | Proposes edits for a comment. |
| `hoop export <review_id> [--out <file>]` | Writes the document as markdown. |
| `hoop track-pr <url>` | Tracks a pull request for the session it runs in. |
| `hoop mcp` | Runs the MCP server, and starts the pages if nothing serves them. |
| `hoop serve` | Serves the pages in the foreground. |
| `hoop init [--print]` | Installs the plugin with `claude`, or prints the two commands. |
| `hoop plan-review` | The plan hook command the plugin runs. |
| `hoop pr-hook` | The Bash hook command the plugin runs to track `gh pr create`. |

The review and feedback formats are in [`docs/FORMATS.md`](docs/FORMATS.md), with JSON Schema in
[`schemas/`](schemas/).

## Settings and storage

Your settings live in `~/.hoop/config.json`, and no repository can change them:

- `"signin": false` lets approving and requesting changes work without GitHub.
- `"github_client_id": "<client id>"` uses your own GitHub OAuth App for the sign-in. The sign-in
  asks GitHub only for your login and stores no token. See [`SECURITY.md`](SECURITY.md).

From the environment, `HOOP_HOME` moves `~/.hoop`, `HOOP_REPO_DIR` sets the project folder (the
current folder by default), and `HOOP_PORT` sets the port (4747).

hoop writes only under `~/.hoop`. One background process on `127.0.0.1:4747` serves the pages for
every session: a session or command starts it when nothing answers there, it restarts into new
code after an update, and it stops after an hour with no session and no page open.

To remove hoop: `claude plugin uninstall hoop@hoop` (or `claude mcp remove hoop` if you added only
the MCP server), `npm rm -g hoop` if you installed it globally, and `rm -rf ~/.hoop` to delete every
review and your settings.

## Develop

[`docs/DESIGN.md`](docs/DESIGN.md) describes how hoop works, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) how to build, test and send a change. Report a vulnerability
as [`SECURITY.md`](SECURITY.md) says.

## License

Apache License, Version 2.0. See [`LICENSE`](LICENSE).
