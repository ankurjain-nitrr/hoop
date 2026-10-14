# CR-13: intake notes

Captured on 2026-10-14 with `hoop cr create`. The state is queued. The proposed type is story,
because the review pages gain one capability: a way around them that keeps finished work out of the
way. The proposed kind is functional, and the project is hoop.

## What the request asks

- A conversation collapses once it is resolved.
- A control at the top of a review hides or shows every comment on the page.
- Every page has a menu, and "All reviews" is one of its options.
- The home page lists pending reviews and completed reviews.

## Overlap

- CR-9 (in progress, design approved, build not started) adds a shared page frame and a review
  list grouped by status. The menu and the home page are the same work at a larger size. Collapsed
  conversations and hiding comments change the review page that CR-9 also changes.
- The resolution proposed to the requester is to fold CR-13 into CR-9 through a new PRD revision.
  Otherwise CR-13 runs right after CR-9, building on its frame and list. Until the requester
  decides, CR-13 stays queued after CR-9.
- CR-7 (queued) adds project filters to the review list, which the home page will hold. CR-7 runs
  after CR-13 either way.

The queue order is CR-13, CR-10, CR-11, CR-12, CR-6, CR-5, CR-7 and CR-4, after CR-9.

## Added on 2026-10-14

The requester asked that every comment from an agent review be resolved and collapsed before a
document reaches them. devloop 0.25.0 now resolves agent threads before the handover. hoop shows
resolved threads but doesn't collapse them yet, so collapsing resolved conversations in CR-13
completes this.
