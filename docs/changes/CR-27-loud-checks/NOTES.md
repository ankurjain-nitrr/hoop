# CR-27: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away.

## What it covers

Usability item 7.

- When a repository declares a check that the user hasn't allowed, the submit result and the page
  say so plainly. They show the exact allow entry to add.
- Allowing a check takes one step, after hoop shows the command it will run.

## Our view

We agree with the problem, and we keep the two files. The repository's file says what to run, and
the user's own file says it may run. That split stops a cloned repository from running code on
submit. The fix is that a skipped check is never silent. A new command needs the requester's
approval first.

## Capture check

The verdict is new. CR-10 built the checks and is folded. It isn't reopened.
