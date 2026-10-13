# hoop

Humans in the loop: review an agent's decisions (requirements, PR slicing, plans) the way you
review code. Claude submits a decision as a JSON document over MCP, you comment on lines or
selected text, suggest changes and answer questions, and Claude reads your review back as
structured feedback. Work starts when you approve.

Requirements and design: [`docs/PRD.md`](docs/PRD.md).

## Contract

A review document (`hoop/review@0`) has a `slug`, `title`, `tldr` and `items`. Each item has an
`id` (`FR-1`, `Q-1`), a `type`, a `title`, and optional `body`, `check`, `choices`, `risk` and
`depends_on`. See [`examples/order-export.json`](examples/order-export.json).

An item's commentable lines are its body lines, then its choices (for questions), then its check.
Feedback (`hoop/feedback@0`) points at an item and line, optionally a character `range` within
the line.

## Use with Claude Code

```sh
claude mcp add hoop -- npx hoop mcp
```

| Tool | Does |
|---|---|
| `hoop_submit` | Stores a review document and returns its `review_id` and URL. Include `review_id` to submit a new revision. |
| `hoop_feedback` | Returns `pending`, or the feedback on the latest revision. |
| `hoop_reply` | Replies in a reviewer's comment thread. |

`hoop mcp` also serves the review pages on http://localhost:4747 (override with `HOOP_PORT`); the
URL `hoop_submit` returns opens the review. `hoop serve` serves the pages without MCP.

Reviews are stored as JSON files in `~/.hoop/reviews/<id>/` (override with `HOOP_HOME`).

## Develop

Requires Node 18.18 or newer.

```sh
npm install
npm test
npm run typecheck
```
