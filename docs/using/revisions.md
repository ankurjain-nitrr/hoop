# Revisions

Claude answers your review with a new revision of the same document. hoop keeps every revision, and
shows you what changed between them.

## A new revision arrives

While the review's page is open, a bar in the header says "Revision 3 is ready". **Show it** moves to
it; nothing on the page changes until you press it, so nothing you're writing moves.

Between revisions, what Claude adds shows on the open page without a reload: its replies, the edits
it proposes and the quick questions it asks beside a line. Screen readers hear "Claude replied on
“Storage” line 1." and the like. The page waits while you're writing, have a panel open or have text
selected, and keeps the line you're reading where it is.

## What changed

Once there is an earlier revision, two tabs sit under the title:

- **Proposal** shows the document as it is now.
- **Changes since rev 2** shows only the sections that changed or went, with the count beside it.
  When you reviewed an earlier revision, it compares with that one: "Changes since your review of
  rev 2".

A comment whose line changed since is marked outdated, and its conversation stays.

## Your drafts carry over

Unsent comments, suggestions and answers move to the new revision with you. One whose line changed
waits in a **Drafts from revision 2** list at the top, quoting the old line, to place again or
discard.

## History

Every review keeps its history: each comment, request for changes and approval, with who and when,
and each review's read receipt.

## How Claude revises

- Claude sends the whole document again, or only the sections it changes. Every other section stays
  byte for byte as it was.
- A revision says which revision its text builds on. hoop refuses one built on an older revision,
  such as after you **Apply** a suggestion, or one sent while a review of yours hasn't reached
  Claude, and tells Claude what to read first.
- An answer to a question stays with the next revision while Claude asks the same question there.

See also [Reviewing a document](reviewing.md).
