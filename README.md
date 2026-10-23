# hoop

Keep a person in the loop on what an agent writes. Claude puts a plan, a design, a decision or any
document into hoop; you review it on a local page the way you review code: comment on lines or
words, suggest changes, answer its questions, then approve or ask for changes. Claude reads your
review, revises, and goes on only after you approve.

Every Claude session on your machine uses the same hoop, at `http://localhost:4747`.

> **Status: before 1.0.** Tool names, commands and stored files may still change.

## Get started

You need Node 18.18 or later. One command adds hoop to Claude Code:

```sh
claude mcp add hoop -- npx -y github:ankurjain-nitrr/hoop mcp
```

The first start builds hoop, which takes about half a minute; later starts are quick. The `hoop`
command, which the plan hook below also uses, comes with `npm install -g github:ankurjain-nitrr/hoop`.
Once hoop is on npm as `@ankurjain-nitrr/hoop`, both use that name instead of the GitHub address.

Then ask Claude for something you want to review, for example:

> Draft a plan for moving our invoices to the new billing service, and send it to hoop for my
> review.

Claude replies with a link. Review the document there and submit your review. Claude picks it up,
answers your comments, revises, and repeats until you approve.

No skill or plugin is needed for this: when a session connects, hoop tells Claude when to ask for
a review, how to write the document and its questions, and to go on only after you approve.

## Reviewing a document

- **Comment** on a line, or select words and comment on just those. A comment on a heading covers
  its section; a comment on the title covers the whole document.
- **Suggest a change**: select words and replace or delete them, or edit a line in place. You can
  **Apply** a suggestion yourself; Claude can also propose edits that you **Accept** or **Reject**,
  shown as tracked changes.
- **Answer questions.** Claude asks one in a section headed `Question: …`, with lettered options and
  one marked recommended. Pick an option, or pick **Other** and answer in a comment. Every question
  needs an answer before you submit.
- **Submit** your review as a comment, a request for changes, or an approval. Only you approve:
  Claude has no tool to approve and is told never to. An approved review is frozen.
- **Each revision** shows what changed since the last one, and marks comments whose line changed
  as outdated. Every review keeps its history: each comment, request for changes and approval,
  with who and when.

Home, at `http://localhost:4747/`, lists every review in two sections, Pending and Completed
(approved or superseded), newest first. Each shows its title and its TL;DR in at most two lines.

## Review Claude's plans before it acts

The hoop-plan plugin opens each plan as a review before Claude Code leaves plan mode, and Claude
goes on only after you approve it. If hoop is missing or gives no decision, Claude stops rather
than going ahead. It needs `hoop` and `perl` on your PATH.

```sh
claude plugin marketplace add ankurjain-nitrr/hoop
claude plugin install hoop-plan@hoop
```

## Other agents

hoop works with any agent tool that runs MCP servers. Each tool starts `npx -y
github:ankurjain-nitrr/hoop mcp` from its own config file. The first start builds hoop for about
half a minute, so run `npx -y github:ankurjain-nitrr/hoop help` once beforehand if your tool gives up
on slow servers. The plan hook and the pull request hook are for Claude Code only.

**Codex CLI**, in `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.hoop]
command = "npx"
args = ["-y", "github:ankurjain-nitrr/hoop", "mcp"]
startup_timeout_sec = 60
```

**Cursor**, in `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "hoop": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:ankurjain-nitrr/hoop", "mcp"]
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
      "command": ["npx", "-y", "github:ankurjain-nitrr/hoop", "mcp"],
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
      "args": ["-y", "github:ankurjain-nitrr/hoop", "mcp"]
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
| `hoop_export` | Returns the document as markdown, with every accepted change in place. |

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
process. The page and the feedback name a Claude Code session by its title and the start of its ID,
such as `Order export (ac57df4d)`, and another agent's session by its tool's name.

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
| `hoop mcp` | Runs the MCP server, and starts the pages if nothing serves them. |
| `hoop serve` | Serves the pages in the foreground. |
| `hoop plan-review` | The hook command the hoop-plan plugin runs. |

The review and feedback formats are published as JSON Schema in [`schemas/`](schemas/).

## Settings and storage

From the environment, `HOOP_HOME` moves `~/.hoop`, `HOOP_REPO_DIR` sets the project folder (the
current folder by default), `HOOP_PORT` sets the port (4747), and `HOOP_SESSION` names the session
for an agent other than Claude Code.

hoop writes only under `~/.hoop`. One background process on `127.0.0.1:4747` serves the pages for
every session: a session or command starts it when nothing answers there, it restarts into new
code after an update, and it stops after an hour with no session and no page open.

To remove hoop: `claude mcp remove hoop`, `npm rm -g @ankurjain-nitrr/hoop`, and `rm -rf ~/.hoop` to delete every
review and your settings.

## Security

Report a vulnerability privately through GitHub's
[private vulnerability reporting](https://github.com/ankurjain-nitrr/hoop/security/advisories/new),
not in a public issue. Other web pages can't reach hoop's API: it refuses a foreign Host or Origin
and every write that isn't JSON. Diagrams run Mermaid in a sandboxed frame, loaded from one pinned
jsDelivr address only on a page with a diagram, and only if it matches the hash in `web/diagram.js`.

## Develop

`npm install` builds hoop and sets up the commit hooks; `npm run typecheck`, `npm run lint` and
`npm test` check a change. `npm test` skips the browser tests unless it runs on Node 20+ with
Chrome (`HOOP_CHROME` points at it; `HOOP_REQUIRE_BROWSER=1` fails instead of skipping), and
`npm run e2e:local` is the acceptance run. [`docs/DESIGN.md`](docs/DESIGN.md) describes how hoop works.

## License

Apache License, Version 2.0. See [`LICENSE`](LICENSE).
