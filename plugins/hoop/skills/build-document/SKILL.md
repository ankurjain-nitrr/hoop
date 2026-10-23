---
name: build-document
description: Builds a document with the person one section at a time in hoop, instead of writing it all at once. Use when the person asks to build, draft or write a document together, such as "help me build a document", "let's kick-start a doc on X" or "build it with me".
---

# Build a document together

Agree what the document is for and its outline in a hoop review, then build it with the person on
hoop's build page. Give the person each link, and don't write the whole document up front.

1. **Start.** With `hoop_submit`, submit a working title, a one-paragraph purpose, and three `## Question:` sections:
   who it's for, what it should help them decide or do, and how long it should be. Give each two to
   four options and mark one `(recommended)`.
   Wait with `hoop_wait`.
2. **Outline.** After the answers, revise with the headings, each with one line on what it will
   cover, and ask the person to adjust it. Revise until they approve it.
3. **Build.** Start a build with `hoop_build` from the approved outline. The person edits blocks
   and presses Generate on a section. Loop on `hoop_build_wait`; write each requested section with
   `hoop_build_write`, from the outline, their answers, their note and the sections around it. Write
   several sections at once only when they ask.
4. **Finish.** When they press Finish, `hoop_build_wait` says `finished`: the build is a review now.
   Wait on it with `hoop_wait` and answer the feedback as for any review.
5. **Diagrams.** When a flow, architecture, sequence, state machine, data model or timeline is
   easier to see than to read, add a small, labeled ```` ```mermaid ```` block; the prose stays the
   source of truth.

Only the person approves, on the review page.
