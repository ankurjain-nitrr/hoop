# hoop: tracker

| ID | Parent | Type | Title | Status | Depends on | PR | Size | Start | Done | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| CR-1 | | change | Initial build (revs 1-8) | done | | #1-#22 | | 2026-10-13 | 2026-10-13 | `docs/changes/CR-1-initial-build/` |
| FR-1 | CR-1 | requirement | Submit over MCP | done | | #2 | | | 2026-10-13 | |
| FR-2 | CR-1 | requirement | Field-level validation errors | done | | #1 | | | 2026-10-13 | |
| FR-3 | CR-1 | requirement | Review page: TL;DR, lines, outline, Viewed | done | FR-1 | #3 | | | 2026-10-13 | |
| FR-4 | CR-1 | requirement | Comments, suggestions, answers, verdicts | done | FR-3 | #4, #5 | | | 2026-10-13 | |
| FR-4a | CR-1 | requirement | Highlights and typed-text anchors | done | FR-4 | #5 | | | 2026-10-13 | Caret browsing needed for keyboard selection |
| FR-5 | CR-1 | requirement | Read feedback over MCP | done | FR-1 | #2 | | | 2026-10-13 | |
| FR-6 | CR-1 | requirement | Revisions and outdated threads | done | FR-4 | #7 | | | 2026-10-13 | |
| FR-7 | CR-1 | requirement | Approval freezes; superseding reviews | done | FR-6 | #7 | | | 2026-10-13 | |
| FR-8 | CR-1 | requirement | `hoop wait` | done | FR-5 | #6, #12 | | | 2026-10-13 | |
| FR-9 | CR-1 | requirement | Decision search tool | dropped | | | | | | Retired in rev 5: grep `decisions/` |
| FR-10 | CR-1 | requirement | Approval writes `decisions/` | done | FR-7 | #7 | | | 2026-10-13 | |
| FR-11 | CR-1 | requirement | Agent replies in threads | done | FR-4 | #4, #9, #11 | | | 2026-10-13 | |
| FR-12 | CR-1 | requirement | Open decision PRs | done | FR-1 | #8 | | | 2026-10-13 | |
| FR-13 | CR-1 | requirement | Sync PR reviews into feedback | done | FR-12 | #9, #12 | | | 2026-10-13 | |
| FR-14 | CR-1 | requirement | GitHub revisions as commits | done | FR-12 | #8 | | | 2026-10-13 | |
| FR-15 | CR-1 | requirement | Merge approves, close rejects | done | FR-13 | #9, #12 | | | 2026-10-13 | |
| FR-16 | CR-1 | requirement | Any markdown document | done | FR-1 | #17, #19 | | | 2026-10-13 | |
| FR-17 | CR-1 | requirement | Byte-identical export | done | FR-16 | #17, #19 | | | 2026-10-13 | Setext headings export as `#` |
| FR-18 | CR-1 | requirement | Apply suggestions in place | done | FR-4 | #14 | | | 2026-10-13 | |
| FR-19 | CR-1 | requirement | Heading, title and TL;DR scopes | done | FR-4 | #13 | | | 2026-10-13 | |
| FR-20 | CR-1 | requirement | `hoop_propose_edits` | done | FR-19 | #15, #18 | | | 2026-10-13 | |
| FR-21 | CR-1 | requirement | Tracked changes, Accept and Reject | done | FR-20 | #16, #18 | | | 2026-10-13 | |
| FR-22 | CR-1 | requirement | Minimal, byte-identical edits | done | FR-18 | #14, #18 | | | 2026-10-13 | |
| FR-23 | CR-1 | requirement | Audit log | done | | #20 | | | 2026-10-13 | |
| FR-24 | CR-1 | requirement | `hoop audit` summary | done | FR-23 | #20 | | | 2026-10-13 | |
| NFR-1 | CR-1 | requirement | Local first; cross-site requests refused | done | | #3, #11 | | | 2026-10-13 | |
| NFR-7 | CR-1 | requirement | Node 18.18+, no native modules | done | | #2 | | | 2026-10-13 | Browser tests need Node 20+ |
| B-1 | | idea | Materialize comments on the GitHub channel | todo | FR-21 | | | | | Out of scope in rev 7; not scoped |
| B-2 | | idea | Trace requirements to code PRs in CI | todo | | | | | | Deferred in rev 4; not scoped |
| B-3 | | idea | GitHub Action for decision PRs | todo | FR-12 | | | | | Deferred in rev 4; not scoped |
| B-4 | | idea | Publish to npm | todo | | | | | | Open question in PRD |
| B-5 | FR-17 | bug | Export assumes one blank line after headings | done | | | | 2026-10-13 | 2026-10-13 | Fixed by CR-2 |
| CR-2 | B-5 | change | Keep blank lines around headings on export | done | | #24 | 4 files | 2026-10-13 | 2026-10-13 | `docs/changes/CR-2-heading-spacing/`; folded |
| B-6 | | idea | Tracker items as epic / story / task / bug, shown as a tree table in hoop | todo | | | | 2026-10-13 | | Requested during CR-2; next CR |
| B-7 | | idea | hoop interfaces for devloop; the tracker records each change's devloop phase | todo | | | | 2026-10-13 | | Requested during CR-2; build first |
| B-8 | | idea | PRD, HLD and LLD all approved before development starts | todo | | | | 2026-10-13 | | Requested during CR-2; changes devloop's tiers |

Status: todo · in progress · in review · blocked · done · dropped. Next change request: CR-2, through devloop.
