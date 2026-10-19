# hoop: tracker

| ID | Parent | Type | Title | Status | Depends on | PR | Size | Start | Done | Notes | Phase |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CR-1 | | change | Initial build (revs 1-8) | done | | #1-#22 | | 2026-10-13 | 2026-10-13 | `docs/changes/CR-1-initial-build/` | |
| FR-1 | CR-1 | requirement | Submit over MCP | done | | #2 | | | 2026-10-13 | | |
| FR-2 | CR-1 | requirement | Field-level validation errors | done | | #1 | | | 2026-10-13 | | |
| FR-3 | CR-1 | requirement | Review page: TL;DR, lines, outline, Viewed | done | FR-1 | #3 | | | 2026-10-13 | | |
| FR-4 | CR-1 | requirement | Comments, suggestions, answers, verdicts | done | FR-3 | #4, #5 | | | 2026-10-13 | | |
| FR-4a | CR-1 | requirement | Highlights and typed-text anchors | done | FR-4 | #5 | | | 2026-10-13 | Caret browsing needed for keyboard selection | |
| FR-5 | CR-1 | requirement | Read feedback over MCP | done | FR-1 | #2 | | | 2026-10-13 | | |
| FR-6 | CR-1 | requirement | Revisions and outdated threads | done | FR-4 | #7 | | | 2026-10-13 | | |
| FR-7 | CR-1 | requirement | Approval freezes; superseding reviews | done | FR-6 | #7 | | | 2026-10-13 | | |
| FR-8 | CR-1 | requirement | `hoop wait` | done | FR-5 | #6, #12 | | | 2026-10-13 | | |
| FR-9 | CR-1 | requirement | Decision search tool | dropped | | | | | | Retired in rev 5: grep `decisions/` | |
| FR-10 | CR-1 | requirement | Approval writes `decisions/` | done | FR-7 | #7 | | | 2026-10-13 | | |
| FR-11 | CR-1 | requirement | Agent replies in threads | done | FR-4 | #4, #9, #11 | | | 2026-10-13 | | |
| FR-12 | CR-1 | requirement | Open decision PRs | done | FR-1 | #8 | | | 2026-10-13 | | |
| FR-13 | CR-1 | requirement | Sync PR reviews into feedback | done | FR-12 | #9, #12 | | | 2026-10-13 | | |
| FR-14 | CR-1 | requirement | GitHub revisions as commits | done | FR-12 | #8 | | | 2026-10-13 | | |
| FR-15 | CR-1 | requirement | Merge approves, close rejects | done | FR-13 | #9, #12 | | | 2026-10-13 | | |
| FR-16 | CR-1 | requirement | Any markdown document | done | FR-1 | #17, #19 | | | 2026-10-13 | | |
| FR-17 | CR-1 | requirement | Byte-identical export | done | FR-16 | #17, #19 | | | 2026-10-13 | Setext headings export as `#` | |
| FR-18 | CR-1 | requirement | Apply suggestions in place | done | FR-4 | #14 | | | 2026-10-13 | | |
| FR-19 | CR-1 | requirement | Heading, title and TL;DR scopes | done | FR-4 | #13 | | | 2026-10-13 | | |
| FR-20 | CR-1 | requirement | `hoop_propose_edits` | done | FR-19 | #15, #18 | | | 2026-10-13 | | |
| FR-21 | CR-1 | requirement | Tracked changes, Accept and Reject | done | FR-20 | #16, #18 | | | 2026-10-13 | | |
| FR-22 | CR-1 | requirement | Minimal, byte-identical edits | done | FR-18 | #14, #18 | | | 2026-10-13 | | |
| FR-23 | CR-1 | requirement | Audit log | done | | #20 | | | 2026-10-13 | | |
| FR-24 | CR-1 | requirement | `hoop audit` summary | done | FR-23 | #20 | | | 2026-10-13 | | |
| NFR-1 | CR-1 | requirement | Local first; cross-site requests refused | done | | #3, #11 | | | 2026-10-13 | | |
| NFR-7 | CR-1 | requirement | Node 18.18+, no native modules | done | | #2 | | | 2026-10-13 | Browser tests need Node 20+ | |
| B-1 | | idea | Materialize comments on the GitHub channel | todo | FR-21 | | | | | Out of scope in rev 7; not scoped | |
| B-2 | | idea | Trace requirements to code PRs in CI | todo | | | | | | Deferred in rev 4; not scoped | |
| B-3 | | idea | GitHub Action for decision PRs | todo | FR-12 | | | | | Deferred in rev 4; not scoped | |
| B-4 | | idea | Publish to npm | todo | | | | | | Open question in PRD | |
| B-5 | FR-17 | bug | Export assumes one blank line after headings | done | | | | 2026-10-13 | 2026-10-13 | Fixed by CR-2 | |
| CR-2 | B-5 | change | Keep blank lines around headings on export | done | | #24 | 4 files | 2026-10-13 | 2026-10-13 | `docs/changes/CR-2-heading-spacing/`; folded | |
| B-6 | | idea | Tracker items as epic / story / task / bug, shown as a tree table in hoop | done | | | | 2026-10-13 | 2026-10-13 | Done by CR-3 FR-29, FR-30 | |
| B-7 | | idea | hoop interfaces for devloop; the tracker records each change's devloop phase | done | | | | 2026-10-13 | 2026-10-13 | Done by CR-3 FR-28, FR-31 | |
| B-8 | | idea | PRD, HLD and LLD all approved before development starts | done | | | | 2026-10-13 | 2026-10-13 | Done by CR-3 FR-27 | |
| CR-3 | B-6 | change | devloop interfaces, ordered design reviews, Jira-like tracker | done | CR-2 | #27, #32-#37 | 7 PRs | 2026-10-13 | 2026-10-13 | `docs/changes/CR-3-devloop-interfaces/`; folded | |
| FR-25 | CR-3 | requirement | Change requests as written, numbered, on the tracker | done | | #27 | | | 2026-10-13 | | |
| FR-26 | CR-3 | requirement | Classification and recorded corrections | done | | #27 | | | 2026-10-13 | | |
| FR-27 | CR-3 | requirement | PRD, HLD, LLD reviews in order; staleness | done | FR-25 | #32 | | | 2026-10-13 | | |
| FR-28 | CR-3 | requirement | Steps recorded; build and fold gates | done | FR-27 | #27, #32 | | | 2026-10-13 | | |
| FR-29 | CR-3 | requirement | Tracker as a tree; row-only writes | done | | #33 | | | 2026-10-13 | | |
| FR-30 | CR-3 | requirement | Tracker page and tracker reviews as trees | done | FR-29 | #34 | | | 2026-10-13 | | |
| FR-31 | CR-3 | requirement | Terminal commands for every tool | done | FR-25 | #36 | | | 2026-10-13 | | |
| CR-8 | | epic | Remove duplicated code from hoop and make it easier to read. | done | CR-3 | #45-#49 | | 2026-10-13 | 2026-10-13 | Folded; see `docs/changes/CR-8-refactor-tech-debt/`. | fold |
| CR-9 | | epic | Give hoop a consistent, professional interface on every page. | done | CR-8 | #60-#71 | | 2026-10-13 | 2026-10-14 | Folded; see `docs/changes/CR-9-professional-ui/`. | fold |
| CR-6 | | story | Render tables in one standard format and Mermaid diagrams on hoop's pages. | queued | CR-9 | | | 2026-10-13 | | Queued; `docs/changes/CR-6-tables-templates-diagrams/` | intake |
| CR-5 | | task | Rewrite the project tracker to the tracker standard. | queued | CR-11 | | | 2026-10-13 | | Queued; `docs/changes/CR-5-project-docs-standard/` | intake |
| CR-7 | | story | Give every change request a functional or non-functional kind and a project. | queued | CR-5 | | | 2026-10-13 | | Queued; `docs/changes/CR-7-projects-change-kinds-pr-reviews/` | intake |
| CR-4 | | story | change request queue | closed | CR-7 | | | 2026-10-13 | | Queued; `docs/changes/CR-4-change-request-queue/` | closed |
| CR-10 | | story | Run the project's document checks when a document is submitted, and show the findings. | done | | #73-#78 | | 2026-10-14 | 2026-10-19 | Folded; see `docs/changes/CR-10-writing-rules/`. | fold |
| CR-11 | | story | Show each tracker item's description on the tracker page, and flag items without one. | queued | | | | | | Queued after CR-13; see `docs/changes/CR-11-definition-of-done/NOTES.md`. | intake |
| CR-12 | | story | Show the sections of a reviewed document nested up to five levels deep. | queued | | | | | | Queued after CR-11; see `docs/changes/CR-12-nested-sections/NOTES.md`. | intake |
| CR-13 | | story | Collapse resolved conversations, and let a reviewer hide every comment on a page. | queued | | | | | | | intake |
| CR-14 | | story | Let agents approve documents through hoop, and keep a full audit trail on each document. | queued | | | | | | | intake |
| CR-15 | | story | Keep each queued change request as a hoop review whose revisions record its checks. | queued | | | | | | | intake |
| CR-16 | | story | Add a change request page with queued and completed changes and links to their documents. | queued | | | | | | | intake |
| CR-17 | | story | Filter reviews and change requests by project, and move queued changes between projects. | queued | | | | | | | intake |
| CR-18 | | task | Improve trackers and task breakdown, and order the queue for development speed. | closed | | | | 2026-10-14 | 2026-10-14 | Split into devloop 0.27.0, CR-9's new plan, CR-11 and the queue order; see `docs/changes/CR-18-tracker-breakdown-queue/NOTES.md`. | closed |

Status: todo · in progress · in review · blocked · done · dropped. Queue: CR-9, CR-10, CR-13, CR-11, CR-5, CR-14, CR-12, CR-6, CR-16, CR-15, CR-7, CR-17, ordered by development speed in CR-18 (CR-4 closed as a duplicate of CR-15 and CR-16). Overlaps are resolved in each change's `NOTES.md`. Next change request: CR-19.
