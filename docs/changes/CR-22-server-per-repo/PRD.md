# CR-22: One current server for every session and repository

Status: approved · Revision: 5 · Owner: Ankur Jain · Type: story · Request: `REQUEST.md`

## Problem

Someone using hoop from two Claude sessions can't trust the review pages. Every session offers its
pages on port 4747 by default. When a second session finds the port taken, its pages quietly don't
start. Its links still lead to the first session's server. That server lists every review, because
all reviews share one store. But its tracker page and the repository name in its frame come from
the first repository only.

When the session that holds the port ends, the pages stop for every other session. After an update,
a running server keeps its old code. So a new page stays on "Loading" with no error. The usability
review raised this as item 11, and the earlier reviews raised it as idea B-10. In recent work it
was the most costly problem, because each time someone had to find the stale server by hand.

## Goals and non-goals

- Goal: every hoop link opens on one address, and the page shows the right repository for it.
- Goal: the pages keep working after the session that started them ends, and run current code.
- Goal: a page says plainly when its server is out of date, and never hangs on "Loading".
- Non-goal: serving pages to other machines. Pages stay on this machine only.
- Non-goal: the README section on two sessions, restarts and removal. CR-28 writes it, as the notes
  say.

## Success metrics

| Metric | Baseline | Target | How measured |
|---|---|---|---|
| Sessions whose tracker page shows another repository. | Every second session. | None. | An acceptance run opens two sessions in two repositories. |
| Seconds without pages after the session that started them ends. | Until another session starts. | None. | An acceptance run ends the session. |
| Page loads that stay on "Loading" after an update. | Every new page file, until a restart. | None. | A browser test updates the code under a running server. |
| Stale or wrong servers found by hand during a change. | Not counted yet. | None. | Each change's look back counts them, starting with this one. |

## Users and scenarios

- **Reviewer with two repositories:** They review a PRD from one repository and a tracker from
  another, in two Claude sessions. Both links use the usual address, and each page names its own
  repository.
- **Developer after an update:** They pull a new version of hoop and open a new session. The pages
  switch to the new code by themselves, and drafts in the browser stay.
- **Reviewer whose session ended:** They keep reviewing in the browser. The pages still answer,
  because they don't belong to any one session.

## Requirements

Here a server's code means the files hoop would run from if it started now, including its page
files. A server is out of date in two cases. Its own files on disk differ from the ones it started
with, or a running session uses a newer hoop release.

- FR-1: When any session or `hoop serve` runs, the system shall serve every page on the usual
  address, port 4747 or `HOOP_PORT`. Every link from a tool or a command uses that address, as
  today.
  Acceptance: Given sessions in repositories A and B, when each submits a document, then both links
  use port 4747 and both open.
- FR-2: When a session or a command that gives a link runs and no hoop server answers on the usual
  address, the system shall start one. That server runs apart from every session. When a hoop
  server for the same store answers, the session uses it. The check waits no more than one second.
  Acceptance: Given a session that started the server, when the session ends, then the pages still
  answer. Given no server, when a session submits a document, then its link opens within 5 seconds.
- FR-3: When something else holds the usual address, the system shall keep the session's tools
  working. That covers a program that isn't hoop, one that doesn't answer, and a hoop server for
  another store. Each later call that
  gives a link checks the address again.
  Acceptance: Given a program that holds port 4747 without answering, when a session starts, then
  its tools work within one second of the usual start.
- FR-4: When the server is out of date, the system shall restart it into the current code, on the
  same address, so drafts stay. The current code is the newest release's install, or the server's
  own install. It tries once for each change. If the new code can't serve, the old server serves
  again, with the FR-5 warning.
  Acceptance: Given a server, when hoop's code on disk changes, then within 5 seconds a page load
  runs the new code. A pending comment is still there.
  Acceptance: Given new code that can't start, when the server restarts, then the old server answers
  again within 10 seconds.
- FR-5: When a page loads from a server that is out of date, the system shall show a warning on
  every page. It says the server is out of date, and names the restart step for when the automatic
  restart fails.
  Acceptance: Given one running server, when hoop's code on disk changes, then the next page load
  shows the warning.
- FR-6: When a page shows a review or a tracker, the system shall name that document's repository,
  not the server's. The tracker page offers the tracker of each repository with a running session.
  Acceptance: Given sessions in A and B, when the reviewer opens B's tracker from A's server, then
  the page shows B's tracker and names B.
- FR-7: The pages shall show the hoop version that serves them, where the reviewer can find it.
  Acceptance: Given a running server, when the reviewer opens the menu, then it shows the version.
- FR-8: When a page can't start, the system shall show what went wrong in place of "Loading". The
  message names the restart step.
  Acceptance: Given a page whose code fails to load, when the page opens, then it shows the error.
- FR-9: When no hoop server can serve the usual address, the system shall say so in each tool and
  command result that gives a link. It names `HOOP_PORT` as the way to pick another address. This
  adds a field to results, so it waits for the requester's approval.
  Acceptance: Given a program that isn't hoop on port 4747, when a session submits a document, then
  the result says the pages aren't available.
- FR-10: When no session has run and no page has been open for an hour, the system shall stop the
  server. An open page counts as use, so the server never stops under a reviewer. The next session
  or link starts it again.
  Acceptance: Given a page open for two hours with no session, then the page still works. Given no
  session and no open page for an hour, then the server has stopped.
- NFR-1: Pages stay local, as project NFR-1 says. The pages still refuse requests from other sites
  and other host names. No request to the address can make the server stop or restart.
  Check: the existing security tests pass, and a test sends restart attempts to the address.
- NFR-2: Project NFR-13 still holds, so no folder path reaches a page, even with several
  repositories.
  Check: a test reads every page response with two repositories and finds no folder path.
- NFR-3: A page load takes no more than 50 milliseconds longer than today on a checkout of hoop.
  Check: a test times page loads before and after.

## What changes for existing users

- Project NFR-1 says one command serves MCP and the page. That changes. The pages now run in one
  background process that sessions and commands start, so they outlive any one session. It stays
  up to an hour after its last use. `hoop serve` still serves the pages in the terminal, as today.
  CR-28's removal steps say how to stop the background process sooner.
- An approval writes its decision files into the review's own repository, as today. A review with
  no recorded repository writes them into the folder of the session that started the pages.
- Project FR-32 says the frame names the repository in use. Now a page names its document's
  repository.
- The tracker page can show other repositories that have an open session.
- Servers from before this change can't restart themselves. So the first update needs one
  restart of the session that serves the pages.
- Nothing already stored changes. A small record of running sessions is new. No command, tool or
  argument is added, renamed or removed. FR-9 adds one
  result field, after the requester approves it.

## Out of scope

- The README section on two sessions, restarts and removal, which CR-28 writes.
- Showing reviews from only one repository on the home page. Every review stays listed, as today.
- Publishing hoop to npm, which idea B-16 covers.

## Assumptions and open questions

- Open question for the requester: may results gain the field that FR-9 needs?

- Assumption: the same repository means the same checkout folder. Two checkouts of one repository,
  such as two worktrees, count as different repositories, because their trackers can differ.
- Assumption: a program on this machine that answers like hoop is trusted, as the local pages are
  today. CR-14 covers proving who acts on this machine.
- Assumption: two installs of the same release with different files count as current. Only a
  newer release, or a change to the server's own files, restarts it.
