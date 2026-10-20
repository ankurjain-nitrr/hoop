# CR-27: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away. The reviewer read only the
README, so each section below starts from what the code does today.

## What it covers

It covers usability item 7.

## What happens today

- When a repository declares a check that the user hasn't allowed, the submit still succeeds. Its
  `checks` field says the check didn't run, and gives the exact allow entry and the file to edit.
- The page shows a fixed message for that case. It leaves out the entry on purpose, because the
  entry names folders.
- Allowing a check means editing `~/.hoop/config.json` by hand.

## What it likely includes

- A skipped check reads as a warning wherever the user looks, not as part of a clean success.
- The page says how to allow the check without showing folder paths.
- Allowing a check takes one step, after hoop shows the command it will run.

## Our view

We agree that a skipped check is too easy to miss, although hoop does report it. We keep the two
files. The repository's file says what to run, and the user's own file says it may run. That split
stops a cloned repository from running code on submit. A new command needs the requester's approval
first.

## Capture check

The verdict is new. CR-10 built the checks and is folded. It isn't reopened.

## Merged into CR-31 (2026-10-20)

The requester merged every queued change into CR-31, to be built in one go as one pull request.
This change's request stays here, in the requester's words, and CR-31 meets it.
