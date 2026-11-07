# Suggestions and Apply

A suggestion is a change you write to Claude's text. You can leave it for Claude to take in its next
revision, or **Apply** it yourself.

## Suggest a change

- **To words.** Select words in a line and choose **Suggest a change**. The box reads "Replace the
  selected text with"; leave it empty to delete those words.
- **To a whole line.** **Edit in place** opens the line's text for you to change.
- **Remove a section.** Comment on its heading and press **Remove this heading and everything under
  it**. The section and its subsections show struck through.

A suggestion is part of your review like a comment, and it keeps the verdict at **Request changes**
until it is sent.

## What a suggestion can change

A suggestion changes words within one line. The box says why when it can't take yours:

- **No line breaks.** It can't add or remove lines.
- **No empty line.** It can't remove a whole line, so emptying the box deletes selected words but
  not a line's only words. To drop a whole section, use **Remove this heading and everything under
  it**.
- **The same markdown structure.** In a document it keeps the line's list, quote, table and code
  markers. Change only the words.
- **Not an automatic TL;DR.** One that repeats the first paragraph takes its change on that
  paragraph instead.

## Apply

Once your review is sent, a suggestion's conversation offers **Apply suggestion**, which puts it
into the document yourself, without waiting for Claude. It makes a new revision that changes only
the suggested span: every other byte stays as it was. A removed section goes the same way: **Apply**
removes it and everything under it.

Apply suggestion shows only while the line still reads as it did when you suggested the change, and
not once the review is approved or closed. Applying doesn't ask first, and the conversation shows
"Applied in rev N". Another suggestion, or an edit from Claude, puts an applied change back.

Because it makes a revision, Claude's next revision has to build on it: hoop refuses a revision
built on an older one, and tells Claude which is latest.

See also [Tracked changes](tracked-changes.md) for the edits Claude proposes, and
[Revisions](revisions.md).
