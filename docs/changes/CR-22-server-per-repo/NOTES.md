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

## Pick-up check (2026-10-19)

Proceed. Nothing merged since capture touches the server, and no queued change covers it. The
change fits in about three pull requests and adds no command or tool.

## Look back (2026-10-20)

- Stale or wrong servers found by hand during the change: none, against a target of none.
- The change landed in seven pull requests, #92 for the design and #93 to #97 and #100 for the
  code. Each one stayed within 10 files and 500 lines.
- The size estimates held within half for T-1 to T-4. T-5 touched four files, not two, but had
  fewer than half the lines.
- Each fresh review found defects before merge. Two blocked a merge. In T-2, a slow holder could
  hang the probe. In T-3, an update in place started a second restart that failed.
- The acceptance script found a defect that the tests and reviews missed. A new session stayed out
  of the tracker picker for ten seconds. Running the acceptance script before the last code review
  would have caught it sooner.
- Node 18 tries "localhost" over IPv6 first, and the pages listen on 127.0.0.1. Tests and scripts
  now ask 127.0.0.1 directly.
- A test that waited on the wrong process held a full run for an hour. Long runs now set a test
  timeout.
- T-6 waited for the requester to approve its result field. They approved it on 2026-10-20, and
  asked that a failed start reach them too. Its review found that a program on IPv6 went unnoticed.
- The fold's staff review found that a foreground `hoop serve` never warned when out of date.
  Pull request #100 fixed it.
- A pages server from before this change can't restart itself, so the first update needs one
  restart of it.
