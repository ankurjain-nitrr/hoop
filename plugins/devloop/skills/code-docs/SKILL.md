---
name: code-docs
description: Writes and reviews code comments, docstrings and docs so they describe the current code briefly, with no change history, chat narration or restating of the code. Use when writing or editing comments or documentation, when cleaning up verbose or AI-written comments, or when checking a diff's comments before commit.
---

# Code docs

Comments and docs describe the code as it is now, for someone reading it later who has never seen
this conversation or the old version. History belongs in version control. If the repo's
`CLAUDE.md` or style guide sets comment rules, follow them.

Write comments in simple language, as complete sentences, without em or en dashes, following
the `writing-style` skill bundled with this plugin (`/devloop:writing-style`).

## Rules

- **Default to no comment.** Good names and small functions carry the *what*. Write a comment only
  for what the code can't say: a non-obvious reason, constraint or invariant, a workaround (link
  the issue), surprising behavior, units or valid ranges.
- **No history.** Never describe the change: "previously", "used to", "no longer", "now",
  "changed to", "instead of", "new", "fixed", "moved from", "refactored". Words describing
  runtime state are fine ("retries until the lock is no longer held").
- **No narration.** No references to the conversation, the user, the task or plan ("as
  requested", "Task 3", "phase 2", "per the review"), and no thinking aloud.
- **Short.** One line where possible; three at most. Docstrings: one summary line, then only the
  parameters, return values and errors that aren't obvious from names and types. Don't restate the
  signature.
- **Match the file.** Same comment style and density as the code around it.
- **Keep them true.** When code changes, update or delete the comments it made wrong. Don't add a
  comment explaining the edit.
- **Docs and READMEs** state current behavior in the present tense. What changed and why goes in the
  commit message, PR description or changelog, not in the docs.

| Instead of | Write |
|---|---|
| `// Changed to batch inserts; the previous loop was too slow` | `// Batch inserts: one round trip per 500 rows` (or nothing) |
| `// Moved to the helpers module so it can be unit tested (Task 8)` | nothing |
| `// Loop over orders and sum the totals` | nothing |
| `// The user asked for it gone.` | nothing |
| 5-line block explaining a one-line guard | `// Upstream sends 200 with an empty body on timeout` |

## Check a diff

Look only at lines the change adds:

```sh
git diff -U0 <base> | grep -E '^\+' | grep -nEi '(//|#|/\*|\*|""").*\b(previously|used to|no longer|formerly|now|changed|instead of|was|new|fixed|moved|refactor|task ?#?[0-9]+|phase [0-9]+|as requested|the user)\b'
```

For each hit, delete the comment or rewrite it to describe the current code; keep it only if it
describes runtime state. Then read the added comments that didn't match: delete those that restate
the code, and cut multi-line blocks to the one line that matters. Put any history you removed into
the commit message instead.
