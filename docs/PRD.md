# hoop: PRD

Status: approved · Revision: 1 · Owner: Ankur Jain · Describes `main` at v0.2.0 (bootstrapped from CR-1)

## Goal

People need to review what an agent writes: decisions, requirements, plans, or any document.
Code review has a good interface; everything else is reviewed as text in a terminal, all or
nothing, with no record. hoop gives these documents a code-review experience: the agent submits a
structured document over MCP, people comment on lines or selected text, suggest changes and answer
questions, and the agent reads the review back as data. Comments can be materialized as edits that
change as few words as possible. Work continues only when the document is approved.

## Users

- **Driver:** the person working with the agent; reviews most documents on the local page.
- **Reviewer:** a teammate asked to weigh in, on the local page or on a GitHub PR.
- **Agent:** Claude, or any MCP client, that submits documents, reads feedback and proposes edits.

## Requirements

Submit and read back
- FR-1: When an agent calls `hoop_submit` with a valid `hoop/review@0` document, hoop shall store it
  and return a review ID and URL; with `review_id` it shall add a revision. Check: `test/mcp.test.ts`.
- FR-2: An invalid document shall be rejected with field-level errors. Check: `test/contract.test.ts`.
- FR-5: `hoop_feedback` shall return `pending` or the feedback on the latest revision, with what was
  applied and the status of proposed edits. Check: `test/mcp.test.ts`, `test/revisions.test.ts`.
- FR-8: `hoop wait <review_id>` shall exit when a review arrives on the latest revision (or the review
  is approved or closed) and print the feedback; it retries transient errors. Check: `test/wait.test.ts`.
- FR-11: `hoop_reply` shall add the agent's reply to a thread, on the page or on GitHub. Check:
  `test/web.test.ts`, `test/github.test.ts`.

Review on the local page
- FR-3: The page shall show the TL;DR, then numbered lines grouped into items, an outline, and a
  Viewed toggle per item. Check: `test/web.test.ts`, `test/ui.test.ts`.
- FR-4: A reviewer shall comment on a whole line or selected text, attach suggested text, answer
  questions, keep comments pending, and finish with Comment, Approve or Request changes. Check:
  `test/ui.test.ts`.
- FR-4a: Commented text stays highlighted; typed text ("Only about this text") anchors a comment
  without a mouse. Check: `test/ui.test.ts`.
- FR-6: A new revision shall offer "Changes since rev N", keep earlier threads, mark threads on
  changed lines outdated, and let reviewers resolve them. Check: `test/revisions.test.ts`, `test/ui.test.ts`.
- FR-7: Approval shall freeze the revision; a later submit starts a review that supersedes it.
  Check: `test/revisions.test.ts`.
- FR-10: Approving a local review shall write `decisions/<slug>.json` and `.md` to the repository it
  came from. Check: `test/revisions.test.ts`.
- FR-19: A comment on a heading (line 0) covers its section; on the title or TL;DR (item `DOC`
  lines 1 and 2), the whole document. Check: `test/contract.test.ts`, `test/ui.test.ts`.

Team review on GitHub
- FR-12: With `channel: "github"`, submitting shall open a PR with `decisions/<slug>.json`, the
  rendered `.md`, and a description with the TL;DR and question checkboxes. Check: `test/github.test.ts`.
- FR-13: `hoop_feedback` shall read the PR's reviews into the same feedback document: line comments
  mapped to item and line, suggestions, replies, ticked answers, resolved threads; comments off item
  lines go into the summary. Check: `test/github.test.ts`.
- FR-14: A revision of a GitHub review shall be a new commit on the same PR, keeping ticked answers.
  Check: `test/github.test.ts`.
- FR-15: Merging the PR approves; closing it unmerged rejects (`closed: true`). Check: `test/github.test.ts`.

Any document, and comments that become edits
- FR-16: `hoop_submit_markdown` shall turn any markdown into a review: sections by heading, a line per
  block. Check: `test/markdown.test.ts`.
- FR-17: `hoop_export` and approval of a document shall give its markdown back, byte for byte where
  unedited. Check: `test/markdown.test.ts`.
- FR-18: A reviewer shall Apply an exact suggestion: only that span changes, in a new revision, and
  the thread is marked applied. Check: `test/revisions.test.ts`, `test/ui.test.ts`.
- FR-20: `hoop_propose_edits` shall take span edits for a thread; each `find` occurs once in its
  line, inside the thread's scope, on a comment whose text hasn't changed; otherwise the call is
  rejected with field errors. Check: `test/propose.test.ts`.
- FR-21: Proposed edits show inline as tracked changes with Accept and Reject; accepting applies
  only that span, and only while the line reads exactly as when proposed. Check: `test/propose.test.ts`,
  `test/ui.test.ts`.
- FR-22: Text outside an applied span stays byte-identical; in documents an edit can't change
  markdown structure or empty a line; edits over half a line are flagged as large rewrites. Check:
  `test/edit.test.ts`.

Improvement loop
- FR-23: Every action and every failed tool call or reviewer action shall be appended to
  `~/.hoop/audit.jsonl`; `HOOP_AUDIT=0` turns it off. Check: `test/audit.test.ts`.
- FR-24: `hoop audit` shall summarize time to verdict, revisions, edit acceptance, large rewrites and
  the top failures. Check: `test/audit.test.ts`.

Non-functional
- NFR-1: Local first: one command serves MCP and the page on 127.0.0.1; nothing leaves the machine
  except on the GitHub channel. The API refuses foreign Host, foreign Origin and non-JSON writes.
- NFR-2: Reviewer comments are untrusted input to the agent, returned as data.
- NFR-3: A 50-item review renders in under a second. (Not measured yet.)
- NFR-4: The contract is versioned (`hoop/review@0`, `hoop/feedback@0`).
- NFR-5: The GitHub channel uses `gh`'s login; hoop stores no tokens.
- NFR-6: Rendering and export are deterministic.
- NFR-7: Runs on Node 18.18+ with no native dependencies.

## Out of scope

- Code review of diffs (GitHub and code-review tools cover it).
- Materializing comments on the GitHub channel (GitHub's Commit suggestion covers it).
- Accounts, hosting, notifications beyond GitHub's own; a decision-search tool (FR-9, retired:
  grep `decisions/`).

## Assumptions and open questions

- hoop is installed from source; publishing to npm is open.
