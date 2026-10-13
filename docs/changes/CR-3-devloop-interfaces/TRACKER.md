# CR-3: tracker

Work items for CR-3, plus the queue behind it. Requirements are in `PRD.md` (Covers).

| ID | Parent | Type | Title | Covers | Status | Phase | Depends on | PR | Size | Start | Done |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CR-3 | | epic | devloop interfaces, sequential reviews and a Jira-like tracker (from B-6, B-7, B-8) | | in progress | build | | | | 2026-10-13 | |
| ST-1 | CR-3 | story | As a requester, my request is kept as written and classified, and corrections teach the classifier | FR-1, FR-2, FR-3 | todo | | | | | | |
| T-1 | ST-1 | task | Change registry: capture, classify, classification record, step history, PR links | FR-1, FR-2, FR-3, FR-6 | in review | | | #27 | 2 files, 266 lines | 2026-10-13 | |
| ST-2 | CR-3 | story | As a requester, I review PRD, HLD and LLD strictly in order, and nothing is built before all three are approved | FR-4, FR-5, FR-7, NFR-1 | todo | | | | | | |
| T-2 | ST-2 | task | Review sequencer: order, staleness, build and fold gates | FR-4, FR-5, FR-7, NFR-1 | in review | | T-1 | #28 | 6 files, ~280 lines | 2026-10-13 | |
| ST-3 | CR-3 | story | As a requester, I see the work as a tree from epic to sub-task, on a page and in reviews | FR-8, FR-9, FR-10, NFR-2 | todo | | | | | | |
| T-3 | ST-3 | task | Tracker service: tree, cell updates, new rows and columns, conflict refusal | FR-8, NFR-2 | in review | | | #29 | 3 files, ~260 lines | 2026-10-13 | |
| T-4 | ST-3 | task | Tracker page and tracker reviews as a tree table | FR-9, FR-10 | in review | | T-3 | #31 | 6 files, ~330 lines | 2026-10-13 | |
| ST-4 | CR-3 | story | As an agent, I can do every hoop step from agent tools or the terminal | FR-11 | todo | | | | | | |
| T-5 | ST-4 | task | Agent tools and terminal commands for changes, tracker, submit, feedback, propose, reply, export | FR-11 | todo | | T-1, T-2, T-3 | | ~5 files, ~450 lines | | |
| ST-5 | CR-3 | story | As a requester, devloop follows the new flow for every change | FR-12 | todo | | | | | | |
| T-6 | ST-5 | task | devloop and project-docs use the change tools; every change gets PRD, HLD and LLD | FR-12 | todo | | T-5 | | ~4 files, ~150 lines | | Skills repository |
| T-7 | CR-3 | task | Acceptance run: one change from capture to fold through the commands | all | todo | | T-1 to T-6 | | ~2 files, ~200 lines | | |
| CR-6 | | epic | Tables rendered in a standard format; default PRD, HLD and LLD templates with mermaid diagrams | | todo | queued | CR-3 | | | 2026-10-13 | |
| CR-5 | | task | Rewrite the project PRD and HLD to the new standard | | todo | queued | CR-3, CR-6 | | | 2026-10-13 | |
| CR-7 | | epic | Functional or non-functional kind and a project on every change; PRs shown as needing human review; project filters; move queued changes between projects | | todo | queued | CR-3, CR-6, CR-5 | | | 2026-10-13 | |
| CR-4 | | story | Queue change requests; resolve and show overlaps among queued ones | | todo | queued | CR-3, CR-6, CR-5, CR-7 | | | 2026-10-13 | |

Order: T-1 → T-2 → T-3 → T-4 → T-5 → T-6 → T-7 as stacked PRs, each within 10 files and 500 lines.
Queue: CR-6, then CR-5, then CR-7, then CR-4 (overlaps resolved in each change's notes; nested expand and
collapse from CR-6 is already CR-3's FR-9 and FR-10).
Definition of done: acceptance criteria met, tests pass, fresh-context reviewed, merged, docs updated.
