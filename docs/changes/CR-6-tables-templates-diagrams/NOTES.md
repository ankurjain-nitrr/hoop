# CR-6: intake notes

Captured 2026-10-13, during CR-3's plan review. State: queued. Proposed type: epic (table rendering
with standard formats, default PRD, HLD and LLD templates, mermaid diagrams).

Overlap check:
- CR-3 (in progress): nested tasks and epics with expand and collapse are CR-3's FR-9 and FR-10
  (tracker tree table); not duplicated here. CR-6 reuses CR-3's tree table, so it runs after CR-3.
- CR-5 (queued): rewrites the project PRD and HLD to the standard. Resolution: CR-6 runs before
  CR-5, so the rewrite uses hoop's templates and diagrams.
- CR-4 (queued): shows the queue as a table in hoop. Resolution: CR-4 runs after CR-6, so the
  queue uses the standard table format.

Queue order: CR-6, CR-5, CR-4 (all after CR-3).

## Templates and Mermaid (added on 2026-10-14)

The requester made Mermaid the default language for flow and architecture diagrams. devloop 0.23.0
now has simple PRD, HLD and LLD templates built from the sections most published templates share,
with every diagram in Mermaid. New design documents already use them. Until CR-6 lands, hoop's
review page shows a Mermaid diagram as code. CR-6 makes hoop render Mermaid and offer the same
templates, so the two stay in step.

## Pick-up check (2026-10-14)

Shrink. devloop 0.23.0 already holds the PRD, HLD and LLD templates and makes Mermaid the default. CR-6 now covers only hoop rendering tables in one standard format and rendering Mermaid diagrams.
