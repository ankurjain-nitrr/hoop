# CR-13: LLD

Status: folded · Revision: 3 · PRD: approved (revision 3) · HLD: approved (revision 3)

This document says how each HLD component is built. Code-level detail is limited to new files,
design patterns and the public interfaces between layers. Logic inside a file is left to code review.

## View state (page)

- No new files. The page's shared `state` in `web/app.js` gains `openThreads`, the set of resolved
  conversations the reviewer opened, and `commentsHidden`, the hidden mode.
- Pattern: the same in-memory view state the page already uses for tabs and raw tables. Nothing
  writes it to the draft or to local storage, so a reload clears it.

## Conversations (page)

- `web/review.js` renders a resolved conversation as a `details` element whose `summary` names the
  place, says it is resolved and counts the comments. It is open when `state.openThreads` holds it.
  A `toggle` listener keeps `state.openThreads` in step, so later renders keep the reviewer's choice.
- A local conversation counts as resolved only when no entry is newer than its resolution. A later
  reply shows it in full, with its Resolve button, so the reviewer can resolve it again.
- Resolving a conversation during the review collapses it. Unresolving it shows it in full.
- Tracker table rows show their threads through the same renderer, so they get the same rows. A
  row with comments stays pinned through collapses and filters, as today, whether its comments
  are collapsed or hidden.
- A GitHub review's thread is resolved when GitHub's latest review on the latest revision reports
  it, as the feedback sync does today. After a newer revision with no review, its threads show in
  full. That limit stays as it is, and the LLD names it.

## Hidden mode and the hide control (page)

- Pattern: one page-level mode. The control sets `state.commentsHidden` and a `comments-hidden`
  class on the page root, and every render applies the class from the state. So a Viewed toggle
  or a tab switch keeps the mode. The control itself renders nothing, so focus and the reader's
  place stay.
- The marker has two values. `data-comment="hide"` marks what the mode hides: conversations,
  pending comments, tracked change cards and Claude's inserted text. `data-comment="plain"` marks
  what keeps the document's own words: highlights and Claude's struck text lose only their styling.
  The line renderer adds the marker to its marks and edits.
- The control is a button with `aria-pressed` among the page's top actions. Its label counts the
  conversations and pending comments it hides.
- Opening the comment box or the finish panel clears `state.commentsHidden` first. The render that
  follows then applies no class, so comments show at verdict time.

## Public interfaces between layers

- None change. The server, the local API, the agent tools and the stored files stay as they are.
- Inside the pages, `data-comment` is the marker contract. An element that only shows a comment
  carries `hide`. One that wraps the document's own words carries `plain`. Any later renderer
  follows the same rule.

## Test plan

| Requirement | What the test proves | Level |
|---|---|---|
| FR-1 | A resolved thread shows as a summary row with no comment text, at 400 pixels too, in a document and under a tracker row. | browser |
| FR-2 | An opened thread stays open after another action, and closes again. A reload collapses it. | browser |
| FR-3 | Resolving collapses a thread, unresolving shows it, and a later reply reopens it so it can be resolved again. | browser |
| FR-4 | The mode hides every comment element, keeps each line's text whole, keeps focus, survives a Viewed toggle, and counts right. | browser |
| FR-5 | The comment box and the finish panel end the mode, and it stays ended after the render that follows. A reload starts with comments shown. | browser |
| NFR-1 | The page checks pass with collapsed rows and with comments hidden. | browser |
| Risk | With the mode on, no element with comment text is left visible. | browser |

## Pull requests

1. One pull request: `web/app.js`, `web/review.js`, `web/select.js`, `web/inline.js`,
   `web/app.css`, `test/ui.test.ts`, `test/pages.test.ts`, and the tracker.
