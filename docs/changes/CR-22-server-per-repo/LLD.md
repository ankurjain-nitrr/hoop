# CR-22: LLD

Status: folded · Revision: 3 · PRD: approved (revision 5) · HLD: approved (revision 3)

This document says how each HLD component is built. Code-level detail is limited to new files,
design patterns and the public interfaces between layers. Logic inside a file is left to code review.

## Versions (new file `src/version.ts`)

- `release(install)` reads the `package.json` version in an install folder. `codeId(install)`
  hashes the relative path, size and modified time of every file under the install's `src/`,
  `dist/` and `web/`. It reads no file contents.
- An install folder is the folder above the running module, so it is the checkout under `tsx` and
  the package folder under `dist`.
- A server works out its `codeId` on its five second timer, and `GET /api/info` reads the last
  result, so a page load never hashes files.
- Releases compare as dotted numbers. A release that doesn't parse never counts as newer.

## Sessions (new file `src/sessions.ts`)

This is the HLD's registry. It is named sessions so it doesn't clash with the change registry.

- Each `hoop mcp` session writes `sessions/<pid>.json` in the store's home folder, `store.home`,
  through `writeAtomic`. A test with a temporary home therefore never touches the user's folder.
- The entry holds `format: 1`, the process ID and the process's start time. It also holds the repository's
  real folder, the install folder, the release and `start`. `start` is a list of arguments, run without a shell. It holds the Node path, `process.execArgv` for loaders such as `tsx`, and the install's own `cli` module
  file. It never uses `process.argv[1]`, which points at a test file or a bin link.
- The session removes its entry at exit. An entry is live while a process with its ID runs and that
  process started when the entry says. The start time comes from `ps -o etime=`, run without a
  shell, within five seconds. Where `ps` is missing, the boot time stands in. Sleep doesn't end an
  entry.
- Readers skip an entry that doesn't parse or has a newer `format`, and ignore unknown fields.
- `storeKey(home)` follows `repoIdentity`'s key: a hash of the home folder's real path.

## Starter (new file `src/pages.ts`)

- `ensurePages(store)` asks `GET /api/info` on the usual address, with a one second timeout. Its
  result is one of these:
  - `serving`: hoop answers with the same store key.
  - `started`: nothing listens. It starts the install's `start` command with `serve`, detached,
    with `HOOP_PAGES=background`, no output and no wait.
  - `old`: a hoop from before this change answers, with no store key.
  - `unavailable`: anything else, including another store or a timeout.
- `Op` in `src/ops.ts` gains `link: true` for each operation whose result has a link. `createServer`
  in `src/mcp.ts` and `runOp` in `src/cli.ts` call `ensurePages()` before running such an operation.
  `runMcp` calls it at start in place of `startWeb`.
- `HOOP_PAGES=off` turns the starter off. `test/helpers.ts` sets it for every test unless the test
  sets its own, and `mcpClient` passes it to the child. The end to end scripts set their own port
  and home, turn the starter on, and stop the pages process at the end. The second pull request
  updates `scripts/e2e-local.ts` and `scripts/e2e-docs.ts` for this.

## Pages process (changed `src/web.ts` and `src/cli.ts`)

- `hoop serve` with `HOOP_PAGES=background` is the pages process. It tries the address every 250
  milliseconds for five seconds, and exits if it never binds. It writes its start and stop to the
  audit log.
- Without the variable, `hoop serve` runs in the foreground as today. It has no idle stop and no
  self restart, but its pages still show the stale banner. It says "already serving" only when
  hoop answers, and says that another program holds the address otherwise.
- Every server reads its page files into memory at start, and serves only that snapshot.
- The pages process keeps the time of its last request, and exits when no session is live and no
  request came for an hour. Each open page asks `GET /api/info` every minute, so an open page keeps
  it running. Tests shorten the hour with `HOOP_PAGES_IDLE_MS`.
- `GET /api/info` adds `hoop: "pages"`, `release`, `code`, `store`, `stale`, `pid` and `repos`.
  Each repository is a `{ name, key }` from `repoIdentity`, so no path leaves. `repo` stays until
  the pages stop reading it, in the fourth pull request. `pid` lets tests stop what they started.
- `GET /api/trackers` and `GET /api/tracker` take `repo=<key>`. The server looks for the key among
  live sessions and its own folder, and refuses an unknown key. Without `repo=`, they use the
  server's own folder, as today. They land with the picker, in the fourth pull request.

