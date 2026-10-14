# CR-9: tracker

This tracker lists CR-9's work items. Requirements stay in `PRD.md`, and the Covers column points to
them. The table is the index, and each item's description and definition of done are in its block
under "Items".

| ID | Parent | Type | Title | Covers | Status | Phase | Depends on | PR | Size | Start | Done | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CR-9 | | epic | Give hoop a consistent, professional interface on every page. | | in progress | build | | | | 2026-10-13 | | The plan has 8 pull requests, not 5. T-1 was split, and the page checks and line kinds became their own tasks. |
| ST-1 | CR-9 | story | As a reviewer, I see one product with the same frame and statuses on every page. | FR-1, FR-2, FR-3 | done | | | | | 2026-10-14 | 2026-10-14 | |
| T-1 | ST-1 | task | Give every review a status key from the server, and show it with shared badges and icons. | FR-2 | done | | | #61, #62 | 17 files, ~420 lines | 2026-10-14 | 2026-10-14 | It was estimated at 8 files, so it was split in two. The fresh reviews found 4 defects. |
| T-2 | ST-1 | task | Add the shared page frame, repository identity and the grouped review list. | FR-1, FR-3 | done | | T-1 | #63 | 10 files, ~250 lines | 2026-10-14 | 2026-10-14 | The fresh review found 3 defects. |
| ST-3 | CR-9 | story | As a reviewer, I can use every page from the keyboard, offline, in either theme. | NFR-1, NFR-2, NFR-3 | done | | | | | | 2026-10-14 | |
| T-3 | ST-3 | task | Check every page in both themes, at phone width, from the keyboard, offline and for accessibility. | NFR-1, NFR-2, NFR-3 | done | | T-2 | #65 | 8 files, ~330 lines | 2026-10-14 | 2026-10-14 | The fresh review found 4 gaps: a hidden dark contrast failure, unchecked page states, a count-only Tab check and no type scale check. |
| ST-2 | CR-9 | story | As a reviewer, I read documents as formatted text and still comment on exact words. | FR-4 to FR-9 | in progress | | | | | 2026-10-14 | | |
| T-4 | ST-2 | task | Decide each line's kind once on the server, and send the kinds to the pages. | FR-4 | done | | T-3 | #66 | 10 files, ~215 lines | 2026-10-14 | 2026-10-14 | It touched 10 files, not 8, because the edit engine is in src/edit.ts and the table rule moved from src/util.ts. The fresh review found a parser mismatch in 6 inputs and two test gaps. |
| T-5 | ST-2 | task | Show review lines as formatted text, and map each selection back to the source text. | FR-4, FR-5 | done | | T-4 | #68 | 10 files, ~640 lines | 2026-10-14 | 2026-10-14 | It was estimated at 400 lines and merged near 640, mostly tests. The fresh review found 4 rendering problems and 3 test gaps, but no trust or source map defect. |
| T-6 | ST-2 | task | Find typed words across formatting, and keep each suggestion to its line's structure. | FR-5a | done | | T-5 | #69 | 9 files, ~290 lines | 2026-10-14 | 2026-10-14 | The fresh review found 3 defects: typed words matched hidden link targets, the page skipped the title and TL;DR checks, and structured quotes were formatted. |
| T-7 | ST-2 | task | Put the comment button in the gutter, hide document IDs, show the TL;DR once and hide empty badges. | FR-6, FR-7, FR-8, FR-9 | todo | | T-6 | | ~7 files, ~250 lines | | | |

Types are epic, story, task, sub-task and bug. Status is todo, in progress, in review, blocked,
done or dropped. The order is T-1 to T-7. The page checks come first among the open tasks, so they
guard the renderer work. Each task is one pull request of at most 10 files and 500 lines, planned
at 8 files at most.

## Items

### CR-9: Give hoop a consistent, professional interface on every page.

Every page shares one frame, one set of statuses and icons, and one type scale. Documents read as
formatted text, and reviewing works exactly as before.

