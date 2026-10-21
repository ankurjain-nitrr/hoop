# CR-26: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away. The reviewer read only the
README, so each section below starts from what the code does today.

## What it covers

It covers usability item 5.

## What happens today

`hoop_feedback` returns at once, and its result says the review is pending. Waiting needs
`hoop wait` run in the background through a shell.

## What it likely includes

- An MCP client with no shell can wait for feedback. For example, a wait tool holds for a bounded
  time and returns either the new feedback or a note to call again.
- `hoop wait` in the background stays for clients with a shell.

## Our view

We agree. MCP is hoop's main interface, so waiting must work through it alone. This adds a tool,
so it needs the requester's approval before it is designed in detail.

## Capture check

The verdict is new. CR-14's plan mode hook waits for an approval, so it builds on this. CR-26 runs
before CR-14.

## Merged into CR-31 (2026-10-20)

The requester merged every queued change into CR-31, to be built in one go as one pull request.
This change's request stays here, in the requester's words, and CR-31 meets it.
