# CR-16: intake notes

Captured on 2026-10-14 with `hoop cr create`, from the same request as CR-14 and CR-15. The state
is queued. The proposed type is story and the kind is functional. The project is hoop.

## What it covers

- A page lists the change requests, in queued and completed groups.
- Each change links to every document it has: its request, PRD, HLD, LLD, tracker and reviews.
- Change requests leave the tracker. A tracker's epics, stories and tasks reference their root
  change request instead.

## Capture check

- The verdict is that it overlaps CR-4, which asks for the queue and its overlaps to show in hoop.
  CR-4 is dropped as a duplicate of CR-15 and CR-16.
- It overlaps CR-13, which adds a menu and a home page. CR-13 runs first, so the change request
  page joins its menu.
- It changes what CR-3 built: hoop writes a row for each change into the tracker today. That row
  becomes a link from the root work item. CR-3 isn't reopened.
- CR-7 adds project filters, which this page will hold. CR-7 runs after CR-16.

## Reordered on 2026-10-14 (CR-18)

It runs after CR-6, and it adds its page to the frame that CR-9 built. Its scope is unchanged.

## Merged on 2026-10-19 (CR-21)

CR-16 absorbs CR-15. The page lists queued and completed changes and links their documents. Each change's capture and pick-up checks are recorded as revisions of its request, and the page shows them. Merging, shrinking, splitting or dropping a change is recorded the same way. A change that grows too large is flagged, with a proposal to split it. Scoping should split the page and the recorded checks into two stories.

The absorbed change's request and notes are in `docs/changes/CR-15-cr-revisions-checks/`.

## Merged into CR-31 (2026-10-20)

The requester merged every queued change into CR-31, to be built in one go as one pull request.
This change's request stays here, in the requester's words, and CR-31 meets it.
