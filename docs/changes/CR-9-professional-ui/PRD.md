# CR-9: A consistent, professional interface

Status: approved · Revision: 2 · Owner: Ankur Jain · Type: epic · Request: `REQUEST.md`

## Problem

The hoop pages look like a prototype, so reviewers trust them less and read them more slowly. Each
page has its own header, and no page has a product name or navigation. The review list shows a
link to the tracker as if it were a review. Markdown inside a line is shown as typed, so list
markers and backticks appear in the text a reviewer reads. The comment button pushes heading text
aside. Section IDs such as S-0 lead every heading, although they mean nothing to the reader.

Symbols are plain text characters, and the same status has different words on different pages.
Type sizes and fonts change from page to page with no clear scale. The review page shows a "0"
badge when nothing is pending. The intake notes for this change list each problem as U-1 to U-9.

## Goals and non-goals

- Goal: every page shares one frame, one set of status labels and one set of icons.
- Goal: a reviewer reads a document as it would look when published, not as raw markdown.
- Goal: reviewing works exactly as before, including comments on selected text.
- Non-goal: new review features. Tables, templates and diagrams belong to CR-6.
- Non-goal: project filters and the "needs human review" list. They belong to CR-7.
- Non-goal: a mobile app. The pages must still work at phone width.

## Success metrics

| Metric | Baseline | Target | How measured |
|---|---|---|---|
| Pages that use the shared frame. | 0 of 3 | 3 of 3 | Browser test |
| Words used for one review status across pages. An open review is "open", "awaiting review" or "commented" today. | 3 | 1 | Code search |
| Lines that show raw markdown markers to the reader. | Most list items and code lines show them. | 0 | A browser test checks a sample document. |
| Comments on selected text that anchor to the right source text. | All | All | Existing browser tests |
| Accessibility problems found by an automated check. | Not measured | 0 serious | An axe check runs in the browser tests. |

## Users and scenarios

- **Reviewer:** They open hoop and see the product name, where they are, and how to reach the
  reviews and the tracker. They read a document with its lists, code and emphasis rendered. They
  select a few words and comment on them, as before.
- **Agent:** It works with hoop exactly as before. Nothing in the tools, commands or stored files
  changes.

## Requirements

- FR-1: Every page shall show the same frame: the product name, links to the reviews and the
  tracker, and the repository in use.
  Acceptance: Given the review list, a review and the tracker, then each shows the same frame.
- FR-2: Each status shall have one label, one color and one icon, used on every page. This covers
  review statuses, tracker item statuses and change steps.
  Acceptance: Given reviews that are awaiting review, commented, changes requested, approved and
  closed, then each page shows each status with the same label and icon. Given tracker items that
  are todo, in progress, in review, blocked, done and dropped, then the tracker shows each with its
  own label and icon.
- FR-3: The review list shall list only reviews, grouped by status with a count for each group.
  Each review shows its channel by name and a readable date. The tracker is reached from the frame.
  Acceptance: Given reviews in two statuses, then the list shows two groups with their counts. No
  row links to the tracker, the channel reads "Local" or "GitHub", and dates show without seconds.
- FR-4: Lines shall show markdown as formatted text. This covers code, bold, italic, links and list
  markers inside a line, and quotes, code blocks and breaks as whole lines.
  Acceptance: Given lines with backticks, a list marker, bold text, a quote, a code block and a
  break, then the reader sees them formatted. No markdown characters show.
- FR-5: A comment on selected text shall anchor to the source text, even where the line is
  formatted. A selection that starts or ends inside formatted text covers the whole formatted run.
  Acceptance: Given a selection inside bold text, when a comment is added, then its quote is the
  whole bold run. The quote is source text, with its markers.
- FR-5a: Typing the words in "Only about this text" shall find them in the shown text, even across
  formatting. The comment then anchors to the matching source text.
  Acceptance: Given a line "the `foo` value", when the reviewer types "the foo value", then the
  comment's quote is the whole source text.
- FR-6: The comment button shall sit in the gutter and shall not move the text it belongs to.
  Acceptance: Given a heading, when the reader points at it, then the heading text doesn't move.
- FR-7: Section IDs shall be hidden for documents and kept for structured reviews. Comment labels
  name a document's section by its title.
  Acceptance: Given a markdown document, then its headings and comment labels show no IDs. Given
  a requirements review, then its items keep their IDs.
- FR-8: An automatic TL;DR that repeats the first paragraph shall be shown once, as the first
  paragraph. This changes project FR-3, which shows the TL;DR first. Comments on the TL;DR (project
  FR-19) still cover the whole document and show under the title.
  Acceptance: Given a document whose TL;DR came from its first paragraph, then the text appears
  once. Given an earlier comment on that TL;DR, then it shows under the title.
- FR-9: A count badge shall appear only when the count is above zero.
  Acceptance: Given no pending comments, then the finish button shows no badge.
- NFR-1: The pages shall keep one type scale, one content width and the light and dark themes.
  They shall also work at a phone width of 400 pixels.
  Acceptance: a browser test checks the frame, fonts and widths in both themes and at 400 pixels.
- NFR-2: The pages shall have no serious accessibility problems, and every control shall work
  from the keyboard.
  Acceptance: an automated accessibility check reports no serious problems on the three pages.
- NFR-3: The pages shall load no code or fonts from the internet.
  Acceptance: a browser test with network access blocked renders every page fully.

## Out of scope

- Changes to the agent tools, the commands, the stored files or the review contract.
- Tables other than trackers, templates and diagrams, which CR-6 covers. Their rows stay as written
  until CR-6.
- The tracker's description blocks, which CR-11 covers.

## Assumptions and open questions

- The icons are drawn as inline SVG in the page, so nothing is fetched from the internet.
- The pages keep using the system's fonts, so no font files are added.
- Headings already render, because they become section titles. Other block markdown shows as
  written today, so FR-4 covers it.
- Superseded reviews and GitHub reviews keep their status from the set: a GitHub review shows its
  status and the GitHub icon.
