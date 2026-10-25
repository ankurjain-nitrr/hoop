# hoop

Keep a person in the loop on what an agent writes. Claude puts a plan, a design, a decision or any
document into hoop; you review it on a local page the way you review code: comment on lines or
words, suggest changes, answer its questions, then approve or ask for changes. Claude reads your
review, revises, and goes on only after you approve.

Every Claude session on your machine uses the same hoop, at `http://localhost:4747`.

> **Status: before 1.0.** Tool names, commands and stored files may still change.

## Get started

You need Node 22.12 or later and Claude Code. Install hoop's plugin, which holds the MCP server,
the plan hook, the pull request hook and the Work view's hooks:

```sh
claude plugin marketplace add ankurjain-nitrr/hoop
claude plugin install hoop@hoop
```

`hoop init` (or `npx -y @ankurjain-nitrr/hoop init`) runs these two for you, then asks
whether to turn on Claude Code's todo tools for the [Work view](#work-view); `hoop init --print`
only prints what to run. If you installed the old `hoop-plan@hoop` plugin, run
`claude plugin uninstall hoop-plan@hoop` first, and if you added hoop with `claude mcp add`, run
`claude mcp remove hoop`, so its tools aren't listed twice.

The plugin runs the `hoop` on your PATH, or, without one, the version of
[`@ankurjain-nitrr/hoop`](https://www.npmjs.com/package/@ankurjain-nitrr/hoop) it pins, through
`npx`. For other setups, add the MCP server alone:

```sh
claude mcp add hoop -- npx -y @ankurjain-nitrr/hoop mcp
```

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
  one marked recommended. Pick an option, or pick **Other** and answer in a comment. A request
  for changes needs every question answered. An answer stays with the next revision while
  Claude asks the same question there.
- **Submit** your review with one of two verdicts: **Request changes** or **Approve**. A request
  for changes needs a comment, an overall comment or an answer to a question; an approval needs
  nothing written. Approve, and **Looks good, go**, are off while you have new comments, replies
  or suggestions, and say so: request changes, or delete them to approve. You approve a text with
  nothing left open: they are also off while a conversation from any revision isn't resolved
  (you resolve it, beside it or under **On removed sections** when Claude removed its section) and
  while a question is still in the document. Answer a question with **Request changes**: Claude
  writes your decision in and removes the question, and you approve that revision. Only you approve: Claude has no tool to approve and is told never to. Reviews sent
  with the Comment verdict of earlier versions still show as they were.
- **After you approve**, the review still takes comments. Requesting changes reopens it: it shows
  **Changes requested after approval**, Claude is told, the approval stays in the history, and
  Claude's next revision needs approving again.
- **Looks good, go** approves in one click once nothing is open. A decision document from
  `hoop_submit_decision` works the same way: you answer its questions with **Request changes**,
  and Claude revises it into a document that states your decisions, which you approve.
- **Read receipts** show that your review reached Claude: "Sent to Claude at 21:03, not read yet"
  as soon as you submit, then "Claude read this at 21:04", beside the latest review and under each
  one in the history. The status changes at once too.
- **Claude's state** shows under the title: waiting for your review, idle (submitting wakes it), or
  ended, with the `claude --resume` command to copy; it gives way to the receipt while a review
  you sent waits to be read. Submitting sends the session one message
  naming the review, so Claude reads it even after it stopped waiting, and the notice says whether
  it got there. Home marks a review "Not read yet" while Claude hasn't read its latest review.
- **Each revision** shows what changed since the last one, and marks comments whose line changed
  as outdated. Every review keeps its history: each comment, request for changes and approval,
  with who and when.
- **New revisions arrive live.** While the page is open, a bar says "Revision 3 is ready"; **Show
  it** moves to it. Unsent comments, suggestions, answers and the overall comment are kept in the
  browser, through a reload or a closed tab, until you send them. A draft whose line changed waits
  in a "Drafts from revision 2" list at the top, quoting the old line, to place again or discard.

Home, at `http://localhost:4747/`, lists every review in two sections, Pending and Completed
(approved or superseded), and groups each section by the Claude session that submitted the review,
or by the person who opened it with `hoop open`. A session's group shows
its name, the start of its ID, the folder it worked in (and its git repository, when that is another
folder) and whether it is still running. Each review shows its title and its TL;DR in at most two
lines, newest first. **Rename** beside a session names it: hoop keeps the name, and adds it to the
session's transcript as `/rename` does, so Claude Code shows the same name.
Home also lists the pull requests Claude sessions opened: open ones under Pending, with the start
of their description, whether checks are running, failing or passed, conflicts with the base
branch, a review asked of you, or ready to merge, and the session that opened them; merged or
closed ones under Completed, and so are ones marked "Gone" because GitHub says the repository or
pull request no longer exists. hoop reads their state with `gh` only while Home is open, at most
once a minute each, and a closed or gone one every half hour or when you sign in to `gh` as someone
else; without `gh` or a sign-in, or while GitHub can't be reached, Home says "State unknown" and
asks again.

At the top of Home, **Waiting on you** lists what Claude needs you to do that isn't a review, such
as merging a pull request, approving a staged npm release or running a command. Each item says what
to do and why, links to the pull request, review or npm page, and names its session. An item closes
only when hoop sees it done: the pull request merged, the review approved or the version published,
checked while Home is open, at most once a minute each. Only you can tick **Done** on an item hoop
can't check. **Won't do** asks for a one-line reason. Either way, hoop tells the session. An open
item whose pull request was closed or is gone says so, and **Won't do** clears it. Closed items
fold into Completed. When no item is open and nothing is pending, Home says "Nothing waiting on
you." in one line above Completed.

Every hoop tab counts the reviews awaiting your review and the open action items in its title, as
"(2) Home · hoop", and puts a dot on its icon. **Notify me** on Home turns on a browser notification, "New review: <title>",
for a review that arrives while the tab is hidden; clicking it opens the review. hoop asks the
browser for permission only when you press it.

On Home and the Work view, a section's or session's heading folds it away, leaving the counts of
what it holds beside its name ("1 awaiting review · 1 changes requested", "2 queued · 1 running · 2
agents"); a session's todos and subagents fold on their own too. **Collapse all** folds every
session and **Expand all** opens everything. The browser remembers what is folded. Home's Completed
section starts folded, with its count beside its name, and the browser remembers when you open it.

## Review any markdown file

`hoop open <file.md>` opens a file for review without Claude: run it in any terminal, inside a
Claude session or not. The review is yours, labelled "Opened by <you>" on the page and on Home, and
kept in `~/.hoop/reviews`. hoop prints the link and opens it in your browser (`--no-browser` skips
that; `--title <t>` names it in place of its first heading). Comment, suggest and approve as on any
review. Edit the file and run `hoop open` again to add a revision; if the file hasn't changed, it
prints the link. After an approval, opening the changed file starts a new review that supersedes it.

Claude sessions can read such a review with `hoop_feedback` and `hoop_export`, comment with
`hoop_comment`, and reply in its threads with `hoop_reply`. No session revises it or proposes edits
to it: only you change it, from the file.

## Review Claude's plans before it acts

The plugin opens each plan as a review before Claude Code leaves plan mode, and Claude goes on only
after you approve it. If hoop is missing or gives no decision, Claude stops rather than going
ahead. It also tracks each pull request a session opens with `gh pr create`, for Home, and never
blocks or fails that command. The plan hook needs `perl` on your PATH.

## Quick questions

For a decision that blocks Claude's next step and fits in one line, Claude asks with `hoop_ask`
instead of writing a document: one to four questions, each with two to four options and one
recommended. The ask opens at its own link; each answer is one click (or **Other** and Enter), saved
and sent to Claude at once, with an optional note. **Go with your recommendation** answers the rest
with Claude's picks. Nothing ever answers for you on a timeout. Change an answer any time: once
Claude has read it, the change goes to Claude as a correction, and the question keeps both. Claude
can withdraw an ask it no longer needs, with a reason. Open asks show on Home under Pending. An
ask about a line in an open review also shows as a card beside that line on the review's page;
answering there doesn't start or finish a review, and the answered card stays on the line.

## Build a document together

Ask Claude to "help me build a document" (or "let's kick-start a doc on X") and it starts a build
from just the title, with no questions first, and you shape the rest on the page, asking Claude to
suggest headings or write under them as you go. The plugin's `build-document` skill holds these steps.

A build (`hoop_build`) is a document you shape on the page itself, in plain words: + between blocks
adds a title, a Heading 1 (`##`), a Heading 2 (`###`), a paragraph, list, table, code block or
diagram, and each block can be edited in place, moved or removed. Blocks always show formatted; a
block's editor has buttons for bold, italic, links, bulleted and numbered lists, tables and code,
which write markdown underneath, and typed markdown works too. A heading edits as its words alone.
The document reads as an outline: a heading holds everything up to the next heading at its level or
above, indented under it and folding with it. Moving a heading moves everything under it among its
siblings, and removing one asks whether everything under it goes too.
**Suggest an outline** on the title, with optional notes, **Suggest subheadings** on a heading and
**Suggest the next heading** on the last one ask Claude for headings; they wait as dashed placeholders
to accept, edit or dismiss, and only accepted ones join the document. **Generate** on a heading, with an optional note, asks Claude to write
everything under it: the request waits until Claude's session picks it up, the heading says when Claude is writing,
and Claude's text shows as generated until you edit it. **Undo** puts back what was there.
**Generate again** on a block Claude wrote asks Claude to write that block again, with an optional
note on what should change, or everything under its heading. Each block Claude rewrites waits for
you to **Accept** or **Undo** it.
**Finish and review** turns the build into an ordinary review of the whole document, with comments
and an approval. Every change is kept as a step in the build's history, and the build
exports as markdown exactly as written.

## Work view

**Work**, beside Home, shows what each Claude Code session keeps track of while it runs, one
section per session: its name, the start of its ID, its folder, and whether it is working, idle or
ended. Under it are the session's todos in order with their state (queued, running, done; done ones
fold away), each with its description under it in two lines, **More** showing the rest. Links in a
description work; a link to a hoop review shows the review's title and opens in the same tab. Then
come the session's subagents, each with its description, type, state, how long it has run, its last
step and the path of its transcript. The page asks again every few seconds while it is visible.

What runs comes first: working sessions above idle and ended ones, and in each session running
todos and subagents above queued ones (which keep your order), then done ones. The top of the page
counts "N running · M stalled · K waiting on you". Each running todo and subagent says how long it
has run and when the session or subagent last did anything. One quiet for 10 minutes, with no tool
call still running, shows as **Stalled**; a todo left in progress by an ended or idle session shows
as **Not running** (the count leaves out sessions that ended over an hour ago). Work whose session
waits in a hoop wait or ask, or on a Claude Code question, shows **Waiting on you** and counts only
once, under "waiting on you". A working session shows a **Now:** line (its current tool call, such as
"running tests: npm test" or "waiting on a review in hoop") and a folded **Last 5 minutes** list of
its steps, read from the end of its transcript.

You can steer that work from the page. On a queued todo: **Comment**, **Edit** (its subject and description), **Up**,
**Down** (disabled at the ends of the list) and **Remove**; on a running todo, **Comment**; on a running subagent, **Comment** and
**Stop**. Removing and stopping ask you to confirm on the page first. Each change reaches the agent
two ways:

- **A message, right away.** A few seconds after your last change, hoop sends the session one
  message over Claude Code's session messaging socket: "From <you> via hoop's Work view: …", with
  each change in plain words. They are instructions about the agent's own todo list, not approvals.
- **The gate.** A plugin hook that runs before each tool call refuses to start (or mark done) a
  todo you removed, refuses an edited todo once with your new text, and refuses every tool call of an
  agent you stopped, saying who stopped it. A move or comment the session never got by message is
  told the same way, once.
- **Your order.** Once you move a todo, the order the page shows is the session's order: hoop keeps
  it, the todos the agent adds later join its end, and the gate refuses, once, starting a queued todo
  while another comes first ("The person put #3 first in hoop's Work view; start #3, or ask them.").
  Claude reads the order with `hoop_work_queue`. Until you move one, the agent's own order stands.

Under each todo or agent, the page shows your change, who made it and when; several moves of one todo
in a row read as one ("moved #11 up, before #5"). **History**, folded under the todos, lists every
step and how far it got: sent, waiting for the gate (the session isn't running, or takes no
messages), seen by the agent (the hooks saw it act on the change, or the gate told it) or overridden
(it went ahead anyway). hoop never plans or starts work itself; the agent keeps orchestrating.

The plugin records this with hooks on the todo tools, the Agent tool and subagent start and stop;
they run in the background, so they never slow or fail a tool call. The gate is the one hook that
runs before tool calls; without a change from you it exits at once without starting hoop. Newer models keep no written
todo list unless the session starts with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in its environment;
without it the page shows only subagents. `hoop init` asks once whether to turn the todo tools on;
on yes it sets that variable under `"env"` in Claude Code's `~/.claude/settings.json`, keeping every
other setting and a copy of the old file at `settings.json.hoop-backup`. `hoop init --yes` or
`--no` answers without asking; without a terminal and without either, it only says how. Codex's
plan isn't shown yet.

## Other agents

hoop works with any agent tool that runs MCP servers. Each tool starts `npx -y
@ankurjain-nitrr/hoop mcp` from its own config file. The plan hook, the pull request hook and the Work view are for Claude Code only.

**Codex CLI**, in `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.hoop]
command = "npx"
args = ["-y", "@ankurjain-nitrr/hoop", "mcp"]
startup_timeout_sec = 60
```

**Cursor**, in `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "hoop": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ankurjain-nitrr/hoop", "mcp"]
    }
  }
}
```

**OpenCode**, in `opencode.json` in the project, or `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "hoop": {
      "type": "local",
      "command": ["npx", "-y", "@ankurjain-nitrr/hoop", "mcp"],
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

**Gemini CLI**, in `~/.gemini/settings.json`, or `.gemini/settings.json` in the project:

```json
{
  "mcpServers": {
    "hoop": {
      "command": "npx",
      "args": ["-y", "@ankurjain-nitrr/hoop", "mcp"]
    }
  }
}
```

Each conversation starts its own hoop server, and each server is one session, named after the
tool that started it, such as `codex-mcp-client (3f9a61c2)`. To keep one session across
conversations, set `HOOP_SESSION` to an ID of your own (letters, digits, `-` and `_`) in the
server's environment.

## For agents

hoop is an MCP server. These are its tools:

| Tool | Does |
|---|---|
| `hoop_submit` | Submits a markdown document, or a new revision of one with `review_id` and `base_revision`. Returns the review's link. |
| `hoop_submit_decision` | Submits a structured `hoop/review@0` document with items, options and questions. See [`examples/order-export.json`](examples/order-export.json). |
| `hoop_wait` | Waits for the next review, up to ten minutes in Claude Code. Returns `pending` with `again: true` and a line saying what it waits for when none came yet, so the agent calls it again. |
| `hoop_feedback` | Returns the feedback on the latest revision: the verdict, comments with their scope, answers and replies, and every thread not yet resolved, from any revision, as unanswered or answered. |
| `hoop_ask` | Asks the person one to four quick questions, each with options and one recommended, answered with one click on the page. Returns at once; `hoop_wait` on its ID returns the answers (`partial: true` for each as it comes). |
| `hoop_withdraw` | Withdraws a quick question the session no longer needs, with a one-line reason. |
| `hoop_reply` | Replies in a comment thread, on the session's own review or on one a person opened with `hoop open`. |
| `hoop_propose_edits` | Answers a comment with small `find` and `replace` edits that the reviewer accepts or rejects. |
| `hoop_comment` | Comments on a review that another Claude session submitted. |
| `hoop_build` | Starts building a document with the person on the page, from a working title. |
| `hoop_build_wait` | Waits for the person to ask for a section's text, suggested headings, or a block written again, and returns each request with its note and the text around it. |
| `hoop_build_write` | Writes a section of a build, or one block of it; it shows as generated until the person edits it, and Undo puts back what was there. |
| `hoop_build_suggest` | Suggests headings for a build when the person asks for an outline, the next section or subsections; they change nothing until accepted. |
| `hoop_export` | Returns the document as markdown, with every accepted change in place, or a build's markdown as it stands. |
| `hoop_track_pr` | Tracks a pull request the session opened, so Home shows it. The plugin tracks `gh pr create` on its own. |
| `hoop_action` | Adds an action item under Waiting on you on Home, with a check (`pr_merged`, `review_approved`, `npm_version` or `manual`) that closes it. |
| `hoop_action_withdraw` | Withdraws an action item the session no longer needs, with a reason. |
| `hoop_work_queue` | Lists the session's queued todos in the order the Work view shows, with descriptions, and whether the person set that order. |

The loop: submit, wait, read the feedback, reply or revise with the same `review_id`, and go on
only after an approval. A revision passes `base_revision`, the revision its text builds on (`hoop
submit --base <n>`). hoop refuses a revision whose `base_revision` isn't the latest (a reviewer's
**Apply** makes a revision too), and one submitted while a review on any revision hasn't reached the
agent; the refusal names the latest revision and carries those reviews in `detail.unread`, so the
agent reads them and submits again. Markdown goes out byte for byte: an unedited document exports exactly as it
came in, and an edited one differs only inside the accepted edits. The first `#` heading is the
title, other headings start sections, and each paragraph, list item, table row, quote or code block
is one line to comment on. Tables show as tables, and Mermaid diagrams are drawn. hoop doesn't ship
Mermaid: a page with a diagram loads a pinned version from jsDelivr the first time it shows one, so
diagrams need the network then; offline, a diagram shows as its source.

Each review belongs to the session that submitted it. Only that session may revise it, reply in its
threads or propose edits. Any other session may read it and comment with `hoop_comment`, and a
terminal outside any session only reads. A review a person opened with `hoop open` belongs to that
person, not to a session: any session may read it, comment on it and reply in its threads, and no
session may revise it or propose edits; the person revises it by running `hoop open` on the file
again. The feedback names that person in `opened_by`. A session is the Claude Code session
(`CLAUDE_CODE_SESSION_ID`), else `HOOP_SESSION`, else, for `hoop mcp`, one made for that server
process. The page and the feedback name a session by its title and the start of its ID, such as
`Order export (ac57df4d)`. A Claude Code session's title is the one set with `/rename` or on Home,
else the one Claude Code generated; another agent's session is named on Home, else by its tool's name.

Every tool also has a command, for agents without MCP. `hoop help` lists them:

| Command | Does |
|---|---|
| `hoop submit <file.md> [--review <id> --base <n>]` | Submits a document, or a revision built on revision `<n>`. |
| `hoop submit-decision <file.json> [--base <n>]` | Submits a structured document, or a revision built on revision `<n>`. |
| `hoop wait <review_id> [--after <cursor>] [--timeout <seconds>]` | Waits for a review and prints it as JSON. Exits 0 on a review, 3 on a timeout. Pass `--after` the cursor a submit printed, so a review that came in before the wait started still counts. |
| `hoop feedback <review_id>` | Prints the feedback. |
| `hoop ask <question> --option <text> --option <text>*` | Asks a quick question; `*` ends the recommended option, `--context` adds why it matters, and `--review <id>` with `--words` (or `--item` and `--line`) points it at a review line. `hoop wait <id> [--partial]` waits for the answers. |
| `hoop withdraw <review_id> <reason>` | Withdraws a quick question. |
| `hoop reply <thread> <text>` | Replies in a thread. |
| `hoop comment <review_id> <item> <line> <text>` | Comments on another session's review. |
| `hoop propose <review_id> <thread> <edits.json>` | Proposes edits for a comment. |
| `hoop build <file.md>` | Starts building a document with the person. |
| `hoop build-wait <review_id> [--seconds <n>]` | Waits for a Generate or Suggest request on a build. |
| `hoop build-write <review_id> <section> <file.md>` | Writes a section of a build. |
| `hoop build-suggest <review_id> <request> <file.md>` | Suggests headings for a build request: each heading line, with an optional note line under it. |
| `hoop export <review_id> [--out <file>]` | Writes the document as markdown. |
| `hoop track-pr <url>` | Tracks a pull request for the session it runs in. |
| `hoop action add <title> --description <text> --done-when <check>` | Adds an action item; the check is `manual`, `pr_merged:<url>`, `review_approved:<id>` or `npm_version:<package>@<version>`. |
| `hoop action withdraw <id> <reason>` | Withdraws an action item. |
| `hoop work-queue` | Prints the session's queued todos in the Work view's order. |
| `hoop clear <review_id>` or `hoop clear --session <id>` | Deletes one review, or one session's reviews, after a confirmation (`--yes` without a terminal). |
| `hoop open <file.md> [--title <t>] [--no-browser]` | Opens a markdown file for review as yours, without a session, and opens its link in the browser. Run again after editing the file for a new revision. |
| `hoop mcp` | Runs the MCP server, and starts the pages if nothing serves them. |
| `hoop serve` | Serves the pages in the foreground. |
| `hoop init [--print] [--yes \| --no]` | Installs the plugin with `claude`, or prints the two commands, then asks to turn on the todo tools. |
| `hoop plan-review` | The plan hook command the plugin runs. |
| `hoop pr-hook` | The Bash hook command the plugin runs to track `gh pr create`. |
| `hoop work-hook` | The hook command the plugin runs to record todos and subagents for the Work view. |
| `hoop work-gate` | The Work view's gate: the hook command that refuses a todo or agent you changed. |

The review, feedback and quick question formats are published as JSON Schema in [`schemas/`](schemas/).

## Settings and storage

From the environment, `HOOP_HOME` moves `~/.hoop`, `HOOP_REPO_DIR` sets the folder a review records
(the current folder by default), `HOOP_PORT` sets the port (4747), `HOOP_SESSION` names the
session for an agent other than Claude Code, and `HOOP_NO_BROWSER` stops `hoop open` opening a browser.

Each Claude Code session keeps its reviews in its own folder, beside its transcript:
`~/.claude/projects/<folder>/<session-id>/.hoop/` (or under `CLAUDE_CONFIG_DIR`). Claude Code
deletes a session's folder after `cleanupPeriodDays` (30 days by default), and that session's reviews
go with it; raise the setting in Claude Code to keep them longer. Reviews from another agent's session,
or from a terminal outside a session, stay in `~/.hoop/reviews`, and `~/.hoop/index.json` points the pages at every session's
reviews. The pages process of this release, when it first starts, moves each review in
`~/.hoop/reviews` into its session's folder when that folder still exists, and records how many moved
and stayed in `~/.hoop/pages.jsonl`. hoop writes nowhere else.

hoop never deletes a review by itself. `hoop clear <review_id>` deletes one review, and
`hoop clear --session <id>` every review of one session; each asks first on a terminal, and needs
`--yes` otherwise.

One background process on `127.0.0.1:4747` serves the pages for
every session: a session or command starts it when nothing answers there, it restarts into new
code after an update, and it stops after an hour with no session and no page open. It is also the
only process that writes hoop's files: sessions and commands send it their writes, and fail with
the reason when it can't run. The pull request and Work hooks drop their update instead, so they
never slow or fail a tool call.

To remove hoop: `claude plugin uninstall hoop@hoop` (or `claude mcp remove hoop` if you added only
the MCP server), `npm rm -g @ankurjain-nitrr/hoop` if you installed it globally, `rm -rf ~/.hoop`
to delete your settings and the reviews kept there, and `rm -rf ~/.claude/projects/*/*/.hoop` for
the reviews in session folders.

## Security

Report a vulnerability privately through GitHub's
[private vulnerability reporting](https://github.com/ankurjain-nitrr/hoop/security/advisories/new),
not in a public issue. Other web pages can't reach hoop's API: it refuses a foreign Host or Origin
and every write that isn't JSON. Diagrams run Mermaid in a sandboxed frame, loaded from one pinned
jsDelivr address only on a page with a diagram, and only if it matches the hash in `web/diagram.js`.

## Develop

`npm install` builds hoop and sets up the commit hooks; `npm run typecheck`, `npm run lint` and
`npm test` check a change. `npm test` skips the browser tests unless it finds Chrome
(`HOOP_CHROME` points at it; `HOOP_REQUIRE_BROWSER=1` fails instead of skipping), and
`npm run e2e:local` is the acceptance run. The push hook runs the type check, lint and only the
tests that name what the branch changed, without the browser; CI runs everything and blocks the
merge. `HOOP_FULL_PUSH=1 git push` runs the whole suite before a push. [`docs/DESIGN.md`](docs/DESIGN.md) describes how hoop
works, and [`docs/RELEASING.md`](docs/RELEASING.md) how a release is published to npm.

## License

Apache License, Version 2.0. See [`LICENSE`](LICENSE).
