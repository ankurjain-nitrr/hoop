# Reviewing a document

Claude sends a document to hoop and gives you its link. You review it on the page, the way you
review code, and Claude reads your review as data. Only you review it, and only you approve it.

## Comment

- **On a line.** Each paragraph, list item, table row, quote or code block is one line. Press **+**
  beside it, or select words in it to comment on just those.
- **On a section.** A comment on a heading covers everything under it.
- **On the whole document.** A comment on the title or the TL;DR covers all of it.
- **Reply** in a conversation from an earlier review, and **Resolve** it once it's settled.

What you write is kept in this browser until you send it, through a reload or a closed tab, with a
quiet "Draft saved" beside the box.

## Answer questions

Claude asks a question in a section headed `Question: …`, with lettered options and one marked
recommended. Pick an option, or pick **Other** and answer in a comment. You can request changes
with a question unanswered, since your feedback may make it obsolete. To settle one, answer it and
**Request changes**: Claude writes your decision in and removes the question, and you approve that
revision.

## Send your review

The page shows the one verdict that applies now, never both:

- **Request changes** while you have new comments, replies, suggestions or answers, while a
  conversation from any revision isn't resolved, or while a question is still in the document.
- **Approve** when none of that is left.

A short reason sits beside it ("2 new comments"), and the button changes in place as you work. Its
panel takes an overall comment, or notes for an approval. Claude has no tool to approve and is told
never to.

After you approve, the review still takes comments. **Request changes** reopens it: it shows
**Changes requested after approval**, the approval stays in the history, and Claude's next revision
needs approving again.

## Know that it arrived

- **Receipts.** "Sent to Claude 21:03" as soon as you send, then "Read by Claude 21:04", beside the
  latest review and under each one in the history.
- **Claude's state** shows under the title: waiting for your review, idle (sending wakes it), or
  ended, with the `claude --resume` command to copy. Sending gives the session one message naming
  the review, so Claude reads it even after it stopped waiting.

## Close a review you don't need

**Close**, on the page or beside its row on Home, asks for an optional one-line reason and confirms
in place. The review shows as **Closed (not approved)** under Completed, Claude's session is told to
stop work on it, and it can't be revised. **Request changes** with a comment reopens it.

## Keyboard

**?** opens **Keys on this page**, which lists the keys, with a **Keyboard shortcuts** switch that
turns them off; **?** works while they are off. j and k move between lines, n and p between open conversations, c comments, s suggests a
change, a and x accept or reject Claude's change on the line, 1 to 4 pick a question's option, g
picks the recommended one, and v marks a section viewed. Keys do nothing while you type, and no
key approves or requests changes.

## Plans and files

- **Plans.** Before Claude Code leaves plan mode, the plugin opens the plan as a review, and Claude
  goes on only after you approve it. If hoop gives no decision, Claude stops.
- **Any markdown file.** `hoop open <file.md>` opens a file for review without Claude, from any
  terminal. The review is yours ("Opened by you"), and hoop writes nothing into the file: your
  answers to its questions are kept with the review, and once each has one you can approve. Edit
  the file and run it again for a new revision. Claude sessions can read it, comment and reply in
  its conversations, but only you change it.
- **A decision document** Claude sends as a structured document works the same way: answer its
  questions with **Request changes**, and Claude revises it into a document that states your
  decisions, for you to approve.

See also [Suggestions and Apply](suggestions.md), [Tracked changes](tracked-changes.md) and
[Revisions](revisions.md).
