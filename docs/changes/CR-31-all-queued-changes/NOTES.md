# CR-31: notes

Captured on 2026-10-20 with `hoop cr create`. The type is epic. The project is hoop.

## What the request means

The requester merged every queued change into this one. It is built in one go, on one branch, and
lands as one pull request. The merged changes keep their requests and notes in their own folders,
and each one says it was merged here.

| Change | Area | What it brings |
|---|---|---|
| CR-30 | Document rules | PRDs hold no code, and HLDs and LLDs point only to requirements. |
| CR-20 | Repository setup | Self-contained tests, commit hooks, linting, CI and open source files. |
| CR-23 | Agent tools | The core review tools by default, and devloop's tools per project. |
| CR-24 | Agent tools | One clear way to submit, and results that state their outcome. |
| CR-26 | Agent tools | Waiting for feedback through MCP alone. |
| CR-27 | Checks | A skipped check reads as a warning, and allowing it takes one step. |
| CR-25 | Comments and edits | Quoted anchors, stated edit rules, and deleting or editing in place. |
| CR-12 | Document structure | Nested sections, stable section comments, tables and diagrams. |
| CR-14 | Trust | Agents only comment or approve as agents, with a GitHub sign-in for the final approval. |
| CR-11 | Tracker | Item descriptions and definitions of done on the tracker page. |
| CR-16 | Changes | A change request page, with each change's checks recorded. |
| CR-7 | Changes | A kind and a project on every change, with filters and moves. |
| CR-28 | README | A README for new users, with schemas, a glossary and a stability policy. |

## The requester's decisions (2026-10-20)

- All thirteen queued changes are merged into this one.
- It lands as one pull request. This sets aside intake's limit of five pull requests for one
  change, at the requester's explicit choice. The requester saw the cost: a very large review.
- The requester approves the PRD, the HLD and the LLD once each on the page. Agent reviewers
  review each first. After that the build runs to the end without stopping.
- The markdown submit tool becomes `hoop_submit`. The decision tool becomes `hoop_submit_decision`.
  The old names keep working for one release.
- The final approval uses GitHub's device sign-in.
- Commit hooks are plain git hooks kept in the repository, and Biome lints and formats.
- Mermaid diagrams render from a copy that hoop serves itself.

## Carried over

- CR-30's PRD was approved at revision 3. This change adopts its requirements unchanged.
- CR-30's HLD revision 1 was approved, and revision 2 holds the fixes from its review. This
  change's HLD starts from revision 2.

## Capture check

The verdict is new. Every overlap between the merged changes is now inside one change, so their
order becomes the build order in the plan. No other change is queued.

## For the fold

- The LLD keeps the sign-in ID in the page's own storage and sends it in a header, not a cookie.
  Browsers share cookies across ports on one host. The fold updates the HLD's sign-in service row,
  which names a cookie.
