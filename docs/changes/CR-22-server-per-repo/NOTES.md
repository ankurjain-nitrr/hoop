# CR-22: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away. The reviewer read only the
README, so each section below starts from what the code does today.

## What it covers

It covers usability item 11. It replaces idea B-10, from the first review's item 5 and the second
review's item 3.

## What happens today

- When port 4747 is taken, the second session's MCP server still works, but its pages don't start.
  It writes one line to standard error, which the user rarely sees.
- Reviews live in one store for every repository, so the first server lists them all. Its tracker
  page and repository name come from the first repository, though.
- A server started before an update keeps serving old page code, and new pages stay on "Loading".

## What it likely includes

- The server reports its version and the repository it serves, and a page warns when it is stale.
- A second session either finds a free port or shares the first server, and says which one it did.
- The tracker page and the frame show the right repository for each session.
- This change owns the behavior. CR-28 writes the README section on setup, removal and running two
  sessions.

## Our view

We agree. A stale or wrong server cost the most time in recent work, so it runs first. Scoping
decides between one server per repository and one shared server. Any new command or tool needs the
requester's approval first.

## Capture check

The verdict is new, and it replaces idea B-10. It runs first in the queue.
