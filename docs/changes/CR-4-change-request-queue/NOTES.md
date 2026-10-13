# CR-4: intake notes

Captured 2026-10-13, during CR-3's LLD review. State: queued. Proposed type: story (one capability:
a queue of change requests with overlap resolution, shown in hoop). Depends on CR-3's change
registry (steps, change list) and tracker view.

Overlap check against queued changes: none queued besides CR-4. Related, not queued: CR-3 (in
progress) builds the change registry this queue extends.

Overlap with CR-5 (queued, captured later): both change the project PRD and HLD. Resolution:
CR-5 runs first; CR-4 folds into the rewritten documents.

Overlap with CR-6 (queued later): CR-6 standardizes how tables render. Resolution: CR-4 runs
after CR-6, so the queue uses the standard format. Queue order: CR-6, CR-5, CR-4.

Overlap with CR-7 (queued later): CR-7 adds a project and a kind to every change, with moves
between projects. Resolution: CR-7 runs before CR-4, so the queue and its overlap view are per
project. Queue order: CR-6, CR-5, CR-7, CR-4.
