# CR-26: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away.

## What it covers

Usability item 5.

- An MCP client with no shell can wait for feedback. For example, a wait tool holds for a bounded
  time and returns either the new feedback or a note to call again.
- `hoop wait` in the background stays for clients with a shell.

## Our view

We agree. MCP is hoop's main interface, so waiting must work through it alone. This adds a tool,
so it needs the requester's approval before it is designed in detail.

## Capture check

The verdict is new. CR-14's plan mode hook waits for an approval, so it builds on this. CR-26 runs
before CR-14's hook story.
