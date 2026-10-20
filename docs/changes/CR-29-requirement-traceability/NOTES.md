# CR-29: notes

Captured on 2026-10-20 with `hoop cr create`. The proposed type is task. The project is hoop.

## What the request means

- An HLD or an LLD points only to FRs and NFRs. It never names a change request.
- Each FR and NFR in the PRD names the change requests that added or changed it.
- A change request always lands as new or changed FRs or NFRs. It reaches the HLD and the LLD only
  through them.

## Capture check

The verdict is new.
- Today the project HLD names change requests 71 times, and the project LLD 24 times. The PRD
  names them in its group headings and in some requirements, not on every requirement.
- The rule isn't in devloop's PRD, HLD and LLD templates, its review standards or its fold steps.
  So new documents would keep adding change request names.
- CR-22's fold is in progress. Its new HLD and LLD text follows the rule already, so this change
  runs after that fold merges.
- No queued change covers it. It runs first, because every later fold depends on it.

## Open points for scoping

- Whether each change's own HLD and LLD follow the rule too, or only the project documents. An
  approved change document is a frozen record, so the plan is to apply the rule to new ones only.
- Whether the writing checker should flag a change request name in an HLD or an LLD.

## Merged into CR-30 (2026-10-20)

CR-30 rewrites the same documents and skills, so this change is built as part of it. Its request
stays here, in the requester's words, and CR-30 meets it.
