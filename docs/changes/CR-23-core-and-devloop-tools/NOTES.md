# CR-23: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away.

## What it covers

Usability item 1, which the review calls the biggest problem, and the policy half of item 10.

- A client gets the core review tools by default. They are submit, feedback, propose edits, reply
  and export.
- The change request and tracker tools load only when the project turns them on, for example in
  `hoop.config.json`. devloop's setup turns them on for the projects it drives.
- The rule that a PRD is approved before the HLD, and the HLD before the LLD, belongs to the change
  request tools. A plain review never meets it.
- The CLI keeps every command, and its help groups the devloop commands apart.

## Our view

We agree. hoop is sold as a review tool for any document, so its default surface must be that tool.
devloop stays a first class user of hoop, but as an opt in layer. No tool is removed. Turning tools
on per project changes what clients see, so the design needs the requester's approval before it
lands.

## Capture check

The verdict is new. It touches CR-16 and CR-7, which add change request pages and projects. Both
build on the devloop layer this change creates, so they run after it.
