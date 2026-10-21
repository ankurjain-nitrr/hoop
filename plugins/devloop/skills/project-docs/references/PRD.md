# CR-<n> PRD: <Name of the change>

Status: <proposed | approved | implementing | merged | folded> · Revision: <n> · Owner: <name> · Type: <epic | story | task | bug> · Request: `REQUEST.md`

The title names the document's kind. A project PRD's title is `# <Project> PRD`. Each section
below starts with what it holds and what it never holds, so delete those sentences as you write
it. A section that doesn't apply says "None", with one sentence on why.

A PRD names only what a user or an agent types, reads or sets. Those are commands, agent tools
with their inputs and results, and document formats with their versions. They also include pages,
controls, settings, and files the user edits or reads. A PRD never names a source or test file, a
function, an internal web address, or how data is stored. A name users type that looks like code
goes in the project's `docs/allowed-names.txt`.

## 1. Overview and objectives

This section holds the problem, the success criteria and the target personas. It also holds the
quality bars for the whole product, and every current behavior the change alters. It never holds
revenue projections, marketing rollout plans, or telemetry and logging designs.

### Problem

<Who has which problem today, and what it costs them. Name no solution yet.>

### Success criteria

| Metric | Baseline | Target | How measured |
|---|---|---|---|
| <What a user gets, as a number>. | <Today's value, or "Not measured">. | <The goal>. | <How a person or an agent observes it>. |

### Target personas

- **<Persona>:** <Who they are, and what they are trying to do>.

### Quality bars

- NFR-<n>: <A measurable bar for the whole product, such as a time a user notices>. Acceptance:
  <one sentence that says how it is observed>. Changes: CR-<n>.

### Changes to current behavior

The requester approves each of these explicitly.

- <Requirement ID>: <What changes or goes away, and what replaces it>.

## 2. User interactions and flows

This section holds each flow's entry points, its steps in order, and its exit points and handoffs.
It holds each flow's requirements, and a quality bar that belongs to one flow sits with it. It never
holds web routes or endpoint definitions, data schemas, storage engines, or service latency targets.

### <Flow name>

<How the user finds the flow, what they do step by step, and where they land at the end>.

- FR-<n>: When <trigger>, the product shall <one observable behavior>. Acceptance: <one sentence
  that a user or an agent could observe, which names no test>. Changes: CR-<n>.
- NFR-<n>: <A measurable bar for this flow>. Acceptance: <how it is observed>. Changes: CR-<n>.

Each requirement takes the next free project ID when the change is scoped. A change to an existing
requirement keeps its ID. The tag lists, oldest first, every change request that changed the
behavior, as in `Changes: CR-3, CR-22`. A change that only rewords a requirement adds nothing to
its tag. The text states current behavior, with no history. Use Given, When and Then only for a
case that one sentence can't state.

## 3. UI states and transitions

This section holds the ideal state, with data and the user on the main path. It holds the empty
state on first use or with no data, the loading and transitional states, and the partial states.
It never holds finished visual designs, exact styles, colors or pixel sizes, or how the screen is
rendered.

- FR-<n>: When <the state's condition>, <the screen> shall show <what the user sees and can do
  next>. Acceptance: <one observable sentence>. Changes: CR-<n>.

## 4. Edge cases and error handling

This section holds destructive actions with their confirmation and undo, offline or interrupted
states, and validation errors with the messages users see. It also holds conflicts of permission or
state, such as two people editing at once. It never holds retry algorithms, infrastructure failure
routing, or lists of internal error codes.

- FR-<n>: When <what goes wrong>, the product shall <what the user sees, and how they recover>.
  Acceptance: <one observable sentence>. Changes: CR-<n>.

## 5. Out of scope

This section holds deferred features, unsupported platforms, and work on the architecture that
this change leaves out, such as speed, telemetry or scaling. It never holds a requirement.

- <What is left out, and where it goes instead>.

### Assumptions and open questions

- <A fact the PRD relies on without proof. Say what would show it, and flip it if it is wrong>.
- <A question only the requester can answer, and what it changes>.
