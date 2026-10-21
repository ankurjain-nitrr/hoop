# Contributing to hoop

Thank you for helping. This guide says how to build hoop, test it and send a change.

## Build and test

You need Node 18.18 or later, git and python3. The browser tests need Node 20 or later and Chrome.

```sh
git clone https://github.com/ankurjain-nitrr/hoop.git
cd hoop
npm install        # builds hoop and sets up the commit hooks in this clone
npm run typecheck
npm run lint
npm test
```

- `npm test` skips the browser tests on Node 18. To run them, use Node 20 or later with Chrome
  installed. Set `HOOP_CHROME` when Chrome isn't in its usual place.
- Set `HOOP_REQUIRE_BROWSER=1` to make a missing browser fail the run instead of skipping it.
- The acceptance runs are in `scripts/`: `npm run e2e:local`, `npm run e2e:docs`,
  `npm run e2e:cr` and `npm run e2e:pages`. They need Node 20 or later and Chrome.
- `npm run e2e:github` runs the GitHub channel live. It needs a gh login and
  `HOOP_E2E_REPO=owner/name`, a repository you can push to and merge in.

## Commit hooks

`npm install` in your clone points git at `.githooks`. Installing hoop as a tool sets up nothing.

- Before a commit, the hooks run the type check, Biome on staged code, the comment guard, and the
  writing check on staged documents in `docs/`.
- Before a push, they run the tests.
- `npm run format` formats the code with Biome.

Code comments say what the code does now. They never name a change request or a tracker item;
that history lives in `docs/changes/` and in git.

## Sending a change

1. Open an issue first for anything larger than a small fix, so we can agree on the behavior.
2. Changes to hoop follow devloop: each one is a change request in `docs/changes/`, with its
   requirements and design reviewed in hoop. `CLAUDE.md` describes the flow.
3. Keep each pull request small, with tests for the behavior it adds and a regression test for
   each defect it fixes.
4. Fill in the pull request template. CI runs the type check, the linter and the tests on Node 18,
   20 and 22, and the browser tests on Node 22.

## Code of conduct

Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md).
