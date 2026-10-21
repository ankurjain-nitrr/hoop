# CR-31 PRD: Every queued change, built as one

Status: proposed · Revision: 3 · Owner: Ankur Jain · Type: epic · Request: `REQUEST.md`, and the request of each change in the notes

## 1. Overview and objectives

### Problem

Today hoop is sold as a review tool for any document, but its surface is shaped by devloop. An
agent that reviews an essay still loads seven change request and tracker tools. Its submit tool and
its submit command have names that point at different formats. It can't wait for feedback without
a shell. It learns the edit rules only when a call fails. A skipped check looks like a clean
success.

People who review can't trust or follow everything they see. Any local request can approve under
any name, and an agent can approve like a person. Nested sections show flat, and tables and
diagrams show as source. A section's comments fall off when its heading changes. The tracker hides
each item's definition of done, change requests crowd the tracker, and no page lists them.

People who want to build hoop meet personal paths, no commit hooks, no CI and no contributor
guides. A new user meets a README that starts with the contract instead of installing. And every
PRD names code, as CR-30 found. A usability review and the requester's own requests raised each of
these, in the thirteen changes this one merges.

### Success criteria

| Metric | Baseline | Target | How measured |
|---|---|---|---|
| Tools an agent sees in a project without devloop. | 13 | 8, with one old name marked. | The tool list of a fresh session. |
| Share of proposed edits that hoop refuses. | Today's audit report | Half of today's | The audit report over the first week. |
| Ways an agent without a shell can wait for a review. | 0 | 1 | A session with no shell tool. |
| Skipped checks shown as a warning. | 0 | Every one | The submit result and the review page. |
| Approvals marked verified that lack a GitHub sign-in. | Any local request | 0 | The audit trail of each approved review. |
| Section comments lost when a heading is renamed. | All of them | 0 | A revision that renames a commented heading. |
| Changes listed on a page with their documents. | 0 | Every change in the repository. | The change request page. |
| Tracker items without a definition of done. | Counted by the new flag. | 0 | The tracker page's flag. |
| Steps from a fresh clone to passing tests on another machine. | Fails on personal paths | Install, then test | A clean checkout in CI. |
| Code findings in the project PRD. | 126 code spans | 0 | The writing checker. |

### Target personas

- **Author agent:** Claude or any MCP client that submits a document, waits, reads feedback and
  proposes edits.
- **Reviewer:** A person who comments on a document, on the page or on GitHub.
- **Requester:** The person who asks for a change and gives the final approval.
- **Contributor:** Someone who clones hoop to change it.
- **devloop agents:** The owner and reviewer agents that write and review change documents.

### Quality bars

- NFR-17: Every capability a user has today stays, unless the list of changes below names it.
  Acceptance: every current acceptance run passes, with renamed tools called by their old names.
  Changes: CR-23, CR-31.
- NFR-18: Every new page and state meets NFR-11. Acceptance: the page checks pass for the change
  request page, the sign-in states and the audit trail. Changes: CR-31.
- NFR-19: A page with no diagram loads no more than 50 milliseconds slower than today. Acceptance:
  the page load time of a review without diagrams, before and after. Changes: CR-12, CR-31.
- NFR-20: A diagram can never run script, load anything or change the page outside its own box.
  Acceptance: a review with a hostile diagram shows no script effect and makes no request.
  Changes: CR-12, CR-31.
- NFR-21: The checks on every pull request finish in under ten minutes. The commit check finishes
  in under twenty seconds on a typical change. Acceptance: the times of the CI run and the commit
  hook on this change. Changes: CR-20, CR-31.

### Changes to current behavior

The requester approves each of these explicitly.

- FR-1 and FR-16: The tool `hoop_submit` takes markdown, and `hoop_submit_decision` takes a decision
  document. For the next two minor versions, the old names still work, as FR-62 says.
- FR-31 and NFR-10: The commands become `hoop submit` and `hoop submit-decision`. The recorded
  interface changes with them.
- FR-31: In a project without devloop, an agent doesn't see the change request and tracker tools,
  or the change argument on submit. A project that already holds change requests keeps them.
  Every terminal command stays.
- FR-4 and FR-7: A verdict without a GitHub sign-in is an agent's. An approve becomes an agent
  approval that doesn't freeze the review. A request for changes becomes a comment.
