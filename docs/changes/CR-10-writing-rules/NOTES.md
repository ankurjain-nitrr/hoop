# CR-10: intake notes

Captured on 2026-10-13 with `hoop cr create`. The state is queued. The proposed type is story,
because hoop gains one capability: it checks the writing rules on every document it reviews. The
proposed kind is functional, and the project is hoop.

## What the request covers

The request sets three rules for all text in tasks, PRDs, HLDs and LLDs. Text must be complete
sentences, not phrases. It must use simple language. It must not use em dashes. The request also
asks for one common layer that applies these rules strictly.

## What is already done

The common layer now exists outside hoop. The devloop plugin has a `writing` skill (version
0.12.0) that holds the rules and a checker script. The vet-docs skill refuses to pass a document
until the checker reports nothing. Every other devloop skill that writes text points to the same
rules. So every new document and work item follows the rules from now on.

## What is left for hoop

- The hoop server runs the same checks when a document is submitted, and returns each finding
  to the agent.
- The review page shows the findings to the reviewer next to the lines they concern.
- The tracker rows that hoop writes use complete sentences as titles.

## Overlap

- CR-5 (queued) rewrites the project PRD and HLD to the new standard. Rewriting the existing
  documents to the writing rules is the same kind of work. The resolution is that CR-5 also
  rewrites the project LLD, the project tracker and every change folder's documents, so that they
  pass the checker. Today the checker finds 22 problems in the PRD, 26 in the HLD, 13 in the LLD
  and 60 in the tracker.
- CR-9 (queued) redesigns the review page. The resolution is that CR-10 shows its findings with
  the components that CR-9 builds, so CR-10 runs after CR-9.
- CR-8 (queued) refactors the code that CR-10 extends. CR-8 runs first.

The queue order is CR-8, CR-9, CR-10, CR-6, CR-5, CR-7 and CR-4. All of them run after CR-3,
which is done.

## Pick-up check (2026-10-14)

Shrink. devloop 0.12.0 already holds the writing rules and the checker, and its document review requires a clean check. CR-10 now covers only hoop showing the checker's findings on the review page.
