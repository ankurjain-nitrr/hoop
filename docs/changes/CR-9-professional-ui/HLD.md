# CR-9: HLD

Status: folded · Revision: 3 · PRD: approved (revision 2)

This document covers components and how they interact. The code-level design goes in the LLD,
which is written after this is approved.

## Context

The reviewer uses hoop's pages in a browser on their own machine. The pages talk only to the
local hoop server, which serves them and their data. The agent, the stored files and GitHub don't
change. The change is in the pages: they share one frame and one visual language, and they show
each line of a document as formatted text.

```
reviewer ── browser ──▶ page frame ──┬──▶ review list
                                     ├──▶ review page ──▶ line renderer ◀── comment tools
                                     └──▶ tracker page ──▶ line renderer
              status set ◀── every page
page frame and pages ── local API ──▶ hoop server
```

## Components

All of these components live inside the project's existing Web component, in the browser pages and
the local API.

| Component | Responsibility | Talks to (how) |
|---|---|---|
| Page frame (new) | It shows the product name, the links to the reviews and the tracker, and the repository on every page. | It wraps each page, in the browser. |
| Status set (new) | It gives each review status, tracker item status and change step one label, one color and one icon. | Every page uses it, in the browser. |
| Line renderer (new) | It formats the inside of a line, and shows each line as the kind the server gives it. It keeps a map from what is shown to the source text. | The review page, the tracker page and the comment tools call it, in the browser. |
| Comment tools (changed) | They turn a selection or typed words into a comment on the source text, widened to whole formatted runs. They show highlights and tracked changes, and keep the comment button in the gutter. | They use the line renderer's map, in the browser. |
| Server parts (changed) | One function splits a document into its lines and their kinds, and the edit engine uses it too. The review rules give each review its status key. | The local API sends both to the pages. |
| Review list (changed) | It groups the reviews by status with counts, and shows each one's channel and a readable date. | It reads the local API over HTTP. |
| Review page (changed) | It shows a document or a structured review for comments and a verdict. It hides section IDs for documents, names sections by title in comment labels, and hides a zero badge. | It reads and writes through the local API over HTTP. |
| Tracker page (changed) | It shows the tracker as a tree inside the shared frame, with the shared statuses, icons and line renderer. The renderer formats item text only; description blocks and other tables stay as written. | It reads the local API over HTTP. |
| Page checks (new) | They check the frame, the themes, keyboard use and accessibility on every page. | They drive the pages in a headless browser. |

## Key interactions

### A reviewer reads a line

1. The review page asks the line renderer to show a source line.
2. The line renderer formats it and records which source text each shown character came from.
3. The comment tools add highlights and tracked changes at their source positions, through the map.

Failure: a line the renderer can't format is shown as plain text, so nothing is lost.

### A reviewer comments on selected text

1. The reviewer selects words in a formatted line, or types them in "Only about this text".
2. The comment tools ask the line renderer's map for the source positions. A start or end inside
   a formatted run widens to the whole run, so the quote keeps its markers balanced.
3. The comment is stored with the source text and its positions, in the same format as before.

Failure: a selection that covers no source text, such as only a list bullet, offers no comment
button.

### A reviewer reads a document with an automatic TL;DR

1. The review page shows the first paragraph once and doesn't show a separate TL;DR box.
2. Earlier comments on the TL;DR still cover the whole document and show under the title.

### A reviewer moves between pages

1. The page frame shows the same header on each page, with the current page marked.
2. Each page shows statuses through the status set.

## Cross-cutting concerns

- Security and trust boundaries: the formatted text is built only from escaped text and a fixed
  set of tags. Links open only http and https addresses, so a document can't run code in the page.
- Privacy: the pages fetch nothing from the internet. Icons are drawn in the page, and fonts come
  from the system.
- Observability: the audit log is unchanged.
- Testing strategy: the existing browser tests must pass. They change only where a shown text
  changes on purpose, such as a status label, and each such change is listed in its pull request.
  New browser tests check the frame, the formatted lines, and selections and typed words inside
  formatted text. They also check both themes, a phone width, keyboard use and accessibility.
  One test renders every page with requests to other hosts blocked.
- Deployment and operation: nothing to install. The pages stay plain files with no build step.
- Interfaces: the local API gains `GET /api/info`, which returns the served repository's identity.
  Each review in `GET /api/reviews` gains its status key and its repository's identity. An identity
  is a display name and an opaque key, so the pages compare keys and never read file paths. A
  review's view gains each line's kind and indent. Nothing else in the API changes, and the agent
  tools and stored files don't change.
- Line kinds describe single lines only. Structures that span lines, such as tracker tables now and
  other tables and diagrams in CR-6, stay groupings at the item level. A kind the pages don't know
  shows as written, so later changes can add kinds without breaking older pages.

## Alternatives considered

- A markdown library: it would add a dependency and couldn't keep the map to source positions
  that comments need.
- A CSS framework or a component library: it would add a build step and outside code for a
  three-page app.
- Show raw markdown, as today: it fails the request and makes documents harder to read.

## Decisions

- D-1 (2026-10-13): The pages format the inside of each line themselves and keep a map to source
  positions. Context: comments anchor to source text. Consequences: comments keep working on
  formatted text.
- D-5 (2026-10-13): The server decides each line's kind once, in the function that splits the
  document into lines. The edit engine's structure check uses it too. Context: four rule
  sets would otherwise judge what a line is, and could disagree. Consequences: the pages trust the
  kind, and a change to how lines are split changes their kinds with them.
- D-6 (2026-10-13): The server gives each review a status key and a repository identity. Context:
  CR-7 needs to filter by project, and a terminal command may need the same status. Consequences:
  the status rule lives in the review rules, and the pages keep only each status's label, color and
  icon.
- D-2 (2026-10-13): Icons are drawn as inline SVG and fonts come from the system. Context: hoop
  runs locally and must not fetch from the internet. Consequences: no new files to host.
- D-3 (2026-10-13): Every status is named in one place. Context: three words are used today for
  one status. Consequences: a new status gets its label, color and icon at once.
- D-4 (2026-10-13): An automatic TL;DR shows once, as the first paragraph. Context: it repeats that
  paragraph. Consequences: this changes project FR-3 and the project HLD's "TL;DR first" guard for
  documents without their own TL;DR. A document with its own TL;DR still shows it first. Project
  FR-19 and D-9 still hold: a title comment covers the document, and earlier TL;DR comments show
  under the title.

## Requirements traceability

| Requirement | Components |
|---|---|
| FR-1 | Page frame, all pages |
| FR-2 | Status set, all pages |
| FR-3 | Review list, page frame |
| FR-4 | Line renderer, all pages |
| FR-5, FR-5a | Line renderer, comment tools |
| FR-6, FR-7, FR-8, FR-9 | Review page |
| NFR-1, NFR-2, NFR-3 | Page frame, page checks |

## Risks

- A selection maps to the wrong source text. Browser tests select words inside code, bold text and
  links, and compare the stored quote with the source.
- The new look hides a control that tests rely on. The existing browser tests keep their checks on
  every control, and change only where a shown text changes on purpose.
