# CR-13: Collapsed conversations and hidden comments

Status: folded · Revision: 3 · Owner: Ankur Jain · Type: story · Request: `REQUEST.md`

## Problem

A reviewer who opens a document after agent reviews sees every resolved conversation in full.
devloop resolves each agent thread before the requester reviews, so these threads are settled and
only crowd the document. A reviewer who wants to read the document itself can't hide the
comments either. CR-9 already added the menu and the home page from the same request, as CR-18's
queue notes recorded when the requester reordered the queue.

## Goals and non-goals

- Goal: a resolved conversation takes one line until the reviewer opens it.
- Goal: a reviewer can hide every comment on the page, and show them again, with one control.
- Non-goal: deleting, resolving or changing any stored comment. Both are display choices only.
- Non-goal: GitHub's own pages. A GitHub review shown on hoop's page collapses and hides the same
  way, because it is the same page.

## Success metrics

| Metric | Baseline | Target | How measured |
|---|---|---|---|
| Lines a resolved conversation takes on the page. | All of its comments | One line | A browser test counts them. |
| Steps to read a document without any comments. | Not possible | One click | A browser test hides them. |
| Minutes from submission to the requester's first verdict. | Not measured yet. | Lower over the next three changes. | CR-14's audit trail tells agent and requester reviews apart, so this is measured once it lands. |

## Users and scenarios

- **Reviewer:** They open a PRD after two agent review cycles. Each resolved thread shows as one
  line, so they read the document and open only the threads they care about.
- **Reviewer:** They want to read the document as written, so they hide all comments. Later they
  show them again to finish the review.

## Requirements

These apply to every review page, including tracker reviews and GitHub reviews shown on hoop's
page. The `/tracker` page shows no comments, so nothing changes there.

- FR-1: A resolved conversation shall show collapsed, as a summary row with no comment text. The
  row names its place, says it is resolved and counts its comments. Its line keeps its highlight.
  Acceptance: Given a resolved thread, when the reviewer opens the page, then none of its comment
  text shows.
- FR-2: The reviewer shall open a collapsed conversation, and close it again. It stays as the
  reviewer left it while the page is open, and every resolved thread starts collapsed on a reload.
  Acceptance: Given a collapsed thread, when the reviewer opens it and adds a comment elsewhere,
  then it stays open.
- FR-3: An open conversation shall show in full, as today. One that the reviewer resolves during the
  review collapses at once, and unresolving it shows it in full again.
  Acceptance: Given an open thread, when the reviewer resolves it, then it collapses.
- FR-4: A control at the top of the page shall hide or show every conversation and pending comment.
  It also hides tracked change cards, highlights, and Claude's struck and inserted text. The
  control counts the conversations and pending comments it hides.
  Acceptance: Given a page with three conversations, when the reviewer hides them, then none show,
  and the control says 3. When the reviewer shows them again, then each one is back.
- FR-5: Hiding shall last only while the page is open, so every visit starts with comments shown.
  Opening the comment box, or the "Finish your review" panel, shows every comment again.
  Acceptance: Given hidden comments, when the reviewer opens "Finish your review", then every
  comment shows. When the page reloads, then the comments show.
- NFR-1: The controls work from the keyboard, and say whether they are open. Project NFR-11's page
  checks still pass.

## What changes for existing users

- Project FR-6 shows threads on the lines they belong to. Resolved threads now start collapsed.
- Project FR-4a keeps commented text highlighted. While comments are hidden, highlights hide too,
  and they come back when comments show.
- Nothing stored changes, and the agent tools and commands don't change.

## Out of scope

- The menu and the home page, which CR-9 delivered.
- Collapsing open conversations, which stay in full so nothing that needs an answer is missed.

## Assumptions and open questions

- Nothing stores the hidden choice. It lives only in the open page, so a reload shows every comment.
