---
name: build-document
description: Builds a document with the person one section at a time in hoop, instead of writing it all at once. Use when the person asks to build, draft or write a document together, such as "help me build a document", "let's kick-start a doc on X" or "build it with me".
---

# Build a document together

Build it in one hoop review, one revision per step. Submit with `hoop_submit`, give the person the
link, and wait with `hoop_wait` after each revision. Don't write the whole document up front.

1. **Start.** Submit a working title, a one-paragraph purpose, and three `## Question:` sections:
   who it's for, what it should help them decide or do, and how long it should be. Give each two to
   four options and mark one `(recommended)`.
2. **Outline.** After the answers, revise with the headings, each with one line on what it will
   cover, and ask the person to adjust it. Revise until they're happy.
3. **Sections.** Write one section per revision, then wait for their review. Move to the next only
   when they say so. If they ask for several sections at once, write those.
4. **Diagrams.** When a flow, architecture, sequence, state machine, data model or timeline is
   easier to see than to read, add a small, labeled ```` ```mermaid ```` block; the prose stays the
   source of truth.

Only the person approves, on the review page.
