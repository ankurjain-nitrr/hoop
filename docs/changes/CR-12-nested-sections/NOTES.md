# CR-12: intake notes

Captured on 2026-10-13 with `hoop cr create`. The state is queued. The proposed type is story,
because a reviewed document gains one capability: its sections show nested up to five levels
deep. The proposed kind is functional, and the project is hoop.

## What the request means today

The hoop server already reads every heading level in a markdown document and stores it with each section.
The review page ignores the level, so every section shows at the same depth, and the outline is a
flat list. The proposed reading of the request is this. A document's title is its first heading,
and below it up to five levels of sections nest inside each other. In markdown terms, that is
headings two to six under a heading one. Scoping confirms this reading before the PRD is written.

## What it likely includes

- The outline shows sections as a tree that can be expanded and collapsed.
- The document shows each section inside its parent, indented by depth.
- A comment on a heading still covers its section, and now also every section nested inside it.
- A structured review with no headings works as today.

## Overlap

- CR-9 (in progress) redesigns the review page and its outline. It is not reopened. The resolution
  is that CR-12 builds on CR-9's frame and line renderer, so it runs after CR-9.
- CR-6 (queued) adds PRD, HLD and LLD templates. Templates can use nested sections once CR-12
  exists. The resolution is that CR-12 runs before CR-6.
- CR-11 (queued) adds description blocks to tracker items under item headings. Those blocks are
  sections too. The resolution is that CR-12 runs after CR-11, so the item blocks nest under the
  tracker's "Items" heading.

The queue order is CR-10, CR-11, CR-12, CR-6, CR-5, CR-7 and CR-4, after CR-9.

## Reordered on 2026-10-14 (CR-18)

It runs after CR-14. Its scope is unchanged.

## Merged on 2026-10-19 (CR-21)

CR-12 absorbs CR-6 and B-14. It covers how the review page reads and renders a document's structure. Its stories are nested sections and comments that stay on a renamed or repeated heading. Tables in one standard format and Mermaid diagrams are the last two stories. B-14's fix lands first, because nesting changes how sections are matched.
