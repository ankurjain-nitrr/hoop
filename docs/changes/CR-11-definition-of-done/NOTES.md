# CR-11: intake notes

Captured on 2026-10-13 with `hoop cr create`. The state is queued. The proposed type is story,
because hoop gains one capability: tracker items carry a description block with their own
definition of done, and hoop reads and shows it. The proposed kind is functional, and the project
is hoop.

## What is already done

The rule is now part of devloop 0.13.0. The tracker template has an "Items" section with one block
for each epic, story, task, sub-task and bug. Each block has a heading of the form
`### <ID>: <title>`, a short description, and a definition of done at that item's level. The
project-docs skill requires the blocks, and the vet-docs skill flags missing ones and ones at the
wrong level. So every tracker written from now on has them, starting with CR-8's.

## What is left for hoop

- The tracker service reads each item's block and links it to the item's row.
- The tracker page shows an item's description and definition of done when the item is opened.
- A definition of done written as a checklist shows how many of its points are met.
- The tracker rows that hoop adds for new changes come with a block to fill in.

## Overlap

- CR-6 (queued) adds standard tables and templates. Its tracker template must include the item
  blocks. The resolution is that CR-11 runs before CR-6, so CR-6 builds on the block format.
- CR-9 (queued) redesigns the pages. The resolution is that CR-11 shows the blocks with CR-9's
  components, so it runs after CR-9.
- CR-5 (queued) rewrites the existing documents. The resolution is that CR-5 also adds a block
  with a definition of done to every item in the existing trackers.
- CR-3 (done) built the tracker service and page that CR-11 extends. Nothing in CR-3 reopens.

The queue order is CR-8, CR-9, CR-10, CR-11, CR-6, CR-5, CR-7 and CR-4.
