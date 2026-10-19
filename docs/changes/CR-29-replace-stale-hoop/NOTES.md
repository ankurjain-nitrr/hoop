# CR-29: notes

Captured on 2026-10-20 with `hoop cr create`. The proposed type is story. The project is hoop. The
request answers CR-22's open question on FR-9, which the project PRD holds as FR-56.

## What the request means

- When a hoop that doesn't run the current code holds the usual address, a session stops it and
  starts the current code. That covers a hoop from before CR-22, which can't restart itself. The
  requester said "always", so it also covers a hoop for another store.
- When a program that isn't hoop holds the address, hoop doesn't start the pages. Each result that
  gives a link says that another process is using the port, and names `HOOP_PORT`.
- The requester approved that notice in results. It is the `pages` field that FR-56 needed.

## Capture check

The verdict is partly done.
- Done by CR-22: a pages process for the same store restarts itself into current code (FR-51).
- New: a session stops a hoop that can't restart itself, or one for another store, and takes over.
- New, and moved from CR-22: the results notice. CR-22's T-6 is dropped in favor of this change.
- CR-24 makes results say what was created or written. The notice here is one field, so CR-24
  should keep its wording when it reworks results.
- CR-28 writes the README section on two sessions, restarts and removal. It should describe this
  behavior.

## Open points for scoping

- How a session finds the process that holds the address, when an older hoop doesn't report it.
- How a session makes sure the process it stops is hoop, and never another program.
- Whether another store's open pages need a warning before they switch to this store.
