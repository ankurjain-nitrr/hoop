# Changelog

All notable changes to hoop are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and hoop uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- When the review page can't draw a Mermaid diagram, it tells hoop, and the next `hoop_feedback`
  or `hoop_wait` result lists it in `diagram_errors` with its section, first line and the library's
  error, so Claude learns a diagram didn't render without asking (#175).
- `hoop_feedback`, `hoop_wait` and `hoop feedback` list every comment thread a reviewer hasn't
  resolved, from any revision, in `threads`: each with its status (`unanswered` until Claude replies
  or proposes an edit after the thread's latest comment, `answered` after), its section, the line's
  text on its revision and now, whether it's outdated, and who said what. Resolved threads are
  named in `resolved`. A revision's submit result lists the threads still unanswered in
  `unanswered_threads`, so a comment left on an earlier revision can't drop out of sight (#156, #157).
- hoop, not the agent, reports what changed in each revision: a revision's submit result lists in
  `changes` the sections added, removed and modified since the revision before, with the lines
  added and removed in each, so a section dropped from a full resend shows. The review page's
  Changes tab compares with the last revision a person reviewed, and lists the sections removed
  since (#161).
- `hoop_revise_sections` (`hoop revise <review_id> <edits.json> --base <n>`) revises a markdown
  review by edits to sections, named by ID, instead of the whole document: `replace_section`,
  `insert_section`, `delete_section` and `replace_text`. All the edits apply or none do, and every
  section they don't touch keeps its exact text and its ID. Submit results and `hoop_export` list
  the sections by ID, heading and level in `sections` (#160).

### Changed

- An approval is of a text with nothing left open: hoop refuses one while any comment thread, from
  any revision, isn't resolved by the reviewer, or while a document still has a Question section.
  The reviewer answers questions with Request changes; Claude writes the decisions in and removes
  the questions, and the reviewer approves that revision. On the page, Approve and **Looks good,
  go** are off and say what's missing, and conversations on sections Claude removed show under
  **On removed sections** with Resolve. Decision documents (`hoop_submit_decision`) follow the same
  rule: Claude revises the answered document into markdown without questions. No approval takes
  the recommended option for an unanswered question any more (#165).
- An approved review stays open to comments, and requesting changes after approval reopens it: it
  shows **Changes requested after approval**, the approval stays on record for the revision it
  approved, Claude's session is told, and Claude's next revision of the same review needs approving
  again. Approve no longer says it freezes the revision (#224).
- CI and the push hook run faster: tests start hoop from the build instead of compiling it on each
  start, the timing tests use short timers (`HOOP_PAGES_CHECK_MS`, `HOOP_PAGES_HANDOVER_MS`, and
  the new `HOOP_PAGES_BIND_TRIES`), each Node version runs the suite once, and CI runs six test
  files at once (#234).
- Two verdicts only: **Request changes** and **Approve**; the review page no longer offers
  **Comment**. Request changes needs a comment, an overall comment or an answer. Approve and
  **Looks good, go** are off while you have new comments, replies or suggestions, and say why:
  "You have 2 new comments: request changes, or delete them to approve." The API refuses the same.
  Reviews stored with the Comment verdict show as they were (#223).
- `hoop_submit` and `hoop_submit_decision` take `base_revision` (`hoop submit --base <n>`), the
  revision a new revision builds on. hoop refuses a revision whose `base_revision` isn't the latest,
  such as one a reviewer's Apply made, and any revision submitted while a review hasn't reached the
  agent; the refusal names the latest revision and carries those reviews in `detail.unread`. A
  comment can no longer drop out of sight under a newer revision, and the plan hook passes such
  feedback on instead of submitting the changed plan (#180, #157).
- Pull request links on Home, in Waiting on you and in the pull request lists, open in a new tab.
- On Work, each todo button sits at the same place in every row: a move off the end of the list
  shows disabled (now **Up** and **Down**), and **Remove** and **Stop** are styled as destructive.
- Home's sections (Waiting on you, Pending, Completed) head the page in larger, full-contrast type
  above the sessions inside them; Completed starts folded with its count showing, and the browser
  remembers when you open it; with nothing pending, Home says "Nothing waiting on you."
- The plugin (1.3.1) runs `@ankurjain-nitrr/hoop@0.1.1`, and the MCP server reports hoop's own version.
- The review page reads more easily: the title, meta line and tabs share one left edge, the status
  shows once at the top right, the latest review's receipt sits on its own line, prose keeps to
  about 80 characters per line, the outline rail is wider and a long entry wraps under its own text,
  the title takes the room the controls leave, and the header controls are one size.

### Added

- The Work view puts what runs first and says what is happening: each running todo and subagent
  shows how long it has run and its last activity, quiet ones show as **Stalled** and todos left in
  progress by an ended or idle session as **Not running**, work waiting in a hoop wait or a question
  as **Waiting on you**, each working session has a **Now:** line
  and a folded **Last 5 minutes** list from its transcript, and the top counts what runs, what
  stalled and the reviews waiting on you.
- Action items: `hoop_action` (`hoop action add`) puts what the person must do, that isn't a review,
  under **Waiting on you** on Home. Each closes only when hoop sees it done (a pull request merged, a
  review approved, an npm version published), or when the person ticks a manual one or says Won't do
  with a reason; hoop then messages the session. `hoop_action_withdraw` withdraws one. Tab counts
  include open items.
- Quick questions: `hoop_ask` (`hoop ask`) asks the person one to four questions with options and
  a recommendation, without a document. The person answers each with one click on its page, and
  the answer reaches Claude at once; `hoop_wait` returns once every question is answered, or each
  answer with `partial`. A change after Claude read an answer is sent as a correction. Claude
  withdraws an ask with `hoop_withdraw`. Open asks show on Home.
- A quick question can point at a line in an open review (`anchor` on `hoop_ask`, `--review` on
  `hoop ask`); it shows as a card beside that line, answered there without reviewing the document.
- A review page shows "Revision N is ready" when Claude submits a new revision, and **Show it**
  moves to it keeping every unsent draft. Drafts survive a reload and a closed tab; a draft whose
  line changed waits in a "Drafts from revision N-1" list to place again or discard.
- Every hoop tab shows how many reviews await the person in its title and as a dot on its icon.
  **Notify me** on Home turns on a browser notification for a new review while the tab is hidden.
- Builds: `hoop_build` (`hoop build`) starts a document the person shapes on the page, adding,
  editing, moving and removing blocks. Each change is a step with a snapshot; the build exports as
  markdown byte for byte. Generate on a section asks Claude to write it (`hoop_build_wait`,
  `hoop_build_write`); its text shows as generated, and Undo puts back what was there. Finish and
  review turns the build into a review of the whole document. The plugin's `build-document` skill
  and the MCP instructions use builds for the section-by-section step.
- A build reads as an outline: a heading holds its section, nested and indented under it, folds
  with it, and moves with it among its sibling sections; Remove on a heading asks whether its
  content goes too. A build starts from just a title, with no questions first; Suggest an outline,
  Suggest next section and Suggest subsections ask Claude for headings (`hoop_build_suggest`),
  which wait as placeholders until the person accepts them.
- One Claude Code plugin, `hoop@hoop`, holds the MCP server, the plan hook and the pull request
  hook. It runs the `hoop` on PATH, or the package through `npx` without one. `hoop init` installs
  it with `claude`, or prints the two commands with `--print`.
- Building a document together: when asked to build a document with the person, Claude asks who
  it's for, proposes an outline, then writes one section per revision. The plugin's
  `build-document` skill holds the same steps. Claude also draws flows and architectures as Mermaid.
- Contributor files, commit hooks, Biome and CI on every pull request.
- Review owners: the Claude Code session that submits a review owns it, and only it revises, replies
  or proposes edits. Other sessions comment with `hoop_comment` (`hoop comment`); a process outside
  a session only reads.
- A per-review lock, so writes from several processes are never lost.
- A read-only Work page beside Home: each Claude Code session's todos and subagents, recorded by
  background plugin hooks (`hoop work-hook`) and refreshed while the page is open.
- Steering from the Work page: comment on, edit, reorder and remove queued todos, and comment on or
  stop running agents. Changes go to the session in one message over its messaging socket, and a
  gate hook (`hoop work-gate`) refuses to start a removed or edited todo and every tool call of a
  stopped agent. The page shows each change's delivery: sent, waiting for the gate, seen or
  overridden.
- `hoop init` asks once to turn on Claude Code's todo tools (`--yes` or `--no` answers), and on yes
  sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` under `env` in Claude Code's settings, keeping a backup.
- A person's review wakes the session that asked for it: the pages send it one message over its
  messaging socket naming the review, unless a wait already has it, and record whether it got
  there. The review page says whether Claude is waiting, idle or ended (with the `claude --resume`
  command to copy), and Home marks reviews Claude hasn't read yet.
- `hoop_wait` waits up to ten minutes per call in Claude Code (45 seconds elsewhere), and its pending
  result and `hoop wait` say what they wait for and where.

### Removed

- The GitHub channel: decision pull requests, merge to approve, close to reject, and GitHub reviews
  shown on the page. The GitHub sign-in stays.
- Writing `decisions/<slug>.json` and `.md` into the repository on approval, and `decision_files`
  in feedback.
- Agent approvals: an approve or a request for changes without a GitHub sign-in is now refused, so
  the `agent_approval`, `changes_requested_by_agent` and `unverified` fields are gone.
- Change requests and trackers: the `hoop cr` and `hoop tracker` commands, their tools, the
  `/changes` and `/tracker` pages, the `devloop` setting and the `--cr` and `--doc` submit options.
- Document checks on submit, `hoop allow-check` and the findings panel.
- The `channel` field of a review document and the `source` field of feedback.
- `hoop audit`, the `~/.hoop/audit.jsonl` log and `HOOP_AUDIT`. The pages process now records its
  starts, restarts and stops in `~/.hoop/pages.jsonl`.
- The devloop plugin, which moved to its own repository. This marketplace now lists only the hoop plugin.
- The old names `hoop_submit_markdown` (use `hoop_submit`) and `hoop submit-json` (use
  `hoop submit-decision`), so agents no longer pick the old tool over the new one.

### Changed

- The `hoop-plan` plugin is now the `hoop` plugin. Run `claude plugin uninstall hoop-plan@hoop`
  before installing it.
- A review's "Audit trail" section is now called "History".

### Fixed

- A new section never takes the ID of a section an earlier revision deleted, so that section's old
  comments don't attach to it.
- On Work, a refresh no longer drops the keyboard focus from a header link or any other control it
  didn't track: focus stays on the control in the same place, so Tab carries on from there (#234).
- The review page said "Claude's session has ended" after `/clear` while Claude Code still ran,
  because `/clear` gives the running process a new session ID. A review and an action item now
  record the owner's Claude Code process (its ID and `procStart`), and hoop follows that process to
  its new session ID: the page shows it idle or busy, a submitted review wakes it (saying an earlier
  conversation in the terminal started it, so it reads the document with `hoop_export` first), and
  the header and Home name it. That session counts as the owner: it reads the feedback (which
  clears "Not read yet"), revises (and owns the review from then on), waits on and withdraws quick
  questions, and withdraws action items. A session file whose process ID was reused by another
  process no longer counts as a running session (#221).
- The review page says at once that a submitted review went to Claude: the status changes and the
  header reads "Sent to Claude at 19:20, not read yet", then "Claude read this at 19:21". Both come
  from the submit's own answer, not the next poll, and "Claude is waiting for your review" no
  longer shows while Claude hasn't read the review you just sent (#222).
- A tracked pull request whose repository or pull request was deleted stayed under Pending as
  "State unknown" forever. When GitHub says it doesn't exist, Home marks it **Gone** under
  Completed; a network error, rate limit or missing sign-in still reads as
  "State unknown" and is asked again. A closed or gone pull request is asked again every half hour,
  or when someone else signs in to `gh`. An open action item waiting for such a pull request (or a
  closed one) to merge says it can't merge now (#183).
- The review page could send an empty Comment. Submit now stays off for a comment or a request for
  changes with nothing in it, and the API refuses one (#181).

### Deprecated

- Passing a decision document to `hoop_submit`. Use `hoop_submit_decision`.