- NFR-1 and NFR-5: The final approval of a local review needs the person's GitHub sign-in, so
  approving now talks to GitHub. hoop still stores no token.
- FR-3: The outline becomes a tree of nested sections.
- FR-19 and FR-20: A comment on a heading also covers its nested sections, and so does an edit's
  scope.
- The settled rule that a section keeps its ID only while its heading matches changes. A renamed
  heading keeps its section, under FR-78's rule.
- FR-35: A markdown table on a review page shows as a table. Each row is still a line to comment
  on.
- FR-25 and FR-30: Change requests leave the tracker, and live on the change request page.
- NFR-4: Feedback gains each comment's scope, a submit's outcome, approval notes and the signed-in
  login. These are added fields, so the format keeps its version.
- The README is reordered for a new user.
- The project's own PRD, HLD and LLD are rewritten to CR-30's rules, as CR-30's approved PRD says.

## 2. User interactions and flows

### An agent submits, waits and reads feedback

The agent submits a document, waits for a review through MCP, reads the feedback, and revises.

- FR-58: In a project without devloop, an agent shall see eight tools. They are `hoop_submit`,
  `hoop_submit_decision`, `hoop_feedback`, `hoop_wait`, `hoop_propose_edits`, `hoop_reply`,
  `hoop_export`, and the old name `hoop_submit_markdown`, marked as old. Acceptance: a fresh
  session in such a project lists exactly these. Changes: CR-23, CR-24, CR-26, CR-31.
- FR-59: When a project turns devloop on in its `hoop.config.json`, an agent shall also see more.
  It sees the change request and tracker tools, and the change argument on submit. devloop's setup
  turns it on. Acceptance: the same session lists fifteen tools after the setting. Changes: CR-23,
  CR-31.
- FR-141: A project that already holds change requests shall keep devloop's tools without the
  setting. Acceptance: hoop's own repository, with no new setting, lists all fifteen tools.
  Changes: CR-23, CR-31.
- FR-60: Every terminal command shall keep working whatever the setting. The help lists devloop's
  commands in their own group. Acceptance: `hoop help` shows two groups, and each devloop command
  runs in a project without the setting. Changes: CR-23, CR-31.
- FR-61: `hoop_submit` and `hoop submit` shall take markdown. `hoop_submit_decision` and
  `hoop submit-decision` take a decision document. The README says when to use each. Acceptance:
  the README's guide names each, and each pair accepts its format. Changes: CR-24, CR-31.
- FR-62: For the next two minor versions, `hoop_submit` shall still accept a decision document, and
  the old tool and command names still work. Each old use says the new name, and the changelog
  says when the old names go. Acceptance: an old call succeeds, and its result names the new tool.
  Changes: CR-24, CR-31.
- FR-63: Each submit result shall state one outcome: created, revised or superseded. It names the
  review to use next. Acceptance: a submit against an approved review says superseded and names
  the new review. Changes: CR-24, CR-31.
- FR-64: Reading feedback for a superseded review shall point to the review that replaced it.
  Acceptance: the feedback of the old review names the new one. Changes: CR-24, CR-31.
- FR-65: After an approval, the files it wrote shall show on the review page and in the command's
  output. Acceptance: an approved review's page lists the decision files. Changes: CR-24, CR-31.
- FR-66: `hoop_wait` shall hold until a review arrives on the latest revision, or the review is
  approved or closed. It holds at most 45 seconds, then says to call again. Acceptance: an agent
  with no shell gets a reviewer's comments through `hoop_wait` alone. Changes: CR-26, CR-31.
- FR-67: `hoop wait` in the background shall keep working as today. Acceptance: the existing wait
  behavior passes unchanged. Changes: CR-26, CR-31.

### A project checks its documents on submit

- FR-68: When a declared check didn't run, the submit result shall lead with a warning that says
  why and how to allow it. Acceptance: a submit with a check that isn't allowed starts its result
  with that warning. Changes: CR-27, CR-31.
- FR-69: The review page shall show a skipped check as a warning, and say which command to run to
  allow it. It shows no folder path. Acceptance: the page names the command and no path. Changes:
  CR-27, CR-31.
- FR-70: `hoop allow-check` shall show the exact command a repository declares and ask the person
  to confirm. Then it adds the allow entry to the person's own settings. Acceptance: after the
  person confirms, the next submit runs the check. Changes: CR-27, CR-31.

