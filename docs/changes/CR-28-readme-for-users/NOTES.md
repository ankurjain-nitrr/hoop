# CR-28: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away.

## What it covers

Usability items 8, 12 and 13, and the README half of items 6, 9 and 10. It also absorbs idea B-20
from the second review's items 9 and 10.

- The README starts with what hoop is, then install and removal. Next comes a short walkthrough
  from the reviewer's side. The reference comes last.
- A glossary defines materialize, TL;DR, check, risk, depends on, item types and supersedes.
- A field table for each schema is made from the schema itself, so it can't drift.
- A table shows what differs on the GitHub channel, and says that `channel` is a submit argument.
- The devloop section lists the steps, the change types and the tracker columns.
- The tool table and the CLI examples line up one to one.
- A stability section says which surfaces may still break, and how a breaking change is announced.

## Our view

We agree. On item 13, breaking changes are honest while hoop is in development. The fix is a clear
policy, not a freeze. CR-20 adds the changelog, and this section points to it. It also covers setup
for agents other than Claude Code.

## Capture check

The verdict is new, and it absorbs B-20. It overlaps CR-20, which adds contributor files. CR-20
owns the files for contributors, and CR-28 owns the README for users. It runs after CR-23, CR-24
and CR-25, so the README describes their final surface once.
