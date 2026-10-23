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

`hoop init` (or `npx -y @ankurjain-nitrr/hoop init`) runs these two for you, and
`hoop init --print` only prints them. If you installed the old `hoop-plan@hoop` plugin, run
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
  one marked recommended. Pick an option, or pick **Other** and answer in a comment. A comment or a
  request for changes needs every question answered. An answer stays with the next revision while
  Claude asks the same question there.
- **Submit** your review as a comment, a request for changes, or an approval. Only you approve:
  Claude has no tool to approve and is told never to. An approved review is frozen.
- **Looks good, go** approves in one click. Approving, this way or from **Finish your review**,
  takes the recommended option for each question you left unanswered; the page and Claude's
  feedback say which answers were taken that way.
- **Read receipts** show that your review reached Claude: "Claude read this at 21:04", or "Not read
  yet", beside the latest review and under each one in the history.
- **Each revision** shows what changed since the last one, and marks comments whose line changed
  as outdated. Every review keeps its history: each comment, request for changes and approval,
  with who and when.

Home, at `http://localhost:4747/`, lists every review in two sections, Pending and Completed
(approved or superseded), and groups each section by the Claude session that submitted the review:
its name, the start of its ID, the folder it worked in (and its git repository, when that is another
folder) and whether it is still running. Each review shows its title and its TL;DR in at most two
lines, newest first. **Rename** beside a session names it: hoop keeps the name, and adds it to the
session's transcript as `/rename` does, so Claude Code shows the same name.
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

## Build a document together

Ask Claude to "help me build a document" (or "let's kick-start a doc on X") and it builds it with
you instead of writing it all at once: first a review with questions on who it's for, what it
should help them decide and how long it should be, then an outline you adjust and approve, then a
build on the page where you ask Claude to write each section. The plugin's
`build-document` skill holds these steps.

A build (`hoop_build`) is a document you shape on the page itself: + between blocks adds a title,
section, subsection, paragraph, list, table, code block or diagram, and each block can be edited in
place, moved or removed. **Generate** on a section, with an optional note, asks Claude to write
it: the request waits until Claude's session picks it up, the section says when Claude is writing,
and Claude's text shows as generated until you edit it. **Undo** puts back what was there.
**Finish and review** turns the build into an ordinary review of the whole document, with comments
and an approval. Every change is kept as a step in the build's history, and the build
exports as markdown exactly as written.

## Work view

**Work**, beside Home, shows what each Claude Code session keeps track of while it runs, one
section per session: its name, the start of its ID, its folder, and whether it is working, idle or
ended. Under it are the session's todos in order with their state (queued, running, done; done ones
fold away) and its subagents, each with its description, type, state, how long it has run, its last
step and the path of its transcript. The page asks again every few seconds while it is visible. It
only shows the work; it can't change it.

The plugin records this with hooks on the todo tools, the Agent tool and subagent start and stop;
they run in the background, so they never slow or fail a tool call. Newer models keep no written
todo list unless the session starts with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in its environment;
without it the page shows only subagents. hoop doesn't change your settings.

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
| `hoop_submit` | Submits a markdown document, or a new revision of one with `review_id`. Returns the review's link. |
| `hoop_submit_decision` | Submits a structured `hoop/review@0` document with items, options and questions. See [`examples/order-export.json`](examples/order-export.json). |
| `hoop_wait` | Waits for the next review. Returns `pending` with `again: true` when none came yet, so the agent calls it again. |
| `hoop_feedback` | Returns the feedback on the latest revision: the verdict, comments with their scope, answers and replies. |
| `hoop_reply` | Replies in a comment thread. |
| `hoop_propose_edits` | Answers a comment with small `find` and `replace` edits that the reviewer accepts or rejects. |
| `hoop_comment` | Comments on a review that another Claude session submitted. |
| `hoop_build` | Starts building a document with the person on the page, from a working title and outline. |
| `hoop_build_wait` | Waits for the person to press Generate on a section, and returns each request with its note and the text around it. |
| `hoop_build_write` | Writes a section of a build; it shows as generated until the person edits it, and Undo puts back what was there. |
| `hoop_export` | Returns the document as markdown, with every accepted change in place, or a build's markdown as it stands. |
| `hoop_track_pr` | Tracks a pull request the session opened, so Home shows it. The plugin tracks `gh pr create` on its own. |

