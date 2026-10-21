# CR-23: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away. The reviewer read only the
README, so each section below starts from what the code does today.

## What it covers

It covers usability item 1, which the review calls the biggest problem, and the policy half of item
10.

## What happens today

- Today hoop offers 13 tools, and 7 of them are change request and tracker tools that only devloop uses.
- A plain review never meets the rule that a PRD is approved before its HLD. That rule runs only
  when a submit names a change. But the `change` argument sits on both core submit tools, and on
  the `--cr` and `--doc` flags.

## What it likely includes

- A client gets the core review tools by default. They are both submit tools, feedback, propose
  edits, reply and export.
- The change request and tracker tools, and the `change` argument, load only when the project turns
  them on. devloop's setup turns them on for the projects it drives.
- The CLI keeps every command, and its help groups the devloop commands apart.

## Our view

We agree. hoop is sold as a review tool for any document, so its default surface must be that tool.
devloop stays a first class user of hoop, but as an opt in layer. No tool or argument is removed.
This changes what clients see, so the design needs the requester's approval before it lands.

## Capture check

The verdict is new. CR-16 and CR-7 add change request pages and projects. Both build on the devloop
layer this change creates, so they run after it.

## Merged into CR-31 (2026-10-20)

The requester merged every queued change into CR-31, to be built in one go as one pull request.
This change's request stays here, in the requester's words, and CR-31 meets it.