## Self restart (in `src/pages.ts`)

- Pattern: a timer in the pages process, every five seconds. No route can start it.
- The target is the live session with the newest release, when that release differs from the
  server's own. Otherwise it is the server's own install, when its `codeId` changed. A target is
  named by its release and its install's `codeId`, so a changed install is tried again.
- The server stops listening and runs the target's `start` command with `serve`, detached. It asks
  the address for up to five seconds. When the successor answers with the expected release and
  code, the old process exits.
- Otherwise the old process stops the successor it started, then listens again and keeps `stale`
  true. If the address is taken and hoop for the same store answers, the old process exits.
- When the server's own install is gone and no session is live, the pages process exits.
- Each start, restart, fallback and stop is written to the audit log, with the target's release.

## Pages (changed `web/index.html`, `web/app.js`, `web/frame.js`, `web/tracker.js`)

- `index.html` loads the app through a dynamic import. When the import fails, or the app hasn't
  started after five seconds, it replaces "Loading" with the error and the restart step.
- The frame names the shown document's repository. A review page takes it from the review, and the
  tracker page from the chosen repository. The menu shows the release and a short code ID.
- The tracker page lists the open repositories and keeps the chosen key in its address.
- Every page shows a banner while `stale` is true. When the minute request fails, the banner says
  the pages stopped, and that any hoop command or a new session brings them back.

## Results notice (FR-9, waits for the requester's approval)

- When `ensurePages()` returns `old` or `unavailable`, each result with a link gains `pages`, with a
  `status` and a `message`. For `unavailable`, the message names `HOOP_PORT`. For `old`, it says to
  restart the session that serves the pages. This adds a field to the tool results, so it lands
  only after the requester approves it.

## Public interfaces between layers

- The MCP tools and the CLI commands don't change, apart from FR-9's field after approval.
- `GET /api/info` and the tracker routes change as above. Only hoop's own pages use them.
- The session entry is a new stored format with a `format` version, read only by hoop processes.
- `HOOP_PAGES` and `HOOP_PAGES_IDLE_MS` are internal. Only hoop and its tests set them.

## Test plan

Process tests run hoop from the checkout, each on a free port with a temporary home. Each test
stops every process it started, by the `pid` it learns. Install tests run from a temporary copy of
hoop's install with linked `node_modules`, which the test then changes.

| Requirement | What the test proves | Level |
|---|---|---|
| FR-1 | Links from a session and from a command use the usual address and open. | process |
| FR-2 | A session starts the pages process when nothing answers, and reuses one for the same store. The pages answer after the session ends. | process |
| FR-3 | A holder that isn't hoop, one that never answers, another store and an old hoop each leave the tools working within a second. | process |
| FR-4 | A changed install restarts into the new code on the same address. A successor that never answers is stopped, and the old server serves again. A pending comment survives a restart. | process, browser |
| FR-5 | A changed install with no current session keeps the banner on every page. | browser |
| FR-6 | Two repositories each show their own tracker and name, from one server. | browser |
| FR-7 | The menu shows the release. | browser |
| FR-8 | A failing app import shows the error in place of "Loading". | browser |
| FR-9 | An unavailable address and an old hoop each add their notice to a result. | process |
| FR-10 | An open page keeps the server running past the idle time, and no session and no page stops it. | process |
| NFR-1 | Requests from other sites, other host names and plain requests can't stop or restart the server. | process |
| NFR-2 | No response holds a folder path, with two repositories. | process |
| NFR-3 | Page loads with the restart timer on take no more than 50 milliseconds longer than with it off, in one build. | process |

Existing tests that change: `test/web.test.ts` for the dynamic import and the info fields, and
`test/frame.test.ts` for the document's repository name.

## Pull requests

1. Versions and sessions, with unit tests.
2. The starter, the `link` mark, the pages process with its idle stop, `GET /api/info` and the
   end to end scripts. Tests for FR-1, FR-2, FR-3, FR-10 and NFR-1.
3. Self restart with its fallback. Tests for FR-4 and NFR-3.
4. The pages: picker, names, banner, version and page start, with the tracker routes. Browser
   tests for FR-4's drafts and FR-5 to FR-8, and the NFR-2 test.
5. The acceptance script with two sessions in two repositories.
6. The results notice, after the requester approves it. Tests for FR-9.
