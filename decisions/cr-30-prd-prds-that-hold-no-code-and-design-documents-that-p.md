# CR-30 PRD: PRDs that hold no code, and design documents that point only to requirements

Status: proposed · Revision: 3 · Owner: Ankur Jain · Type: task · Request: `REQUEST.md`, and CR-29's `REQUEST.md`

## 1. Overview and objectives

### Problem

People who approve a change read its PRD to decide what gets built. Today hoop's PRD reads like a
code index. It names a test file 88 times and holds 126 code spans, such as files, fields and
routes. A requester has to read past the code to find the behavior, and the PRD can't be read by
someone who doesn't know the code. Nothing stops this, because the PRD template has no such rule
and no check finds code in a PRD. So every new PRD repeats it.

The design documents have the opposite problem. Outside their status lines, the HLD names change
requests 43 times and the LLD 13 times. A design that points to a change request instead of a
requirement can't show which requirement it serves. And a requirement doesn't say which change
requests shaped it, so its history is lost.

### Success criteria

| Metric | Baseline | Target | How measured |
|---|---|---|---|
| Test file names in the project PRD. | 88 | 0 | The writing checker reports none. |
| Code findings in the project PRD. | Not measured | 0 | The writing checker's PRD rule reports none. |
| Change request names in the project HLD and LLD, outside status lines. | 43 and 13 | 0 | The writing checker reports none. |
| Requirements in the project PRD that end with their change requests. | 0 of 73 | Every one | The writing checker reports each one that doesn't. |
| Requirements and sections of today's PRD with no new place. | Not measured | 0 | A script reads the map in the change's notes. |
| Code findings on the first check of the next three new PRDs. | Not measured | 0 | The check result hoop shows on each first submit. |

### Target personas

- **Requester:** The person who asks for a change and approves its documents. They read the PRD to
  decide what gets built.
- **Author:** The product manager agent that writes a PRD, and the engineer agents that write the
  HLD and the LLD.
- **Reviewer:** The persona agents that comment on each document before the requester sees it.
- **Another project's maintainer:** Someone whose project already uses devloop, with documents
  written under today's rules.

### Quality bars

- NFR-1: No fact in today's project PRD, HLD or LLD is lost. Each requirement, section and history
  phrase of the PRD lands in a named new place. So does each change request name in the HLD and
  LLD. The change's notes map each of these to its new place. Acceptance: a script checks every
  entry in that map, and finds each current requirement ID in the new PRD or the retired list. It
  also finds each test a requirement names today in that requirement's row of the LLD's test plan. Changes: CR-29, CR-30.
- NFR-2: The new checker rules report nothing on the rewritten project documents and the
  templates. In a sample document, they flag each kind FR-10 lists, and each change request name
  in an HLD or an LLD. Acceptance: the checker reports zero findings on the first, and one finding
  for each planted case in the second. Changes: CR-30.
- NFR-3: An author sees the check result on submit with no wait they notice. Acceptance: hoop's
  recorded check time for the project PRD stays under one second. Changes: CR-30.

### Changes to current behavior

The requester approves each of these explicitly.

- The PRD template's "Goals and non-goals" becomes the objectives in section 1 and the out of
  scope list in section 5.
- The template's "Users and scenarios" becomes the target personas in section 1 and the flows in
  section 2.
- The success metrics table stays, inside section 1.
- The PRD review's Given, When and Then acceptance becomes one acceptance sentence. Given, When and
  Then stays for a case that one sentence can't state.
- The requirements template in devloop's scoping step changes the same way.
- The checker gains rules for PRDs, HLDs and LLDs, so it reports findings on documents it passed
  before. FR-17 and FR-18 say what other projects see.
- In hoop's PRD, NFR-10 retires, because it states how the code is built. The HLD keeps its text
  and points to the requirements it protects.
- NFR-13, NFR-14 and NFR-16 keep only the outcome a user can rely on. Their mechanisms move to the
  HLD.
- Every other requirement keeps its ID and its meaning, in new words. Its test file names move to
  the project LLD's test plan.
- No behavior of hoop itself changes.

## 2. User interactions and flows

### Writing a PRD

The author starts from the PRD template, writes the document, runs the checker, and submits it to
hoop. The reviewers comment, and the requester approves it.

- FR-1: When an author starts a PRD, the template shall give five sections in this order. They are
  overview and objectives, user interactions and flows, UI states and transitions, edge cases and
  error handling, and out of scope. Acceptance: for each section, the template lists every item
  the request says it contains and every item it says it never holds. Changes: CR-30.
- FR-2: The template shall say where the rest of a PRD sits. A quality bar for the whole product
  goes in section 1, and one for a single flow sits with that flow. Changed current behavior goes
  in section 1, and assumptions and open questions close section 5. Acceptance: the template has
  a place for each, and this PRD uses them. Changes: CR-30.
- FR-3: When a section doesn't apply to a change, the PRD shall say "None" and give one sentence
  why. Acceptance: a PRD for a change with no screens says so under UI states. Changes: CR-30.
