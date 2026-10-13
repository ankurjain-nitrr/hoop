# CR-2: Keep blank lines around headings on export

Status: implementing · Revision: 2 · Owner: Ankur Jain · Tier: small fix (one slice)

## Goal

FR-17 promises that an unedited document exports byte for byte. Today export always writes exactly
one blank line before and after every heading, so a document with a heading directly followed by
text, or with two blank lines around a heading, comes back changed. Found while bootstrapping
hoop's own LLD (tracker B-5).

## Requirements

- FR-1: When a document has any number of blank lines (including none) after a heading, or before
  a heading, export shall reproduce exactly that number. Check: round-trip tests on documents with
  0, 1, 2 and 10 blank lines around headings, including the LLD's original formatting.
- FR-2: Documents stored before this change shall export exactly as they do today. Check: a stored
  document without the new marker exports with one blank line around headings.

## Design

The parser keeps blank lines at the start and end of each section's body (today it drops them) and
marks the document `spacing: "exact"`. Export writes a section's heading and then its body lines
verbatim when the marker is set, and keeps today's one-blank-line layout when it isn't. The marker
is an optional field written and read only by hoop's markdown pipeline; agents don't set it.
Blank body lines are not commentable lines, so anchors and line numbers don't change.

## Out of scope

- Blank lines between the title and the first heading when there is no introduction text: they
  keep the one-blank-line layout.
- Setext headings (still exported in `#` form), trailing spaces on heading lines, and closing `#`
  sequences.
