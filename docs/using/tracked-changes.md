# Tracked changes

Claude can answer a comment with exact edits to the text instead of a whole new revision. Each one
shows on its line as a tracked change, for you to accept or reject.

## What you see

**Claude's edit** sits beside the line it changes, for the comment it answers. The text it would
remove is struck through, and the text it would insert shows in blue. The card says how many words
it removes and adds, and marks a change to more than half the line as **Large rewrite**.

## Accept or reject

- **Accept** puts the change into the text at once, as a new revision. Nothing outside it changes:
  the rest of the line and the rest of the document stay byte for byte as they were.
- **Reject** drops it. Claude can propose it again.
- **Accept all for this comment** accepts every edit Claude made for one comment at once.
- From the keyboard, a and x accept or reject the change on the line you're on.

Neither asks first. An accepted change is put back by another suggestion or edit. Once the review
is approved or closed, Accept and Reject go away; **Request changes** reopens it.

## When an edit can't be accepted

An edit applies only while its line still reads exactly as it did when Claude proposed it. If the
line changed since, the card says **Text changed; can only be rejected**.

In a document, an edit changes words, not structure: it keeps the line's heading, list, quote, table
and code markers, and it can't empty a line. hoop refuses such an edit when Claude proposes it, so
it never reaches you.

## What Claude reads

Accepting and rejecting take effect at once; they don't wait for your review. Claude reads a
conversation whose edit you accepted as applied, so it needs no reply.

See also [Suggestions and Apply](suggestions.md), for changes you write yourself.