### A reviewer comments and an agent edits

- FR-71: A comment, a reply or a proposed edit shall be able to name the exact words it covers in
  place of a line number. The words match the line's text as feedback shows it. An item may narrow
  the search. Acceptance: an agent comments by quote alone, and the comment sits on the right line.
  Changes: CR-25, CR-31.
- FR-72: Feedback shall state each comment's edit scope: the line, the section or the whole
  document. Acceptance: each comment in the feedback names its scope. Changes: CR-25, CR-31.
- FR-73: The proposed edits tool shall state every edit rule in its description. Each refusal names
  the rule it broke. Acceptance: a refused edit names its rule, and the description lists all
  rules. Changes: CR-25, CR-31.
- FR-74: A reviewer shall delete selected text within a line in one action, as a suggestion.
  Acceptance: the delete shows as a suggestion that Apply removes. Changes: CR-25, CR-31.
- FR-75: A reviewer shall edit a line in place, as a suggestion. Acceptance: the edited line shows
  as a suggestion with Apply. Changes: CR-25, CR-31.

### A reviewer reads a structured document

- FR-76: A document's sections shall nest up to five levels under its title. The outline is a tree
  that expands and collapses, and each section sits inside its parent. Acceptance: a document with
  six heading levels shows five nested levels under the title. Changes: CR-12, CR-31.
- FR-77: A comment on a heading shall cover its section and every section nested in it.
  Acceptance: the comment's scope lists the nested sections. Changes: CR-12, CR-31.
- FR-78: A section shall keep its comments when its heading is renamed in a new revision. It keeps
  them when it stays at the same level, under the same parent, in the same place among its
  siblings. Two sections with the same heading keep their own comments. Acceptance: after a rename,
  the comments still show on that section. Changes: CR-12, CR-31.
- FR-142: Reviews stored before this change shall keep every comment on its section. Acceptance: a
  review stored by today's hoop opens with all its comments in place. Changes: CR-12, CR-31.
- FR-79: A markdown table on a review page shall show as a table, with its header row and its
  columns aligned. Each row stays one line to comment on. Acceptance: a review of a table shows a
  header row, and a comment on a row stays on that row. Changes: CR-6, CR-12, CR-31.
- FR-80: A Mermaid diagram shall show as a drawn diagram on every page, without reaching another
  host. A reviewer comments on it like a line. Acceptance: a review with a diagram draws it with
  other hosts blocked. Changes: CR-6, CR-12, CR-31.

### Agents comment, and the requester approves

- FR-81: A verdict without a GitHub sign-in shall count as an agent's. An approve becomes an agent
  approval, and a request for changes becomes a comment. The result says so. Acceptance: an approve
  sent without a sign-in leaves the review open. Changes: CR-14, CR-31.
- FR-82: An agent approval shall be recorded on the review and never freeze it. Acceptance: after an
  agent approval, the review still takes comments. Changes: CR-14, CR-31.
- FR-83: The final approval of a local review shall need the person's GitHub sign-in in the
  browser. The page shows a code, the person confirms it on GitHub, and the approval records their
  login. Acceptance: an approval after the sign-in shows the login. Changes: CR-14, CR-31.
- FR-143: A sign-in shall last eight hours, in that browser only. Each final approval is still a
  click on that review's page. Acceptance: a request from outside that browser can't use the
  sign-in. Changes: CR-14, CR-31.
- FR-84: A person shall be able to turn the sign-in off in their own settings, but no repository
  can. Every approval made without a sign-in is marked unverified on the page, in the audit trail
  and in the decision record. Acceptance: with the setting off, an approval works and shows as
  unverified. Changes: CR-14, CR-31.
- FR-144: A person shall be able to set their own GitHub OAuth App in their own settings, in place
  of hoop's. Acceptance: a sign-in with a person's own app records the login. Changes: CR-14,
  CR-31.
- FR-85: An approval shall be able to carry notes. The decision record and the feedback keep them.
  Acceptance: a note written with an approval shows in the decision record. Changes: CR-14, CR-31.
- FR-86: Each review page shall show its audit trail. It lists every comment, agent approval and
  final approval, with who and when. Acceptance: the trail of an approved review lists each event.
  Changes: CR-14, CR-31.
