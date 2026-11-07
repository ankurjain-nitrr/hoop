# Other MCP agents

hoop is an MCP server, so any agent tool that runs MCP servers can send you documents to review,
ask you quick questions and read your answers. The plan hook, the pull request hook and Work are for
Claude Code only.

## Add hoop

Each agent tool starts `npx -y @ankurjain-nitrr/hoop mcp` as an MCP server over stdio, from its own
config file. Give it a minute to start the first time, while `npx` fetches hoop.

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

## Sessions

Each conversation starts its own hoop server, and each server is one session, named after the tool
that started it, such as `my-agent-client (3f9a61c2)`, until you name it on [Home](home.md). To
keep one session across conversations, set `HOOP_SESSION` to an ID of your own (letters, digits, `-`
and `_`) in the server's environment. Reviews from these sessions are kept in `~/.hoop/reviews`.

A wait (`hoop_wait`) holds for a shorter time than in Claude Code and returns `again: true`, so the
agent calls it again. hoop sends messages only into Claude Code sessions, so if another agent
stopped waiting, ask it to read your review.

## Tools and commands

The MCP tools:

| Tool | Does |
|---|---|
| `hoop_submit` | Submits a markdown document, or a new revision of one with `review_id` and `base_revision`. Returns the review's link. |
| `hoop_revise_sections` | Revises a markdown review by edits to sections, named by ID (`hoop_export` lists them): replace, insert or delete a section, or replace text that occurs once in it. All the edits apply or none do, and every other section stays byte for byte the same. |
| `hoop_submit_decision` | Submits a structured `hoop/review@0` document with items, options and questions. See [`examples/order-export.json`](../../examples/order-export.json). |
| `hoop_wait` | Waits for the next review, up to ten minutes in Claude Code. Returns `pending` with `again: true` and a line saying what it waits for when none came yet, so the agent calls it again. |
| `hoop_feedback` | Returns the feedback on the latest revision: the verdict, comments with their scope, answers and replies, and every thread not yet resolved, from any revision, as unanswered, answered or applied. |
| `hoop_ask` | Asks the person one to four quick questions, each with options and one recommended, answered with one click on the page. Returns at once; `hoop_wait` on its ID returns the answers (`partial: true` for each as it comes). |
| `hoop_withdraw` | Withdraws a quick question the session no longer needs, with a one-line reason. |
| `hoop_reply` | Replies in a comment thread, on the session's own review or build, or on one a person opened with `hoop open`. |
| `hoop_propose_edits` | Answers a comment with small `find` and `replace` edits that the reviewer accepts or rejects. |
| `hoop_comment` | Comments on a review that another Claude session submitted. |
| `hoop_build` | Starts building a document with the person on the page, from a working title. |
| `hoop_build_wait` | Waits for the person to ask for a section's text, suggested headings, a block written again or a change from their comment, and returns each request with its note, the text around it, and the build's context documents and brief. |
| `hoop_build_write` | Writes a section of a build, or more after its text, as a draft the person saves or discards, or one block of it, naming the context documents it drew from and any block of its own the text contradicts. |
| `hoop_build_unreadable` | Marks one of a build's context documents as one Claude couldn't open, with the reason the person sees beside it. |
| `hoop_build_suggest` | Suggests headings for a build when the person asks for an outline, the next section or subsections; they change nothing until accepted. |
| `hoop_export` | Returns the document as markdown, with every accepted change in place, or a build's markdown as it stands. |
| `hoop_track_pr` | Tracks a pull request the session opened, so Home shows it. The plugin tracks `gh pr create` on its own. |
| `hoop_action` | Adds an action item under Waiting on you on Home, with a check (`pr_merged`, `review_approved`, `npm_version` or `manual`) that closes it. |
| `hoop_action_withdraw` | Withdraws an action item the session no longer needs, with a reason. |
| `hoop_work_queue` | Lists the session's queued todos in the order the Work view shows, with descriptions, and whether the person set that order. |

The loop: submit, wait, read the feedback, reply or revise with the same `review_id`, and go on only
after an approval. A revision passes `base_revision`, the revision its text builds on
(`hoop submit --base <n>`). hoop refuses a revision whose `base_revision` isn't the latest (a reviewer's **Apply**
makes a revision too), and one submitted while a review on any revision hasn't reached the agent;
the refusal names the latest revision and carries those reviews in `detail.unread`, so the agent
reads them and submits again. Markdown goes out byte for byte: an unedited document exports exactly
as it came in, and an edited one differs only inside the accepted edits. The first `#` heading is
the title, and a line in italics (`*words*` or `_words_`) right under it is an optional subtitle,
shown smaller under the title and open to comments. Other headings start sections, and each
paragraph, list item, table row, quote or code block is one line to comment on. Tables show as
tables, and a code block fenced as `mermaid` is drawn as a diagram. hoop doesn't ship the diagram
library: a page with a diagram loads a pinned version the first time it shows one, so diagrams need
the network then; offline, a diagram shows as its source.

Each review belongs to the session that submitted it. Only that session may revise it, reply in its
threads or propose edits. Any other session may read it and comment with `hoop_comment`, and a
terminal outside any session only reads. A review a person opened with `hoop open` belongs to that
person, not to a session: any session may read it, comment on it and reply in its threads, and no
session may revise it or propose edits; the person revises it by running `hoop open` on the file
again. The feedback names that person in `opened_by`. A session is the Claude Code session
(`CLAUDE_CODE_SESSION_ID`), else `HOOP_SESSION`, else, for `hoop mcp`, one made for that server
process. The page and the feedback name a session by its title and the start of its ID, such as
`Order export (ac57df4d)`. A Claude Code session's title is the one set with `/rename` or on Home,
else the one Claude Code generated; another agent's session is named on Home, else by its tool's
name.

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
| `hoop build-write <review_id> <section> <file.md> [--request <id>] [--used <document>]... [--contradicts <block> --note <text>]` | Writes a section of a build as a draft, from the context documents named, with a note on a block of Claude's it contradicts. |
| `hoop build-unreadable <review_id> <document> <reason>` | Marks a build's context document as one that can't be opened. |
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
| `hoop init [--print] [--yes \| --no] [--no-browser]` | Installs the plugin with `claude`, or prints the two commands, then asks to turn on the todo tools, and opens a sample review. |
| `hoop plan-review` | The plan hook command the plugin runs. |
| `hoop pr-hook` | The Bash hook command the plugin runs to track `gh pr create`. |
| `hoop work-hook` | The hook command the plugin runs to record todos and subagents for the Work view. |
| `hoop work-gate` | The Work view's gate: the hook command that refuses a todo or subagent you changed. |
| `hoop session-start` | The hook command that tells a starting, resumed, cleared or compacted session its queue, unread feedback and the reviews waiting on it. |
| `hoop pre-compact` | The hook command that saves what is open for a session before a compaction. |

The review, feedback and quick question formats are published as JSON Schema in
[`schemas/`](../../schemas/).
