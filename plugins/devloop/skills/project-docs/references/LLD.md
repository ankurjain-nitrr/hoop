# CR-<n> LLD: <Name of the change>

Status: <proposed | approved> · Revision: <n> · PRD: <approved revision> · HLD: <approved revision>

This document says how each HLD component is built, at the level a team needs to agree on before
coding. Code-level detail is limited to new files, design patterns and the public interfaces
between layers and packages. Logic inside a file is left to code review. Diagrams are in Mermaid.

The title names the document's kind. A project LLD's title is `# <Project> LLD`. The design text
points only to requirements, by their IDs, such as FR-12. It never names a change request. Only
the title and the status line may name one.

## <Component>

- Responsibility: <one sentence, with the requirements it serves>.
- New files: <each new file and what it holds>.
- Design pattern: <the pattern it uses, and why>.
- States and errors: <the states it moves through, and how its errors reach callers>.

```mermaid
stateDiagram-v2
  [*] --> First
  First --> Second: <event>
```

## Public interfaces between layers

- <Layer or package A> calls <B> through <interface>, with <inputs>, <outputs> and <errors>.
- Data that crosses the boundary: <an API field or stored format, and who owns it>.

```mermaid
sequenceDiagram
  participant A as <Layer A>
  participant B as <Layer B>
  A->>B: <public call>
  B-->>A: <result or error>
```

## Rollout and rollback

- <How the change ships, how stored data moves, and how to undo it>.

## Test plan

Every requirement in the PRD has a row. Each row names the tests that prove the requirement, so
the PRD never names a test.

| Requirement | Tests | What the tests prove | Level |
|---|---|---|---|
| FR-1 | `<test file>`: `<test name>` | <What behavior they show>. | <unit> |

## Pull requests

1. <The first slice, its new files and its checks>.
