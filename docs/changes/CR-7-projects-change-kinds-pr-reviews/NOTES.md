# CR-7: intake notes

Captured 2026-10-13, during CR-3's build. State: queued. Proposed type: epic (several capabilities:
a functional or non-functional kind on every change, a project on every change and work item,
pull requests listed as reviews that need a human, project filters, moving queued changes between
projects). Proposed kind: functional. Project: hoop.

Proposed kind and project for existing changes (applied when CR-7 is built):

| Change | Kind | Project |
|---|---|---|
| CR-1 initial build | functional | hoop |
| CR-2 heading spacing | functional (bug) | hoop |
| CR-3 devloop interfaces | functional | hoop |
| CR-4 change request queue | functional | hoop |
| CR-5 project docs standard | non-functional (documents) | hoop |
| CR-6 tables, templates, diagrams | functional | hoop |
| CR-7 this change | functional | hoop |

Overlap check against queued changes:
- CR-4 (queued): CR-4 builds the queue. Moving queued changes between projects and filtering
  changes by project are queue operations. Resolution: CR-7 adds the project and the kind to
  every change, and the moves and filters; CR-4 then builds its queue and overlap view per project
  on top of them. CR-7 runs before CR-4.
- CR-5 (queued): both change the project PRD and HLD. Resolution: CR-7 runs after CR-5, as CR-4
  does, so it folds into the rewritten documents.
- CR-6 (queued): the review list and change list filters use CR-6's standard tables. Resolution:
  CR-7 runs after CR-6.

Related, not queued: CR-3 (in build). It classifies changes as epic, story, task or bug (FR-2) and
needs linked PRs merged before fold (FR-7). CR-7 adds a second dimension (functional or
non-functional) and a project without changing CR-3's approved scope. Pull requests needing a
human review apply to CR-3's own PRs now, as a working rule: none is merged until the requester
reviews it on GitHub.

Queue order: CR-6, CR-5, CR-7, CR-4 (all after CR-3).

## Pick-up check (2026-10-14)

Split. CR-7 keeps the functional or non-functional kind and the project on every change and work item. Project filters and moving queued changes between projects moved to CR-17. The part about pull requests needing human review is dropped, because the requester later set pull requests to auto approval. The requester can bring it back.

## Reordered on 2026-10-14 (CR-18)

It moves to the end of the queue, because hoop is the only project today. Its scope is unchanged.

## Merged on 2026-10-19 (CR-21)

CR-7 absorbs CR-17 again, since both came from one request and hoop is still the only project. It covers a kind and a project on every change, project filters and moves between projects. It becomes an epic with two stories, kinds and projects first and filters and moves second. It stays last in the queue.

The absorbed change's request and notes are in `docs/changes/CR-17-project-filters/`.

## Merged into CR-31 (2026-10-20)

The requester merged every queued change into CR-31, to be built in one go as one pull request.
This change's request stays here, in the requester's words, and CR-31 meets it.
