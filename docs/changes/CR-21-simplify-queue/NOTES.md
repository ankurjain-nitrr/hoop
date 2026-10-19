# CR-21: intake notes

Captured on 2026-10-19 with `hoop cr create`. The proposed type is task, because only documents
change. The project is hoop.

## What the request covers

The queue held 11 change requests and 14 ideas, and several of them covered the same ground. This
change merges each overlapping group into one change, so each area has one owner and one order.

## The merges

| Kept | Absorbs | Why they overlap |
|---|---|---|
| CR-20 | CR-19, part of B-22 | All of them make hoop usable and buildable by anyone. CR-19 becomes its first story. |
| CR-11 | CR-5 | CR-11 flags tracker items with no block, and CR-5 fills the blocks in the project tracker. |
| CR-14 | B-9, B-17 | All of them change how a document is approved and what the approval records. |
| CR-12 | CR-6, B-14 | All of them change how the review page reads and renders a document's structure. |
| CR-16 | CR-15 | Both came from one request. The page shows the checks that CR-15 records. |
| CR-7 | CR-17 | Both came from one request, and the filters need the project that CR-7 adds. |
| B-12 | B-13 | Both make GitHub sync failures visible and typed instead of silent. |
| B-15 | B-18 | Both add a view that compares revisions. |
| B-16 | B-4 | Both publish hoop to npm. |

Each absorbed change is closed, and its request and notes stay in its folder for the record. The
kept change's notes link to them.

## The new queue

B-10, CR-20, CR-11, CR-14, CR-12, CR-16 and CR-7. B-10 runs first because a stale server cost the
most time in recent work. It becomes CR-22 when it starts. The other ideas follow in their order.

## Capture check

The verdict is new. CR-18 did the last reorder, and it is closed. This change is closed once the
merges are recorded, because nothing is built.