Definition of done:
- Every story under it is done.
- Every success metric in the PRD meets its target.
- Every task's row holds its actual size and its review findings.
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

### ST-3: As a reviewer, I can use every page from the keyboard, offline, in either theme.

A reviewer may work in dark mode, on a phone, from the keyboard or with no network. Every page
must still work for them, with no serious accessibility problems.

What is expected:
- NFR-1, NFR-2 and NFR-3 in the PRD hold on the review list, a review and the tracker.

Out of scope:
- Speed, which T-5 checks together with the renderer it measures.

Definition of done:
- The page checks pass on all three pages in both themes.
- They keep passing as T-4 to T-7 change the pages.
- T-3 is merged.

### T-3: Check every page in both themes, at phone width, from the keyboard, offline and for accessibility.

The later tasks change how every line renders, and that is where layout and keyboard problems
start. These checks come first, so each later task must keep them green.

What is expected:
- One browser test opens the review list, a review and the tracker in the light and dark themes.
- At 400 pixels wide, no page scrolls sideways, and the frame and the finish button stay visible.
- Tab reaches every link, button and field, and the focused control shows a visible outline.
- With every request to another host blocked, each page renders fully.
- `axe-core` reports no serious or critical problems on any page.
- Any problem that the checks find on today's pages is fixed in the same pull request.

Scope:
- In: the new `test/pages.test.ts`, `package.json` for `axe-core` as a development dependency,
  `web/app.css` for fixes, and this tracker. The lockfile changes too, and it isn't counted.
- Out: the speed check and the checks for formatted lines, which T-5 adds to the same test file.

How to check:
- `test/pages.test.ts` passes with `HOOP_REQUIRE_BROWSER=1` set. Then a missing browser fails the
  run instead of skipping it.
- The full suite passes on Node 22, and the pull request records that run.

Definition of done:
- The change is merged in one pull request within the size budget.
- Every check above passes, and existing tests are unchanged.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.

### ST-2: As a reviewer, I read documents as formatted text and still comment on exact words.

A reviewer reads a document as it would look when published, with no markdown characters. A
comment on selected or typed words still anchors to the right source text, as it does today.

What is expected:
- FR-4 to FR-9 in the PRD hold, each with its acceptance criteria.

Out of scope:
- Tables other than trackers, and Mermaid diagrams, which CR-6 covers.
- Description blocks on the tracker page, which CR-11 covers.

Definition of done:
- Each acceptance criterion in FR-4 to FR-9 passes in a test.
- A reviewer can read, select and comment on a sample document end to end in the browser.
- T-4 to T-7 are merged.

### T-4: Decide each line's kind once on the server, and send the kinds to the pages.

Today the parser, the line splitter and the edit engine each judge what a line is. This task puts
that rule in one shared module, as HLD decision D-5 says. The pages get the kinds but don't use
them until T-5.

What is expected:
- `web/blocks.js` gives each line a kind and an indent. The kinds are paragraph, list item, quote,
  code block, break and table row.
- `blockKinds(rawLines)` and `pieceMarker(piece)` are its public functions, as the LLD names them.
- The markdown parser, `itemLines` and the edit engine's structure check use them.
- `GET /api/reviews/<id>` gives each item a `blocks` list parallel to its `lines`. The response also
  gains `history_blocks`.
- The agent tools refuse exactly the edits they refuse today.

Scope:
- In: the new `web/blocks.js` and `web/blocks.d.ts`, `src/contract.ts`, `src/markdown.ts`,
  `src/materialize.ts`, `src/web.ts`, the new `test/blocks.test.ts`, and this tracker.
- Out: rendering, which T-5 does. This splits the LLD's third pull request in two, because the
  pages ignore the new fields until T-5.

How to check:
- A parity test runs `blockKinds` against the parser on every file in `docs/` and on every fixture.
- A parity test shows that `pieceMarker` refuses exactly what today's rule refuses, on every line in
  `docs/`.
- `itemLines` returns the same lines as before for every fixture and every file in `docs/`.
- A web test checks `blocks` and `history_blocks` on a review with two revisions.

