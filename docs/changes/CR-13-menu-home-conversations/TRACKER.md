# CR-13: tracker

This tracker lists CR-13's work items. Requirements stay in `PRD.md`, and the Covers column points
to them. The table is the index, and each item's description and definition of done are in its
block under "Items".

| ID | Parent | Type | Title | Covers | Status | Phase | Depends on | PR | Size | Start | Done | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CR-13 | | story | Collapse resolved conversations, and let a reviewer hide every comment on a page. | | in progress | build | | | | 2026-10-14 | | |
| T-1 | CR-13 | task | Collapse resolved conversations, and add the hide control and its page mode. | FR-1, FR-2, FR-3, FR-4, FR-5, NFR-1 | in review | | | | 8 files, ~230 lines | 2026-10-19 | | |

Types are epic, story, task, sub-task and bug. Status is todo, in progress, in review, blocked,
done or dropped. The change is one task in one pull request, planned at 8 files at most.

## Items

### CR-13: Collapse resolved conversations, and let a reviewer hide every comment on a page.

Resolved agent threads crowd every document the requester reads, and a reviewer can't read a
document without its comments. This change collapses resolved threads and adds one control that
hides every comment.

What is expected:
- Each resolved conversation shows as a summary row until the reviewer opens it.
- One control hides and shows every comment, and the verdict never happens with comments hidden.

Out of scope:
- The menu and home page, which CR-9 delivered, and GitHub's own pages.

Definition of done:
- Every acceptance criterion in the PRD passes in a browser test.
- The page checks pass with collapsed rows and with comments hidden.
- Its PRD, HLD and LLD are folded into the project documents.

### T-1: Collapse resolved conversations, and add the hide control and its page mode.

The change touches only the review page, and its parts depend on each other. So it lands as one
task, and it covers six requirements because each is a small part of the same page change.

What is expected:
- A resolved conversation renders as a `details` element with a summary row, as the LLD describes.
  An opened one stays open while the page is open.
- A later reply on a local thread shows it in full. A GitHub thread follows GitHub's state.
- The hide control sets `state.commentsHidden`, and every render applies the page mode from it.
  Elements marked `hide` disappear, and elements marked `plain` keep their words without styling.
  Focus stays on the control.
- Opening the comment box or the finish panel clears `state.commentsHidden`, so comments show at
  verdict time.

Scope:
- In: `web/app.js`, `web/review.js`, `web/select.js`, `web/inline.js`, `web/app.css`,
  `test/ui.test.ts`, `test/pages.test.ts`, and this tracker.
- Out: anything on the server or in the stored files.

How to check:
- Browser tests cover each PRD acceptance criterion, at 400 pixels for the summary rows.
- A browser test turns the mode on and checks that no comment text stays visible.
- The page checks in `test/pages.test.ts` run with collapsed rows and with comments hidden.
- Two points come from the LLD reviews for code review. The `toggle` event doesn't bubble, so its
  listener needs the capture phase. The FR-3 test needs a reply that is strictly later than the
  resolution.

Definition of done:
- The change is merged in one pull request within the size budget.
- Every check above passes, and each new test fails on the base first.
- Every finding from the fresh review is fixed, each with a regression test.
- The row's PR, actual size, dates and notes are filled in.
