# Building a document together

Ask Claude to "help me build a document" (or "let's kick-start a doc on X"). It starts a build from
just a working title, with no questions first, and gives you the link. You shape the document on the
page and ask Claude for text section by section.

## Lay it out

- **+** between blocks adds a title, a subtitle, a Heading 1, a Heading 2, a paragraph, a list, a
  table, a code block or a diagram.
- Each block shows formatted. **Edit** opens it (or **Edit all**), with buttons for bold, italic,
  links, lists, tables and code; typed markdown works too. **Preview** saves it and shows it
  formatted again, and **Preview all** does so for every open block.
- A heading holds everything up to the next heading at its level or above, indented and folding
  with it. Moving a heading moves everything under it, and removing one asks whether everything
  under it goes too. **Undo** brings a removed block back.

## Ask Claude

- **For headings.** **Suggest an outline** on the title, **Suggest subheadings** on a heading and
  **Suggest the next heading** on the last one. Suggested headings wait as dashed placeholders to
  accept, edit or dismiss; only accepted ones join the document.
- **For text.** **Generate** on a heading, with an optional note, asks Claude to write everything
  under it. **Continue writing** asks for more after what is there, and **Generate all** on the
  title fills every empty heading.
- **For a rewrite.** **Generate again** on a block Claude wrote, with an optional note, or
  **Shorter**, **Longer**, **Simpler** and **More detail** in one press.
- **With a comment.** Select words in a block and press **Comment** ("is this monthly?"). Claude
  rewrites the block or answers in the comment's conversation, which stays until you **Resolve** it.

While a request waits, its button is pending, so it can't be sent twice. The line under the heading
says how long it has waited and whether Claude's session is checking the build, and **Withdraw**
takes it back. A request wakes Claude's session when it isn't waiting on the build.

## Keep or drop Claude's text

Claude's text arrives as a draft beside its heading, and nothing in the document changes until you
**Save** it. **Discard** leaves the heading as it was. Saved text shows as generated until you edit
it.

**Versions** on a heading lists its last 20 versions, yours and Claude's saved ones. Step through
them with the arrow keys to see what changed, and **Save this version** puts one back.

When Claude writes something that contradicts other text it wrote, it adds a note naming both
places. **Resolve** removes the note for good; Claude raises it again if it still applies.

## Give Claude context

**Context for Claude**, at the top, lists the documents Claude writes from: links it can open, or
full paths of files on your machine. An optional **brief** says who the document is for, its tone
and its length. Every request carries both. When Claude can't open a document, its reason shows
beside it.

## Finish

**Finish and review** turns the build into an ordinary [review](reviewing.md) of the whole document.
While a draft of Claude's is unsaved, it asks first, and **Finish without drafts** goes on without
it.