Definition of done:
- The change is merged in one pull request within the size budget.
- Every check above passes, and existing tests are unchanged.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.

### T-5: Show review lines as formatted text, and map each selection back to the source text.

This is the riskiest task, because a wrong map would anchor a comment to the wrong words. So the
renderer and the selection map land together.

What is expected:
- `web/inline.js` renders code, bold, italic, links and list markers inside a line. It shows
  quotes, code blocks and breaks as whole lines.
- `renderLine`, `shownText` and `widen` are its public functions, as the LLD names them.
- A selection inside a formatted run widens to the whole run, and the stored quote is source text.
- Only escaped text and a fixed set of tags reach the page. A link opens only an http or https
  address.
- A line that fails to render shows as plain text, and an unknown kind shows as written.

Scope:
- In: the new `web/inline.js` and `web/inline.d.ts`, `web/app.js`, `web/select.js`, `web/app.css`,
  the new `test/inline.test.ts`, `test/pages.test.ts`, and this tracker.
- Out: typed words and suggestions, which T-6 handles. The tracker page and the page details,
  which T-7 handles.

How to check:
- Unit tests cover each kind, each inline format, the source map, widening and the trust boundary.
- A browser test selects words inside code, bold text and a link. It compares each stored quote
  with the source.
- A browser test shows a sample document with no markdown characters.
- A browser test renders a 1000-line document in under 200 milliseconds.
- The comment anchors on stored reviews don't move.

Definition of done:
- The change is merged in one pull request within the size budget.
- Every check above passes, and the page checks from T-3 still pass.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.

### T-6: Find typed words across formatting, and keep each suggestion to its line's structure.

A reviewer can type the words they mean in "Only about this text", and a suggestion can't break a
list item or a quote. This finishes the comment tools on formatted text.

What is expected:
- Typed words such as "the foo value" find the line "the `foo` value", and the quote is the whole
  source text.
- A quoted comment shows its quote formatted, inside its line.
- A suggestion that would change a line's structure is stopped on the page. The page calls
  `pieceMarker`, which runs the same check as the server, and shows a message that says why.

Scope:
- In: `web/review.js`, `web/select.js`, `web/inline.js`, `test/inline.test.ts`, `test/ui.test.ts`,
  and this tracker.
- Out: the gutter button and the other page details, which T-7 handles.

How to check:
- Unit tests cover matching typed words across code, bold text and links.
- A browser test types words across formatting and checks the stored quote.
- A browser test tries a suggestion that removes a list marker. It checks the message, and that
  nothing is stored.

Definition of done:
- The change is merged in one pull request within the size budget.
- Every check above passes, and the page checks from T-3 still pass.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.

### T-7: Put the comment button in the gutter, hide document IDs, show the TL;DR once and hide empty badges.

These are four small fixes from the PRD's list of problems. They share one task because each one
changes a few lines in the same page files, and each has its own browser check.

What is expected:
- The comment button sits in the gutter, and a heading's text doesn't move when the reader points
  at it. This is FR-6.
- A document's headings and comment labels show no section IDs, and a structured review keeps
  them. This is FR-7.
- An automatic TL;DR shows once, as the first paragraph. An earlier comment on it shows under the
  title. This is FR-8.
- The finish button shows no badge when nothing is pending. This is FR-9.
- The tracker page formats item text through the renderer. It leaves description blocks and other
  tables as written.

Scope:
- In: `web/app.js`, `web/review.js`, `web/tree.js`, `web/app.css`, `test/ui.test.ts`,
  `test/tracker-page.test.ts`, and this tracker.
- Out: nested sections, which CR-12 covers, and collapsed conversations, which CR-13 covers.

How to check:
- One browser check for each of FR-6, FR-7, FR-8 and FR-9 is written from its acceptance criteria.
- A browser check shows that the tracker page formats item text and leaves description blocks as
  written.

Definition of done:
- The change is merged in one pull request within the size budget.
- Every check above passes, and the page checks from T-3 still pass.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.
