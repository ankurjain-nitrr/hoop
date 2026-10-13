# CR-9: intake notes

Captured 2026-10-13, during CR-3's build. State: queued. Proposed type: epic (an app shell and a
design system, applied to every page). Proposed kind: non-functional (usability; no new
capabilities). Project: hoop.

## Survey (screenshots of the review list, a document review and the tracker page)

| # | Where | What looks unfinished |
|---|---|---|
| U-1 | All pages | No app shell. Each page has its own header (review list: a bare "Reviews" heading; review: title plus a small "All reviews" link; tracker: a third layout). No product name, no persistent navigation. |
| U-2 | Review list | "Tracker" is a full-width card that looks like a review. Rows show the raw channel ("local"), a monospace "rev 1 · open" pill, and a timestamp with seconds. No grouping, counts or filters by status. |
| U-3 | Review page | Markdown isn't rendered inside lines: `- Goal:` list markers and backticks show as typed. This does the most to make it look like a hack. |
| U-4 | Review page | The `+` button pushes heading text aside ("S-1 [+] Problem") instead of sitting in the gutter. |
| U-5 | Review page | Internal section IDs (S-0, S-1) lead every heading and outline entry. For documents they mean nothing to the reader. |
| U-6 | Review page | An automatic TL;DR repeats the first paragraph (here the Status line), so the same text shows twice. |
| U-7 | All pages | Symbols are ad hoc text characters (+, ▾, ▸, −) with no consistent icon set. Status words differ by page: open, commented, awaiting review, in review, todo. |
| U-8 | All pages | Mixed type: monospace for pills and labels, sans for content, with no clear scale. Content widths differ by page. |
| U-9 | Finish button | It shows a "0" badge when nothing is pending. |

The direction to propose in the PRD:
- One app shell: product name, navigation between Reviews and Tracker, and the repository.
- One set of status tokens (label, color, icon), shared by reviews, changes and work items.
- An inline SVG icon set; no icon font or external host is needed.
- Inline markdown in lines: lists, code, emphasis and links.
- Item IDs hidden for documents.
- A consistent type scale and content width, with both light and dark themes kept.

## Overlap

- CR-6 (queued): "tables must be rendered appropriately", templates and mermaid. Rendering
  overlaps. Resolution: CR-9 owns the shell, the design tokens, icons and inline markdown in
  lines. CR-6 owns tables, templates and diagrams, built with CR-9's components. CR-9 runs
  before CR-6.
- CR-7 (queued): project filters and "PRs need human input" in the review list. Resolution: CR-7
  adds them to CR-9's redesigned list, so it runs after CR-9.
- CR-8 (queued): R-5 refactors `web/review.js` helpers. Resolution: CR-8 first (small), then CR-9
  restyles on the cleaner code.
- CR-3 (in build): T-4's tracker page (PR #31) gets restyled by CR-9 later; CR-3's scope doesn't
  change.

Queue order: CR-8, CR-9, CR-6, CR-5, CR-7, CR-4 (all after CR-3).
