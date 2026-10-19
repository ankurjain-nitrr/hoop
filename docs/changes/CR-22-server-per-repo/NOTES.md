# CR-22: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away.

## What it covers

Usability item 11, which is also idea B-10, from the first review's item 5 and the second review's
item 3.

- The server reports its version and the repository it serves. A page warns when the server is
  older than the code on disk, instead of staying on "Loading".
- When port 4747 is taken by another repository's server, hoop says so and picks another port or
  serves both repositories. Today the second server quietly doesn't start, and pages show the
  first repository's reviews.
- The README says what two sessions or two repositories do, and gives an uninstall step.

## Our view

We agree. A stale or wrong server cost the most time in recent work, so it runs first. Scoping
decides between one server per repository and one shared server. Any new command or tool needs the
requester's approval first.

## Capture check

The verdict is new, and it replaces idea B-10. It runs first in the queue.