- FR-87: When an agent in Claude Code leaves plan mode, a hook shall open its plan for review in
  hoop. The agent goes on only after the final approval, and gets the feedback otherwise. The person
  turns the hook on. Acceptance: with the hook on, a plan waits for approval in hoop. Changes:
  CR-14, CR-31.
- FR-145: When the plan hook's wait ends before a verdict, the agent shall stop. It is told the
  review's link and to wait for the person. Acceptance: a plan with no verdict stops the agent with
  that message. Changes: CR-14, CR-31.

### A team tracks work and changes

- FR-88: The tracker page shall show an item's description and definition of done when the item is
  opened. A checklist shows how many of its points are met. Acceptance: an opened item shows its
  block and its count. Changes: CR-11, CR-31.
- FR-89: The tracker page shall flag each item that has no description or no definition of done.
  Acceptance: an item without a block is flagged. Changes: CR-11, CR-31.
- FR-90: Each tracker item that hoop adds shall come with a block to fill in. Acceptance: a new row
  has a matching block. Changes: CR-11, CR-31.
- FR-91: The project's own tracker shall follow the tracker standard, with a block for every item.
  Acceptance: the tracker page flags nothing on hoop's tracker. Changes: CR-5, CR-11, CR-31.
- FR-92: A change request page shall list every change, grouped as queued, in progress, done and
  closed. Each change links to its request, its documents, its reviews and its pull requests.
  Acceptance: every change in the repository shows with its links. Changes: CR-16, CR-31.
- FR-93: Change requests shall leave the tracker. A tracker's root work item points to its change.
  Acceptance: the tracker holds no change request rows, and each root item links its change.
  Changes: CR-16, CR-31.
- FR-94: Each change's capture and pick-up checks, and each merge, split or drop, shall be recorded
  as a revision of its request. The change request page shows them. Acceptance: a merged change
  shows the revision that records the merge. Changes: CR-15, CR-16, CR-31.
- FR-95: A change shall be flagged, with a proposal to split it, when its tracker's estimates
  total more than 50 files or 2,500 changed lines. That is five pull requests at devloop's limit. The requester can keep it whole, and the flag records that choice.
  Acceptance: this change shows the flag and the requester's choice. Changes: CR-16, CR-31.
- FR-96: Every change and every tracker item shall have a project, and every change a kind,
  functional or non-functional. Existing ones get theirs. Acceptance: every change and item shows
  its project. Changes: CR-7, CR-31.
- FR-97: The review list, the change request page and the tracker page shall filter by project.
  Acceptance: a filter shows only that project's reviews, changes and items. Changes: CR-7, CR-17,
  CR-31.
- FR-98: A person shall move a queued change to another project. A change in progress can't move,
  and the refusal says why. Acceptance: a moved change shows under its new project. Changes: CR-7,
  CR-17, CR-31.

### Authors write change documents

- FR-99: Every rule of CR-30's approved PRD, revision 3, shall hold, under its own IDs, with the
  decisions of CR-30's approved HLD. When this change folds, those requirements take FR-99 to
  FR-117 and NFR-22 to NFR-24, in order. Acceptance: each of them passes its own acceptance.
  Changes: CR-29, CR-30, CR-31.

### A contributor builds hoop

- FR-118: The project's tests and scripts shall depend on nothing outside the repository or one
  person's machine. A run that needs GitHub takes its repository from a setting, and says so when
  it is missing. Acceptance: a clean clone on another machine installs and passes its tests.
  Changes: CR-19, CR-20, CR-31.
- FR-119: Installing in a contributor's clone shall set up commit hooks kept in the repository.
  Before a commit they run the type check, the linter, the formatter and the writing check on
  changed documents. Installing hoop as a tool sets up nothing. Acceptance: a commit with a type
  error is refused. Changes: CR-20, CR-31.
- FR-120: The commit check shall refuse a code comment that names a change request or a tracker
  item. Acceptance: such a comment is refused, and the whole code base passes. Changes: CR-20,
  CR-31.
- FR-121: Before a push, the hooks shall run the tests. Acceptance: a push with a failing test is
  refused. Changes: CR-20, CR-31.
- FR-122: Every pull request shall run the type check, the linter and the tests on each supported
  Node version, and the browser tests. Acceptance: a pull request shows each check. Changes: CR-20,
  CR-31.
