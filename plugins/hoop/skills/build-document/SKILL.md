---
name: build-document
description: Builds a document with the person one section at a time in hoop, instead of writing it all at once. Use when the person asks to build, draft or write a document together, such as "help me build a document", "let's kick-start a doc on X" or "build it with me".
---

# Build a document together

Build the document with the person on hoop's build page, starting from its title. Ask nothing
first, give the person the link, and don't write the whole document up front.

1. **Start.** Start a build with `hoop_build` from only a working title (a `#` heading), with any
   notes the person already gave as a paragraph under it. The person lays out the document by hand
   with +, or asks you for suggestions.
2. **Suggest.** Loop on `hoop_build_wait`. A request of kind `outline`, `next` or `subsections`
   asks for headings: suggest them with `hoop_build_suggest`, starting at the request's level, each
   with one line on what it covers, from the person's note and the document. They accept, edit or
   dismiss each; only accepted ones join the document.
3. **Write.** A request of kind `write` comes from Generate on a section: write it with
   `hoop_build_write`, from their note and the sections around it. Write several sections at once
   only when they ask.
4. **Write again.** A request of kind `rewrite` (Generate again on one block) or `revise` (the
   person's comment on a block, with the words they selected) names the block: rewrite only that
   block with `hoop_build_write` and `block`, changing what the note or comment asks. When a comment
   asks a question, answer it with `hoop_reply` on the request's thread instead.
5. **Finish.** When they press Finish, `hoop_build_wait` says `finished`: the build is a review now.
   Wait on it with `hoop_wait` and answer the feedback as for any review.
6. **Diagrams.** When a flow, architecture, sequence, state machine, data model or timeline is
   easier to see than to read, add a small, labeled ```` ```mermaid ```` block; the prose stays the
   source of truth.

Only the person approves, on the review page.
