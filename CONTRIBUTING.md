# Contributing to hoop

Thanks for helping. This page covers setting up, picking something to work on, and what a pull
request needs. [`docs/DESIGN.md`](docs/DESIGN.md) describes how hoop works.

## Set up

hoop needs Node.js 22.12 or later; CI runs Node 22 and 24.

```sh
git clone https://github.com/ankurjain-nitrr/hoop.git
cd hoop
npm install
```

`npm install` builds hoop and sets up the commit hooks. For the browser tests, install Chrome or
point `HOOP_CHROME` at it.

If you also use hoop day to day from this clone (`npm link`, or the plugin pointing at it), do your
work in a git worktree, not on the clone's checked-out branch: the installed `hoop` runs from the
clone's `dist/` and `web/`, so a half-done change there breaks it.

```sh
git worktree add ../hoop-my-change -b my-change origin/main
```

To try a branch's pages, run its hoop on a throwaway `HOOP_HOME`, with `HOOP_CLAUDE_DIR` set to an
empty folder and `CLAUDE_CODE_SESSION_ID` to a made-up ID, so it never touches your own reviews or
Claude Code folder.

## Pick something to work on

Work is tracked in a few area issues (labelled `enhancement`), each with a checklist of items under
**Expected behaviour**. To take one:

1. Pick an unticked item. An item marked "(good first)" is small and self-contained.
2. Comment on the issue naming the item, so nobody else starts it.
3. Open one pull request for it. A bug you find on the way gets its own issue or item.

For something not on any checklist, open an issue first and describe the current and the expected
behaviour.

## Make a pull request

- Branch from `main` and keep the pull request small: one item, with tests for what it adds and a
  regression test for each bug it fixes.
- Run the checks before you push:

  ```sh
  npm run typecheck
  npm run lint      # npm run format fixes formatting
  npm run debt
  npm test          # HOOP_REQUIRE_BROWSER=1 fails instead of skipping the browser tests
  ```

  `npm run debt` fails when the branch adds import cycles, unused, complex, loosely typed or
  duplicated code compared with `main`.
- The push hook runs the type check, lint and the tests that name what the branch changed;
  `HOOP_FULL_PUSH=1 git push` runs the whole suite first. CI runs everything on Node 22 and 24 and
  must pass before a merge.
- A change to a page (`web/`) follows [`docs/DESIGN-LANGUAGE.md`](docs/DESIGN-LANGUAGE.md), and
  `test/pages.test.ts` checks every page in both themes, at 400 pixels, from the keyboard and with
  axe.
- A change to the tools, the MCP instructions or `hoop help` updates
  `test/fixtures/interface.json` (`HOOP_UPDATE_FIXTURE=1 npm test`); a change to the contract
  regenerates `schemas/` (`npm run schemas`).
- Say in the description what changes for someone using hoop, and how you checked it.

Releases are cut by the maintainer; [`docs/RELEASING.md`](docs/RELEASING.md) describes how.
