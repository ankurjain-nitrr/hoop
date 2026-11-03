# Security policy

## Reporting a vulnerability

Report a vulnerability privately through GitHub's
[private vulnerability reporting](https://github.com/ankurjain-nitrr/hoop/security/advisories/new),
not in a public issue, pull request or discussion. Include what an attacker can do, the steps or a
proof of concept that shows it, the hoop version (`hoop --version`) and your Node version and
operating system. The conversation, and the fix, stay in the advisory until a release carries the
fix.

Please don't test against other people's machines: hoop runs locally, so your own install is all you
need.

## Supported versions

Security fixes land on `main` and ship in the next release on npm
([`@ankurjain-nitrr/hoop`](https://www.npmjs.com/package/@ankurjain-nitrr/hoop)). Update to the
latest release to get them.

## What hoop guards

hoop runs on your machine. Its pages are served on `127.0.0.1` only (port 4747 unless `HOOP_PORT`
says otherwise), and its reviews are JSON files in your Claude Code session folders and `~/.hoop`.

- **Other web pages can't reach hoop's API.** It refuses a Host other than `localhost` or
  `127.0.0.1` on its port, a foreign Origin, and every write that isn't JSON. The route that takes
  sessions' and commands' writes also refuses any request a browser sends (one with `Origin` or
  `Sec-Fetch-*` headers) and one that doesn't name the store it serves.
- **Only people approve.** Claude has no tool to approve a review; approving and requesting changes
  happen only on the review page.
- **Diagrams are sandboxed.** Mermaid runs in a sandboxed frame without same-origin access, loaded
  from one pinned jsDelivr address only on a page with a diagram, and only if it matches the hash in
  `web/diagram.js` (Subresource Integrity).
- **No model calls, little network.** hoop calls no model API. Besides loopback, it reaches the
  network only to load Mermaid for a diagram and, through your own `gh`, to read the state of pull
  requests it tracks.
- **Releases are checked.** Every release is built and staged on npm by CI with provenance, from
  actions pinned to commit SHAs; it goes live only when a maintainer approves it with two-factor
  authentication. `docs/RELEASING.md` describes the steps.

A way around any of these is a vulnerability: please report it as above.