- FR-4: The PRD standards shall list the ten things a PRD never holds, in the request's words.
  The first five are prescribed implementation details, vague or subjective acceptance criteria,
  unbounded feature sets, unvalidated assumptions presented as facts, and hardcoded dates. The
  other five are finished visual designs, a missing out of scope section, unlinked dependencies,
  solutions without problem statements, and untestable edge cases. Acceptance: the standards name
  all ten, and a reviewer comments on each one a PRD holds. Changes: CR-30.
- FR-5: A PRD shall name only the public parts that a user or an agent types, reads or sets.
  Those are commands, agent tools with their inputs and results, and document formats
  with their versions. They also include pages, controls, settings, and files the user edits or reads. It
  never names a source or test file, a function, an internal web address, or how data is stored.
  Acceptance: the PRD standards state both lists. Changes: CR-30.
- FR-6: Each requirement shall have one acceptance sentence that a user or an agent could observe.
  It is measurable, and it never names a test. Acceptance: no requirement in a new PRD names a
  test, and each one has an acceptance sentence. Changes: CR-30.
- FR-7: Each requirement shall end with the change requests that changed its behavior, oldest
  first, written as `Changes: CR-3, CR-22`. A change that only rewords it adds nothing. The text
  states current behavior, with no history such as "since CR-9". Acceptance: the checker reports
  each requirement without the tag. Changes: CR-29, CR-30.

### Writing an HLD or an LLD

- FR-8: An HLD or an LLD shall point only to requirements, by their IDs, and never name a change
  request. A change's links to other queued changes live in its notes and the tracker. Acceptance:
  the HLD and LLD templates and their review standards state the rule. Changes: CR-29.
- FR-9: The LLD's test plan shall name, for each requirement, the tests that prove it. Acceptance:
  every requirement in the project PRD has a row in the project LLD's test plan. Changes: CR-30.

### Checking a document

The author runs the checker on the file, or hoop runs it on submit.

- FR-10: In a PRD, the checker shall flag each file path, source or test file name, function call
  and web route. It flags them inside code too. Acceptance: a sample PRD gets one finding
  for each. Changes: CR-30.
- FR-11: The checker shall flag each change request name in an HLD or an LLD, outside its status
  line. Acceptance: a sample HLD gets one finding for each name. Changes: CR-29.

### Folding a change into the project documents

- FR-12: When a change folds, its requirements shall land in the project PRD with their change
  tags. Its design text lands in the project HLD and LLD with no change request names. Acceptance:
  the fold steps say so, and the next fold's documents pass the checker. Changes: CR-29, CR-30.

### Rewriting hoop's own documents

- FR-13: The project PRD shall follow the five sections and every rule above. Every current
  requirement ID stays, except the ones section 1 retires. Acceptance: the rewritten PRD passes
  the checker, and NFR-1's script passes. Changes: CR-30.
- FR-14: The project HLD and LLD shall name no change request. Each place that named one points to
  the requirements it serves, and a decision keeps its reason. Acceptance: the checker reports no
  change request name in either. Changes: CR-29.
- FR-15: Before the rewrite, a comparison shall find the states and errors that hoop lacks. It
  compares hoop with GitHub pull request review, Google Docs suggesting mode and Plannotator. The comparison
  covers the review page, the review list, the tracker page and the agent's tools. The gaps become
  at most one new queued change request for each of those four. Acceptance: each gap names its
  change request in the project PRD's open questions. Changes: CR-30.

## 3. UI states and transitions

The only screen this change touches is hoop's check panel on a review page. That panel already
exists, and its states don't change.

- FR-16: The new rules' findings shall show in the check panel like the other writing findings.
  Each one names its line and says what to write instead. Acceptance: a PRD that names a test file
  shows a finding on that line, which says to move the test to the LLD's test plan. Changes: CR-30.

## 4. Edge cases and error handling

- FR-17: A PRD whose title names its kind, but without the five sections, shall get one finding
  on how to adopt the new shape. It gets no finding for each code name. Acceptance: checking
  today's project PRD reports that one finding and no code finding. Changes: CR-30.
- FR-18: A project shall list the names its users type that look like code, such as a file the
  user edits, in `docs/allowed-names.txt`. The checker never flags a listed name. With no list, it
  flags every kind FR-10 names. Acceptance: hoop's PRD names its users' config file and passes
  with the list, and gets a finding without it. Changes: CR-30.
- FR-19: The checker shall know a PRD, an HLD or an LLD by the kind its title names. It works the
  same on the file and on hoop's submit. Acceptance: submitting the project PRD to hoop shows the
  same findings as running the checker on its file. Changes: CR-30.
- The checker keeps skipping a change's request file, which holds the requester's own words.

## 5. Out of scope

- Rewriting the documents of past changes. They are frozen records.
- Building the states and errors that FR-15 finds. Each group becomes its own change request.
- Any change to hoop's behavior. Only devloop's skills, its checker and hoop's documents change.

### Assumptions and open questions

- Every PRD, HLD and LLD names its kind in its title, as the templates show. Documents of past
  changes that don't are frozen, so the checker treats them as plain documents.
- A requirement ID never changes, so links from tests and the tracker still work.
- A timing target a user can notice, such as a page that renders in under a second, is a quality
  bar. The request's section 2 excludes internal service targets, not these.
- This change's requirements land in hoop's PRD when it folds, because devloop ships from this
  repository and the PRD already holds devloop's other requirements.
