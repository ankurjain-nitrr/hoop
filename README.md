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

## Develop

Requires Node 18.18 or newer.

```sh
npm install
npm test
npm run typecheck
```