- FR-123: The repository shall hold a contributing guide, a code of conduct, a security policy and
  a changelog. It also holds issue and pull request templates, editor settings, code owners and
  dependency updates. Acceptance: each one is in the repository, and the guide says how to build.
  Changes: CR-20, CR-31.
- FR-124: A devloop skill shall check a repository for these practices, and keep them in every
  change it drives. Acceptance: the skill reports each missing practice in a repository without
  them. Changes: CR-20, CR-31.

### A new user reads the README

- FR-125: The README shall start with what hoop is, then install and removal, then a short
  walkthrough from the reviewer's side. The reference comes last. Acceptance: a reader installs and
  reviews a document before reaching the reference. Changes: CR-28, CR-31.
- FR-126: The README shall have a glossary of hoop's terms. Acceptance: it defines materialize,
  TL;DR, check, risk, depends on, item types and supersedes. Changes: CR-28, CR-31.
- FR-127: The product shall publish its review and feedback formats as JSON Schema files. The
  README's field tables come from the same source. Acceptance: a change to a field changes both.
  Changes: CR-28, CR-31.
- FR-128: The README shall show what differs on the GitHub channel, and where the channel is set.
  Acceptance: a table lists each difference. Changes: CR-28, CR-31.
- FR-129: The README shall name every side effect, every devloop step, change type and tracker
  column, and what two sessions or two repositories do. Acceptance: each is in the README.
  Changes: CR-28, CR-31.
- FR-130: The README's tool table and its command examples shall match one to one. Acceptance:
  every tool has its command beside it. Changes: CR-28, CR-31.
- FR-131: The README shall say which surfaces may still break, and how a breaking change is
  announced in the changelog. It also covers setup for agents other than Claude Code. Acceptance:
  the README has a stability section and a setup for one other agent. Changes: CR-28, CR-31.

## 3. UI states and transitions

- FR-132: The change request page shall show an empty state that says how to capture a change, when
  a repository has none. Acceptance: a repository with no changes shows that state. Changes: CR-16,
  CR-31.
- FR-133: The sign-in shall show each of its states: the code to enter, waiting, signed in,
  expired, denied and offline. Each state says what to do next. Acceptance: each state shows its
  next step. Changes: CR-14, CR-31.
- FR-134: A diagram shall show a placeholder while it draws. Acceptance: a slow diagram shows the
  placeholder first. Changes: CR-12, CR-31.
- FR-135: An item opened on the tracker page shall show "No definition of done yet" when its block
  is missing. Acceptance: such an item shows that text. Changes: CR-11, CR-31.

## 4. Edge cases and error handling

- FR-136: When quoted words occur nowhere or more than once, hoop shall refuse the comment or edit.
  The refusal shows each place the words occur. Acceptance: an ambiguous quote is refused with its
  places. Changes: CR-25, CR-31.
- FR-137: When the sign-in expires, is denied or can't reach GitHub, the approval shall not happen.
  The review stays open, and the page says why. Acceptance: an expired code leaves the review open.
  Changes: CR-14, CR-31.
- FR-138: When a diagram can't be drawn, its page shall show its source and the reason. Acceptance:
  a broken diagram shows its source and an error. Changes: CR-12, CR-31.
- FR-139: When `hoop_wait` ends without a review, its result shall say so and say to call it again.
  Acceptance: a wait with no review returns that message within 45 seconds. Changes: CR-26, CR-31.
- FR-140: When a person declines `hoop allow-check`, nothing changes. Without a terminal, it refuses
  and says to run it in one. Acceptance: an agent's call without a terminal is refused. Changes:
  CR-27, CR-31.

## 5. Out of scope

- Deleting a whole line in one action. An edit can't empty a line or change a document's structure,
  which is a settled rule.
- Pull requests that need a human review on GitHub. The requester dropped it earlier.
- Publishing hoop to npm, which is idea B-16 and not queued.
- A sign-in for reviews on the GitHub channel, where merging already needs GitHub.
- The improvements from the comparison with Plannotator that aren't queued.
- Building the states that CR-30's comparison finds. Each becomes its own change request.

### Assumptions and open questions

- The project registers its own GitHub OAuth App, and the maintainer creates it once. Its client
  ID ships with hoop, and the device sign-in needs no secret.
- 45 seconds is the longest a wait holds, because MCP clients time out a call after 60 seconds.
- The plan review hook ships with hoop, and a person turns it on.
- The thirteen merged changes land as one pull request, at the requester's choice.
