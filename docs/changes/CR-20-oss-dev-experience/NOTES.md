# CR-20: intake notes

Captured on 2026-10-19 with `hoop cr create`. The proposed type is epic and the kind is
non-functional. The project is hoop.

## What the request covers

- Commit hooks that follow common practice, so a broken commit is caught before it leaves the
  machine.
- A development experience on par with the best open source projects.
- Open source guidelines that hoop follows, and that devloop applies in every project it drives.

## What hoop has today

- No commit hooks, no linter or formatter, and no continuous integration.
- Tests, a type check and acceptance scripts that run by hand.
- A README with an Apache 2.0 license section and a status note, since pull request 84.
- No contributing guide, code of conduct, security policy, changelog, issue or pull request
  templates, editor settings or dependency updates.

## What it likely includes

1. Commit hooks kept in the repository and set up by `npm install`. Before a commit they run the
   type check, the writing check on changed documents and quick guards. Before a push they run
   the tests.
2. A linter and a formatter for the code, run by the hooks and by CI.
3. Continuous integration on GitHub Actions: the type check and tests on each supported Node
   version, and the browser tests with `HOOP_REQUIRE_BROWSER=1`.
4. The usual open source files. They are a contributing guide, a code of conduct, a security
   policy and a changelog. Issue and pull request templates, editor settings, code owners and
   dependency updates come with them.
5. A devloop skill that checks a repository for these practices and keeps them in each change, so
   every project that devloop drives follows them.

## Capture check

- The verdict is new, with one overlap. CR-19 removes the sandbox repository and personal paths, so
  anyone can run hoop's tests. That is part of the same goal. Resolution: CR-19 runs first, because
  it is small, and CR-20's CI builds on its self-contained scripts.
- Size: this is about six pull requests, above the guide of five. Scoping should split it, for
  example into hooks, linting and CI first, and the project files with the devloop skill second.

It runs after CR-13 and CR-19, and before CR-11.

## Merged on 2026-10-19 (CR-21)

CR-20 absorbs CR-19, whose scope becomes its first story. It also absorbs the first half of B-22. A commit check refuses code comments that name a change request or a tracker item. The same story removes the references already in the code, so the check passes on the whole tree. The stories are these. First, hoop depends on nothing outside the repository or one person's machine. Second, commit hooks, a linter and CI run. Third, the open source files and the devloop skill land. Scoping can still split the second or third story.

The absorbed change's request and notes are in `docs/changes/CR-19-self-contained/`.

## Usability review (2026-10-19)

Item 13 says breaking changes are expected. The changelog this change adds is where each breaking change is announced. CR-28 owns the README for users, and this change owns the files for contributors.
