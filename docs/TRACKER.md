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
| B-4 | | idea | Publish hoop to npm. | dropped | | | | | | Merged into B-16 by CR-21 on 2026-10-19. | |
| B-5 | FR-17 | bug | Export assumes one blank line after headings | done | | | | 2026-10-13 | 2026-10-13 | Fixed by CR-2 | |
| CR-2 | B-5 | change | Keep blank lines around headings on export | done | | #24 | 4 files | 2026-10-13 | 2026-10-13 | `docs/changes/CR-2-heading-spacing/`; folded | |
| B-6 | | idea | Tracker items as epic / story / task / bug, shown as a tree table in hoop | done | | | | 2026-10-13 | 2026-10-13 | Done by CR-3 FR-29, FR-30 | |
| B-7 | | idea | hoop interfaces for devloop; the tracker records each change's devloop phase | done | | | | 2026-10-13 | 2026-10-13 | Done by CR-3 FR-28, FR-31 | |
| B-8 | | idea | PRD, HLD and LLD all approved before development starts | done | | | | 2026-10-13 | 2026-10-13 | Done by CR-3 FR-27 | |
| B-9 | | idea | A human gate that the agent can't skip or fake, for gated approvals. | dropped | | | | | | Merged into CR-14 by CR-21 on 2026-10-19. | |
| B-10 | | idea | The server reports its version, and a page warns when it is stale. | dropped | | | | | | Merged into CR-22 on 2026-10-19; see `docs/FEEDBACK.md`. | |
| B-11 | | idea | Fix lost writes, colliding IDs and partial multi-file changes in the store. | todo | | | | | | First review items 2 and 6. The store has no lock, and decision files skip the atomic write. | |
| B-12 | | idea | Page through GitHub reviews and comments, show sync errors, and type errors by kind. | todo | | | | | | First review items 3 and 7. Items past 100 are dropped, and a failed thread query shows every thread as open. B-13 merged in. | |
| B-13 | | idea | Type errors by kind, not by their wording. | dropped | | | | | | Merged into B-12 by CR-21 on 2026-10-19. | |
| B-14 | | idea | Keep a section's comments when its heading is renamed or repeated. | dropped | | | | | | Merged into CR-12 by CR-21 on 2026-10-19. | |
| B-15 | | idea | Compare any two revisions, and show which comments the agent addressed, answered or ignored. | todo | | | | | | Second review items 4 and 8. B-18 merged in. | |
| B-16 | | idea | Publish hoop to npm, with a one-line install. | todo | | | | | | Second review item 2. B-4 merged in. It runs after CR-20. | |
| B-17 | | idea | Approve with notes, kept in the decision record. | dropped | | | | | | Merged into CR-14 by CR-21 on 2026-10-19. | |
| B-18 | | idea | Compare any two revisions. | dropped | | | | | | Merged into B-15 by CR-21 on 2026-10-19. | |
| B-19 | | idea | Delete text or a whole line in one action, and edit lines in place as span edits. | dropped | | | | | | Merged into CR-25 on 2026-10-19; see `docs/FEEDBACK.md`. | |
| B-20 | | idea | Document setup for other agents, and publish the review and feedback schemas. | dropped | | | | | | Merged into CR-28 on 2026-10-19; see `docs/FEEDBACK.md`. | |
| B-21 | | idea | Render only what changes on the review page, and stop the server importing page code. | todo | | | | | | First review items 8 and 9. | |
| B-22 | | idea | Size the process to the change, so a small fix needs fewer documents. | todo | | | | | | First review item 10. The check for change request names in code comments moved to CR-20. | |
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
| CR-6 | | story | Render tables in one standard format and Mermaid diagrams on hoop's pages. | closed | CR-9 | | | 2026-10-13 | | Merged into CR-12 by CR-21 on 2026-10-19. | closed |
| CR-5 | | task | Rewrite the project tracker to the tracker standard. | closed | CR-11 | | | 2026-10-13 | | Merged into CR-11 by CR-21 on 2026-10-19. | closed |
| CR-7 | | epic | Give every change a kind and a project, and filter and move changes by project. | closed | CR-16 | | | 2026-10-13 | | Merged into CR-31 on 2026-10-20, at the requester's request; see its NOTES.md. | closed |
| CR-4 | | story | change request queue | closed | CR-7 | | | 2026-10-13 | | Queued; `docs/changes/CR-4-change-request-queue/` | closed |
| CR-10 | | story | Run the project's document checks when a document is submitted, and show the findings. | done | | #73-#78 | | 2026-10-14 | 2026-10-19 | Folded; see `docs/changes/CR-10-writing-rules/`. | fold |
| CR-11 | | story | Show each tracker item's description, flag items without one, and fill the project tracker's blocks. | closed | | | | | | Merged into CR-31 on 2026-10-20, at the requester's request; see its NOTES.md. | closed |
| CR-12 | | epic | Render a document's structure, with nested sections, stable comments, tables and Mermaid diagrams. | closed | | | | | | Merged into CR-31 on 2026-10-20, at the requester's request; see its NOTES.md. | closed |
| CR-13 | | story | Collapse resolved conversations, and let a reviewer hide every comment on a page. | done | | #86-#87 | | 2026-10-14 | 2026-10-19 | Folded; see `docs/changes/CR-13-menu-home-conversations/`. | fold |
| CR-14 | | epic | Require a GitHub sign-in for the final approval, let agents approve only as agents, and keep notes and an audit trail. | closed | | | | | | Merged into CR-31 on 2026-10-20, at the requester's request; see its NOTES.md. | closed |
| CR-15 | | story | Keep each queued change request as a hoop review whose revisions record its checks. | closed | | | | | | Merged into CR-16 by CR-21 on 2026-10-19. | closed |
| CR-16 | | epic | Add a change request page that lists queued and completed changes, links their documents and records their checks. | closed | | | | | | Merged into CR-31 on 2026-10-20, at the requester's request; see its NOTES.md. | closed |
| CR-17 | | story | Filter reviews and change requests by project, and move queued changes between projects. | closed | | | | | | Merged into CR-7 by CR-21 on 2026-10-19. | closed |
| CR-18 | | task | Improve trackers and task breakdown, and order the queue for development speed. | closed | | | | 2026-10-14 | 2026-10-14 | Split into devloop 0.27.0, CR-9's new plan, CR-11 and the queue order; see `docs/changes/CR-18-tracker-breakdown-queue/NOTES.md`. | closed |
| CR-19 | | task | Make hoop complete in itself, with no sandbox repository or personal paths. | closed | | | | | | Merged into CR-20 by CR-21 on 2026-10-19. | closed |
| CR-20 | | epic | Make hoop usable and buildable by anyone, with no personal setup, commit hooks, CI and open source guides. | closed | | | | | | Merged into CR-31 on 2026-10-20, at the requester's request; see its NOTES.md. | closed |
| CR-21 | | task | Merge overlapping change requests and ideas, so the queue is shorter. | closed | | | | 2026-10-19 | 2026-10-19 | It merged five changes and six ideas into others; see `docs/changes/CR-21-simplify-queue/NOTES.md`. | closed |
| CR-22 | | story | Serve every session's pages from one current background process on the usual address. | done | | #92-#100 | | 2026-10-19 | 2026-10-20 | Folded; see `docs/changes/CR-22-server-per-repo/`. | fold |
| CR-23 | | story | Offer the core review tools by default, and turn on devloop's change and tracker tools per project. | closed | | | | | | Merged into CR-31 on 2026-10-20, at the requester's request; see its NOTES.md. | closed |
| CR-24 | | story | Make submitting clear: one obvious way to submit, and results that say what was created, revised or written. | closed | | | | | | Merged into CR-31 on 2026-10-20, at the requester's request; see its NOTES.md. | closed |
| CR-25 | | epic | Let comments anchor to quoted words, and state edit rules before an edit fails. | closed | CR-12 | | | | | Merged into CR-31 on 2026-10-20, at the requester's request; see its NOTES.md. | closed |
| CR-26 | | story | Let an agent wait for review feedback through MCP alone, without a shell. | closed | | | | | | Merged into CR-31 on 2026-10-20, at the requester's request; see its NOTES.md. | closed |
| CR-27 | | story | Say clearly when a declared document check isn't allowed, and make allowing it one step. | closed | | | | | | Merged into CR-31 on 2026-10-20, at the requester's request; see its NOTES.md. | closed |
| CR-28 | | story | Reorder the README for a new user, and publish the schemas with a glossary and field tables. | closed | CR-25 | | | | | Merged into CR-31 on 2026-10-20, at the requester's request; see its NOTES.md. | closed |
| CR-29 | | task | Point every HLD and LLD only to requirements, and every requirement to its change requests. | closed | | | | | | Merged into CR-30 on 2026-10-20; see its `NOTES.md`. | closed |
| CR-30 | | task | Keep every PRD free of code, in the product shape the requester gave, without losing information. | closed | | | | | | Merged into CR-31 on 2026-10-20, at the requester's request; see its NOTES.md. | closed |
| CR-31 | | epic | Build every queued change request as one change, landed as one pull request. | in progress | | | | | | | build |

Status: todo · in progress · in review · blocked · done · dropped. Queue: CR-31, which merged every queued change on 2026-10-20. CR-21 merged the overlapping changes and ideas on 2026-10-19, and its notes list each merge. `docs/FEEDBACK.md` maps every item from the three outside reviews to its owner. Overlaps are resolved in each change's `NOTES.md`. The remaining ideas become changes from the top. Next change request: CR-32.
