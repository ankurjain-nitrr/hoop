# CR-15: intake notes

Captured on 2026-10-14 with `hoop cr create`, from the same request as CR-14 and CR-16. The state
is queued. The proposed type is story and the kind is functional. The project is hoop.

## What it covers

- A queued change request is kept as a hoop review of its request.
- Each capture check and pick-up check adds a revision with its verdict and reasons as comments. The
  verdicts are new, already done, partly done, duplicate and conflict.
- Merging, shrinking, splitting or dropping a change is recorded the same way.
- A change that grows too large is flagged, with a proposal to split it.

## Capture check

The verdict is that it overlaps CR-4. CR-4 asks to queue change requests and to resolve and show
overlaps among queued ones. CR-15 records those checks, and CR-16 shows them. So CR-4 is dropped as
a duplicate, and its request is linked from here.

It runs after CR-14, because the checks are recorded through the same reviews and approvals.
