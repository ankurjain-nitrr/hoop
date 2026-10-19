# Stack references

The devloop skills are written for any language and any project. When a step needs a command or a
file name that depends on the stack, look it up here. Read the file for each stack the repo uses.

- JavaScript and TypeScript on Node are in [javascript.md](javascript.md).
- Python is in [python.md](python.md).
- Java and Kotlin, built with Gradle or Maven, are in [jvm.md](jvm.md).
- Go is in [go.md](go.md).
- Rust is in [rust.md](rust.md).

The repo's own `CLAUDE.md`, README and CI files win over these files. CI shows what the project
really runs, so read it first.

## When a stack has no file

Work out each section below from the stack's own documentation and the repo's CI. Then add a file
for the stack here, with the same sections, so the next project can look it up.

## Sections in each file

- The "Test command" section says how to run the whole suite, and one test file.
- The "Gate" section says how to save the output and check the exit status before a commit.
- The "Static checks" section names the type check, the linter and the formatter, when the stack has them.
- The "Size budget" section names the lockfiles and generated paths that don't count toward the budget.
- The "Runtime pins" section names the files that pin the runtime version, for the preflight.
- The "Hooks" section says where a pre-commit hook may live.
- The "Gotchas" section lists traps that cost time in this stack.
