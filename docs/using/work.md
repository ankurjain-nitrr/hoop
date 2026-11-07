# Work

**Work**, at `http://localhost:4747/work`, shows what each Claude Code session keeps track of while
it runs, and lets you steer it. Its link shows beside Home while a session on this machine has
recorded todos or subagents.

## What it shows

One section per session: its name, the start of its ID, its folder, and whether it is working, idle
or ended. Working sessions come first.

- **Todos**, running ones first, then queued ones in your order, then done ones folded away. Each
  has its description in two lines, with **More** for the rest.
- **Subagents**, each with its description, type, state, how long it has run and its last step.
- **Now:** names a working session's current step ("running tests: npm test"), and a folded
  **Last 5 minutes** lists its recent steps.
- **Up next:** names the todo the session starts next.

The top of the page counts "N running · M waiting on you · K stalled · J not running", each linking
to its first row.

A todo Claude marked in progress shows what it really is, from evidence, with the reason beside it:
**Waiting on you** (a review or pull request it links to waits on you, or the session waits on you),
**In review**, **Done**, **Blocked**, **Running**, **Stalled** after 10 quiet minutes, or **Not
running**. The record keeps what Claude said; the page only reads it.

Each todo says where it came from: your prompt, a review that woke the session, the Work page, or
"added by Claude". A prompt whose turn edited files without a todo reads **Not registered**, with
**Ask Claude to register it** and **Dismiss**.

## Steer it

- On a queued todo: **Comment**, **Edit**, **Next**, **Up**, **Down**, **After…** (it starts after
  another todo), **Park** and **Remove**. **Unpark** puts a parked todo back in its place.
- On a running todo: **Comment** and **Edit**. On a running subagent: **Comment** and **Stop**.
- **Add todo**, under the list, asks Claude to add one.
- **Remove session** on an ended session deletes hoop's record of it, never Claude Code's
  transcript.

Removing, stopping and moving a todo above one it starts after ask you to confirm first.

## How a change reaches Claude

- **A message.** A few seconds after your last change, the session gets one message listing your
  changes in plain words. They are instructions about its own todo list, not approvals.
- **The gate.** Before each tool call, a plugin hook refuses to start or finish a todo you removed,
  refuses an edited or parked one once with your change, refuses starting a todo out of your order
  or before one it starts after once, and refuses every tool call of a subagent you stopped.
- **The end of a turn.** Claude can't end its turn, once, while a change of yours came during it
  unread.

Under each todo, the page shows your change, who made it and when. **History** lists every change
and how far it got: sent, read by Claude, waiting for the gate, seen by Claude, or overridden. hoop
never plans or starts work itself.

## Turning it on

The plugin records todos and subagents with hooks that run in the background, so they never slow or
fail a tool call. Claude keeps a written todo list only when the session starts with
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`; `hoop init` offers to set it. Without it, the page shows only
subagents.

When a running session's hooks don't reach hoop, the page shows **Hooks not firing**: check the
plugin with `claude plugin list`, update it with `claude plugin update hoop@hoop`, and restart the
session.
