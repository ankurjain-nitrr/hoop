# CR-28: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away. The reviewer read only the
README, so each section below starts from what the code does today.

## What it covers

It covers usability items 8, 12 and 13, and the README half of items 6, 9, 10 and 11. It also
absorbs idea B-20 from the second review's items 9 and 10.

## What it likely includes

- The README starts with what hoop is, then install and removal. Next comes a short walkthrough
  from the reviewer's side. The reference comes last.
- A glossary defines materialize, TL;DR, check, risk, depends on, item types and supersedes.
- The change publishes the review and feedback schemas as JSON Schema files made from its own code.
  The README's field tables come from the same source, so they can't drift.
- A table shows what differs on the GitHub channel. It says that `channel` is a markdown submit
  argument and a field of the JSON document.
- The README names every side effect, such as the decision files an approval writes.
- The devloop section lists the steps, the change types and the tracker columns.
- The README says what two sessions or two repositories do, after CR-22 settles it.
- The tool table and the CLI examples line up one to one.
- A stability section says which surfaces may still break, and how a breaking change is announced.

## Our view

We agree. On item 13, breaking changes are honest while hoop is in development. The fix is a clear
policy, not a freeze. CR-20 adds the changelog, and this section points to it. It also covers setup
for agents other than Claude Code. The schema files need a small generator, so this is a story.

## Capture check

The verdict is new, and it absorbs B-20. It overlaps CR-20, which adds contributor files. CR-20
owns the files for contributors, and CR-28 owns the README for users. It runs after CR-22, CR-23,
CR-24 and CR-25, so the README describes their final surface once.

## Merged into CR-31 (2026-10-20)

The requester merged every queued change into CR-31, to be built in one go as one pull request.
This change's request stays here, in the requester's words, and CR-31 meets it.
