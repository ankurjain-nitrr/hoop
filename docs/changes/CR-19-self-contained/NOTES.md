# CR-19: intake notes

Captured on 2026-10-19 with `hoop cr create`. The proposed type is task and the kind is
non-functional. The project is hoop.

## What the request covers

Anyone who clones hoop should be able to run every test and acceptance script. Nothing should
depend on a repository outside it, or on one person's account or machine.

## What ties hoop to one person today

- The live GitHub script, `scripts/e2e-github.ts`, needs `HOOP_E2E_REPO`, and the guides point it
  at a private sandbox repository that only its owner can use.
- `scripts/e2e-cr.ts` names hoop's own repository as the one whose pull request it reads.
- The tests and scripts look for Google Chrome only at its macOS path.
- `CLAUDE.md` names one person's Node install path and the sandbox repository.

## What it likely includes

- The GitHub script makes a throwaway private repository in the runner's own account, runs its
  steps there, and deletes it afterwards. `HOOP_E2E_REPO` still names a repository to use instead.
- The change script reads the checkout's own `origin`, so it works from a fork.
- The tests find Chrome or Chromium on macOS, Linux and Windows, and `HOOP_CHROME` still overrides.
- `CLAUDE.md` and the README drop the personal paths and the sandbox.

## Capture check

The verdict is new. No queued change covers it. It runs right after CR-13, because it is small and
it lets anyone develop hoop.

## Merged on 2026-10-19 (CR-21)

CR-19 is closed and merged into CR-20, which makes hoop usable and buildable by anyone. Its scope becomes CR-20's first story, and it still runs first.
