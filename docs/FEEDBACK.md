# Outside reviews

Three outside reviews of hoop arrived on 2026-10-19. This file maps every item in them to the change
or idea that owns it, so one place shows how they fit together. Every current capability stays.
A change may move, rename or hide something, but it never takes a capability away.

## How the reviews fit together

- The first review found code faults. They are approval trust, lost writes, GitHub paging, error
  types and page rendering.
- The second review asked for features. They are a human gate, npm, a stale server warning and
  better revision views.
- The usability review read only the README. It found that devloop shapes the surface more than the
  generic review use case does.
- They agree in three places. The server needs to be clearer, approvals need a real human gate, and
  the docs need a reference a new user can follow.

## First review: faults

| Item | Topic | Owner |
|---|---|---|
| 1 | Anyone local can approve under any name. | CR-14 |
| 2 | Concurrent writes can be lost. | B-11 |
| 3 | GitHub items past 100 are dropped. | B-12 |
| 4 | A renamed heading loses its comments. | CR-12 |
| 5 | A taken port isn't reported. | CR-22 |
| 6 | Multi file writes aren't atomic. | B-11 |
| 7 | Errors are typed by their wording. | B-12 |
| 8 | The page renders everything again on each change. | B-21 |
| 9 | The server imports page code. | B-21 |
| 10 | Code comments name change requests, and the process is heavy. | CR-20, B-22 |

## Second review: features

| Item | Topic | Owner |
|---|---|---|
| 1 | A human gate, with a plan mode hook. | CR-14 |
| 2 | Publish hoop to npm. | B-16 |
| 3 | Warn about a stale server. | CR-22 |
| 4 | Show which comments the agent addressed. | B-15 |
| 5 | Delete text in one action. | CR-25 |
| 6 | Edit lines in place. | CR-25 |
| 7 | Approve with notes. | CR-14 |
| 8 | Compare any two revisions. | B-15 |
| 9 | Document setup for other agents. | CR-28 |
| 10 | Publish the schemas. | CR-28 |

## Usability review

| Item | Topic | Owner |
|---|---|---|
| 1 | The devloop tools crowd the generic surface. | CR-23 |
| 2 | Two submit tools, with names that don't match the CLI. | CR-24 |
| 3 | Comments need counted line numbers. | CR-25 |
| 4 | Edit rules show only when a call fails. | CR-25 |
| 5 | Waiting needs a shell. | CR-26 |
| 6 | The GitHub channel behaves differently. | CR-28 |
| 7 | A check that isn't allowed is silent. | CR-27 |
| 8 | Terms go undefined. | CR-28 |
| 9 | Side effects surprise the user. | CR-24 |
| 10 | Change request terms are missing, and the design order is built in. | CR-23, CR-28 |
| 11 | Server ports, restarts and removal. | CR-22 |
| 12 | The README is in the wrong order. | CR-28 |
| 13 | Breaking changes are expected. | CR-20, CR-28 |

Each owner's `NOTES.md` gives our view on its items.
