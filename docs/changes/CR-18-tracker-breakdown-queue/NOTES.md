# CR-18: intake notes

Captured on 2026-10-14 with `hoop cr create`. The proposed type is task and the kind is
non-functional. The project is hoop. The request asks for a look back at trackers and task
breakdown, and for a queue ordered by development speed.

## Capture check

The verdict is partly new. CR-11 already covers showing each item's description block in hoop. The
rest is devloop work, a new plan for CR-9's open tasks and a new queue order. So CR-18 is split, and
nothing of it stays queued.

## What the look back found

- Task sizes were too low. CR-9's first task was estimated at 8 files and came out at 15, so it was
  split during the build. The estimates left out tests, type declarations, styles and the tracker.
- Item blocks were too short. Most had two sentences, so they didn't say what was expected, what
  was out of scope or how to check the work.
- Two of CR-9's tasks weren't cut well. One was a grab bag of page details. Another held only page
  checks, at the end, where it couldn't guard the risky renderer work.
- Nothing recorded estimate against actual size, or the review findings. The fresh reviews found 4
  defects in T-1 and 3 in T-2.
- A piped test command let a failing run commit once.

## Where each part went

- The devloop 0.27.0 release, from skills pull request 20, changes the item blocks. Each block has
  a why, what is expected, what is out of scope, how to check it and its definition of done. It checks the breakdown before the slice map
  is shown. It plans tasks at 8 files at most, gates on the test command's own status, and looks
  back at sizes and findings after each milestone.
- CR-9's open tasks get a new plan under the new rules, as a diff review of its tracker.
- CR-11 also flags tracker items that have no block or no definition of done.
- The queue is ordered by how much each change speeds up hoop's own development.

## Queue order

1. CR-9 finishes its build. Its open tasks follow the new plan.
2. CR-10 runs the project's document checks when a document is submitted. Writing problems then
   reach the agent before any review round starts.
3. CR-13 collapses resolved conversations and can hide every comment. That cuts the requester's
   reading time on each review.
4. CR-11 shows item blocks on the tracker page and flags missing ones. That supports the detailed
   blocks in devloop 0.27.0.
5. CR-5 rewrites only the project tracker to the standard, because every fold writes into it.
6. CR-14 records agent approvals and keeps an audit trail for each document.
7. CR-12 nests sections up to five levels deep.
8. CR-6 renders tables in one format and Mermaid diagrams.
9. CR-16 adds the change request page.
10. CR-15 records each queued change's checks as revisions of its request review.
11. CR-7 and CR-17 add kinds, projects and project filters. They come last, because hoop is the only
    project today.
