# CR-24: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away.

## What it covers

Usability items 2 and 9.

- One obvious way to submit. The tool and the CLI command share a name for each format. Both
  formats stay, and the guide says when to use each. JSON suits a decision with questions and
  choices, and markdown suits any other document.
- Each submit result says whether it created a review, revised one, or started a new review that
  supersedes an approved one. It always returns the review to use next.
- Reading feedback for a superseded review points to the newer one.
- Each approval result lists the files it wrote and where.

## Our view

We agree. Every behavior is sound, but none of them should surprise a user. Naming and results fix
that without removing anything. A tool rename is a breaking change, and the status note allows it.
Any rename or new field needs the requester's approval first.

## Capture check

The verdict is new. It touches CR-14, which adds notes to approvals. CR-24 only reports what an
approval wrote, so it runs first and CR-14 adds to the same result.
