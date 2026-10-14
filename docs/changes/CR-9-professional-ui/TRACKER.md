# CR-9: tracker

This tracker lists CR-9's work items. Requirements stay in `PRD.md`, and the Covers column points to
them. The table is the index, and each item's description and definition of done are in its block
under "Items".

| ID | Parent | Type | Title | Covers | Status | Phase | Depends on | PR | Size | Start | Done |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CR-9 | | epic | Give hoop a consistent, professional interface on every page. | | in progress | build | | | | 2026-10-13 | |
| ST-1 | CR-9 | story | As a reviewer, I see one product with the same frame and statuses on every page. | FR-1, FR-2, FR-3 | in progress | | | | | | |
| T-1 | ST-1 | task | Give every review a status key from the server, and show it with shared badges and icons. | FR-2 | in review | | | | 16 files, ~330 lines | 2026-10-14 | |
| T-2 | ST-1 | task | Add the shared page frame, repository identity and the grouped review list. | FR-1, FR-3 | todo | | T-1 | | ~7 files, ~300 lines | | |
| ST-2 | CR-9 | story | As a reviewer, I read documents as formatted text and still comment on exact words. | FR-4 to FR-9 | todo | | | | | | |
| T-3 | ST-2 | task | Decide line kinds once, render lines as formatted text, and map selections back to the source. | FR-4, FR-5 | todo | | T-2 | | ~9 files, ~450 lines | | |
| T-4 | ST-2 | task | Finish the comment tools and the review page details. | FR-5a, FR-6, FR-7, FR-8, FR-9, NFR-1 | todo | | T-3 | | ~6 files, ~300 lines | | |
| ST-3 | CR-9 | story | As a reviewer, I can use every page from the keyboard, offline, in either theme. | NFR-1, NFR-2, NFR-3 | todo | | | | | | |
| T-5 | ST-3 | task | Add page checks for themes, phone width, keyboard use, blocked requests, accessibility and speed. | NFR-1, NFR-2, NFR-3 | todo | | T-4 | | ~3 files, ~250 lines | | |

Types are epic, story, task, sub-task and bug. Status is todo, in progress, in review, blocked,
done or dropped. The order is T-1 to T-5, following the LLD's pull request plan. Each task is one
pull request of at most 10 files and 500 lines.

## Items

### CR-9: Give hoop a consistent, professional interface on every page.

Every page shares one frame, one set of statuses and icons, and one type scale. Documents read as
formatted text, and reviewing works exactly as before.

Definition of done:
- Every story under it is done.
- Every success metric in the PRD meets its target.
- The existing browser tests and acceptance scripts pass, changed only where the LLD lists.
- Its PRD, HLD and LLD are folded into the project documents.

### ST-1: As a reviewer, I see one product with the same frame and statuses on every page.

A reviewer always sees the product name, where they are, and how to reach the reviews and the
tracker. A status looks the same wherever it appears.

Definition of done:
- The review list, a review and the tracker show the same frame.
- Each status has one label, color and icon on every page.
- The review list groups reviews by status, with counts and readable dates.
- T-1 and T-2 are merged.

### T-1: Give every review a status key from the server, and show it with shared badges and icons.

The review rules compute each review's status key. The pages show it through `web/status.js` and
`web/icons.js`, with `esc` moved to `web/esc.js`.

Definition of done:
- Two pull requests make the change that the LLD's first pull request describes. The first adds the
  server's status key and the shared modules, and the second moves the pages to them. One pull
  request would touch 15 files, which is over the limit of 10.
- `test/status.test.ts` covers every status, including an approved GitHub review that isn't merged.
- The status checks in `test/ui.test.ts` change only as the LLD lists.
- The fresh review's findings are resolved, each with a regression test.

### T-2: Add the shared page frame, repository identity and the grouped review list.

`web/frame.js` wraps every page. The server gives each review and the served folder a repository
identity, and the list groups reviews by status.

Definition of done:
- One pull request makes the change, as the LLD's second pull request describes.
- Tests cover `repoIdentity`, `/api/info`, the new list fields and the frame on every page.
- The list has no tracker link of its own.
- The fresh review's findings are resolved, each with a regression test.

### T-3: Decide line kinds once, render lines as formatted text, and map selections back to the source.

`web/blocks.js` decides line kinds for the server and the pages. `web/inline.js` renders lines, and
selections map back to source offsets in the same pull request.

Definition of done:
- One pull request makes the change, as the LLD's third pull request describes.
- The parity tests pass: `blockKinds` against the parser and `pieceMarker` against `BLOCK`.
- `itemLines` returns the same lines as before for every fixture and every file in `docs/`.
- Selections inside formatted text store the right source quote, in unit and browser tests.
- The fresh review's findings are resolved, each with a regression test.

### T-4: Finish the comment tools and the review page details.

Typed words work across formatting, quotes render with their line, and suggestions keep their line
structure. The review page gets the gutter, hidden IDs, labels, the TL;DR rule, badges and the
type scale.

Definition of done:
- One pull request makes the change, as the LLD's fourth pull request describes.
- Browser checks cover FR-5a and FR-6 to FR-9, and the suggestion message.
- The fresh review's findings are resolved, each with a regression test.

### T-5: Add page checks for themes, phone width, keyboard use, blocked requests, accessibility and speed.

`test/pages.test.ts` checks every page in both themes, at 400 pixels, from the keyboard and with
requests to other hosts blocked. It runs `axe-core` and times a 1000-line document.

Definition of done:
- One pull request adds the checks and `axe-core` as a development dependency.
- Any problem the checks find is fixed in the same pull request.
- One run with `HOOP_REQUIRE_BROWSER=1` is recorded in the pull request description.
- The fresh review's findings are resolved, each with a regression test.
