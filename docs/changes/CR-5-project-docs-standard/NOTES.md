# CR-5: intake notes

Captured 2026-10-13 from the vet-docs review of the project documents; the requester chose to
queue it. State: queued. Proposed type: task (documents only).

Overlap check against queued changes:
- CR-4 (queued): both change the project PRD and HLD (CR-5 rewrites them; CR-4's fold adds the
  queue to them). Resolution: run CR-5 before CR-4, right after CR-3's fold, so CR-4 folds into
  documents that already meet the standard and the rewrite isn't redone.

Overlap with CR-6 (queued later): CR-6 adds hoop's default templates and diagrams. Resolution:
CR-6 runs before CR-5, so the rewrite uses them.

## Writing rules (added with CR-10)

CR-5 also rewrites the project LLD, the project tracker and every change folder's documents to the
devloop writing rules. Each document must pass the writing checker with no findings. `REQUEST.md`
files keep the requester's own words.
