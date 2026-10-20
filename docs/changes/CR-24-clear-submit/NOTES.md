# CR-24: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away. The reviewer read only the
README, so each section below starts from what the code does today.

## What it covers

It covers usability item 2 and the behavior half of item 9.

## What happens today

- `hoop_submit` takes the JSON contract, and `hoop_submit_markdown` takes markdown. The CLI command
  `hoop submit` takes markdown, so its name matches the other tool.
- A submit with `review_id` revises that review. A submit against an approved review starts a new
  one, and the result names the old one in `supersedes`.
- After approval, `hoop_feedback` returns `decision_files` with the full paths it wrote.

## What it likely includes

- Each tool and its CLI command share a name. Both formats stay, and the guide says when to use
  each. JSON suits a decision with questions and choices, and markdown suits any other document.
- Each submit result states one outcome: created, revised or superseded. It names the review to use
  next.
- Reading feedback for a superseded review points to the newer one.
- The approval's files show where a user looks, on the page and in the CLI.

## Our view

We agree. The data is mostly there already, but it is easy to miss. A clear outcome and matching
names fix that without removing anything. A tool rename is a breaking change, and the status note
allows it. Any rename or new field needs the requester's approval first.

## Capture check

The verdict is new. CR-14 adds notes to approvals in the same feedback result, so CR-24 runs first.

## Merged into CR-31 (2026-10-20)

The requester merged every queued change into CR-31, to be built in one go as one pull request.
This change's request stays here, in the requester's words, and CR-31 meets it.