The loop: submit, wait, read the feedback, reply or revise with the same `review_id`, and go on
only after an approval. Markdown goes out byte for byte: an unedited document exports exactly as it
came in, and an edited one differs only inside the accepted edits. The first `#` heading is the
title, other headings start sections, and each paragraph, list item, table row, quote or code block
is one line to comment on. Tables show as tables, and Mermaid diagrams are drawn. hoop doesn't ship
Mermaid: a page with a diagram loads a pinned version from jsDelivr the first time it shows one, so
diagrams need the network then; offline, a diagram shows as its source.

Each review belongs to the session that submitted it. Only that session may revise it, reply in its
threads or propose edits. Any other session may read it and comment with `hoop_comment`, and a
terminal outside any session only reads. A session is the Claude Code session
(`CLAUDE_CODE_SESSION_ID`), else `HOOP_SESSION`, else, for `hoop mcp`, one made for that server
process. The page and the feedback name a session by its title and the start of its ID, such as
`Order export (ac57df4d)`. A Claude Code session's title is the one set with `/rename` or on Home,
else the one Claude Code generated; another agent's session is named on Home, else by its tool's name.

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
| `hoop build <file.md>` | Starts building a document with the person. |
| `hoop build-wait <review_id> [--seconds <n>]` | Waits for a Generate request on a build. |
| `hoop build-write <review_id> <section> <file.md>` | Writes a section of a build. |
| `hoop export <review_id> [--out <file>]` | Writes the document as markdown. |
| `hoop track-pr <url>` | Tracks a pull request for the session it runs in. |
| `hoop clear <review_id>` or `hoop clear --session <id>` | Deletes one review, or one session's reviews, after a confirmation (`--yes` without a terminal). |
| `hoop mcp` | Runs the MCP server, and starts the pages if nothing serves them. |
| `hoop serve` | Serves the pages in the foreground. |
| `hoop init [--print]` | Installs the plugin with `claude`, or prints the two commands. |
| `hoop plan-review` | The plan hook command the plugin runs. |
| `hoop pr-hook` | The Bash hook command the plugin runs to track `gh pr create`. |
| `hoop work-hook` | The hook command the plugin runs to record todos and subagents for the Work view. |

The review and feedback formats are published as JSON Schema in [`schemas/`](schemas/).

## Settings and storage

From the environment, `HOOP_HOME` moves `~/.hoop`, `HOOP_REPO_DIR` sets the folder a review records
(the current folder by default), `HOOP_PORT` sets the port (4747), and `HOOP_SESSION` names the
session for an agent other than Claude Code.

Each Claude Code session keeps its reviews in its own folder, beside its transcript:
`~/.claude/projects/<folder>/<session-id>/.hoop/` (or under `CLAUDE_CONFIG_DIR`). Claude Code
deletes a session's folder after `cleanupPeriodDays` (30 days by default), and that session's reviews
go with it; raise the setting in Claude Code to keep them longer. Reviews from another agent's session,
or from a terminal outside a session, stay in `~/.hoop/reviews`, and `~/.hoop/index.json` points the pages at every session's
reviews. The first run of this release moves each review in `~/.hoop/reviews` into its session's
folder when that folder still exists, and says how many moved and stayed. hoop writes nowhere else.

hoop never deletes a review by itself. `hoop clear <review_id>` deletes one review, and
`hoop clear --session <id>` every review of one session; each asks first on a terminal, and needs
`--yes` otherwise.

One background process on `127.0.0.1:4747` serves the pages for
every session: a session or command starts it when nothing answers there, it restarts into new
code after an update, and it stops after an hour with no session and no page open.

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
`npm run e2e:local` is the acceptance run. [`docs/DESIGN.md`](docs/DESIGN.md) describes how hoop
works, and [`docs/RELEASING.md`](docs/RELEASING.md) how a release is published to npm.

## License

Apache License, Version 2.0. See [`LICENSE`](LICENSE).
