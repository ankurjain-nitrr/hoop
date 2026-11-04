# Security policy

## Reporting a vulnerability

Report a vulnerability privately through GitHub's [private vulnerability
reporting](https://github.com/ankurjain-nitrr/hoop/security/advisories/new), not in a public issue,
pull request or discussion. Include what an attacker can do, the steps or a proof of concept that
shows it, the hoop version (the package's in `npm ls -g @ankurjain-nitrr/hoop`, or the plugin's in
`claude plugin list`) and your Node version and operating system. The conversation, and the fix,
stay in the advisory until a release carries the fix.

You get a reply in the advisory within 7 days. The release that fixes it credits you in its notes,
unless you'd rather not be named.

Please don't test against other people's machines: hoop runs locally, so your own install is all you
need.

## Supported versions

Security fixes land on `main` and ship in the next release on npm
([`@ankurjain-nitrr/hoop`](https://www.npmjs.com/package/@ankurjain-nitrr/hoop)). Update to the
latest release to get them.

## What hoop guards

hoop runs on your machine. Its pages are served on `127.0.0.1` only (port 4747 unless `HOOP_PORT`
says otherwise), and its reviews are JSON files in your Claude Code session folders and `~/.hoop`.

hoop trusts the local processes that run as you: like any program of yours, they can read hoop's
files and call its API. It guards against other web pages and other machines.

- **Other web pages can't reach hoop's API.** It refuses a Host other than `localhost` or
  `127.0.0.1` on its port, a foreign Origin, and every write that isn't JSON. The route that takes
  sessions' and commands' writes also refuses any request a browser sends (one with `Origin` or
  `Sec-Fetch-*` headers) and one that doesn't name the store it serves.
- **Claude doesn't approve.** Claude has no tool to approve a review, and its instructions tell it
  never to approve for the person; the review page is where a person approves or requests changes.
  This keeps Claude to its part of the loop; it isn't a boundary against other local processes.
- **Diagrams are sandboxed.** Mermaid runs in a sandboxed frame without same-origin access, loaded
  from one pinned jsDelivr address only on a page with a diagram, and only if it matches the hash in
  `web/diagram.js` (Subresource Integrity).
- **No model calls, little network.** hoop calls no model API. Besides loopback, it reaches the
  network only to:
  - load Mermaid for a diagram;
  - read the state of pull requests it tracks, through your own `gh`;
  - check an action item that waits for an npm release, through your own `npm view`;
  - fetch hoop itself, when the plugin finds no `hoop` installed: it runs
    `npx -y @ankurjain-nitrr/hoop@<version>`, an exact version the plugin pins.
- **Releases are checked.** Every release since 0.1.1 is built and staged on npm by CI with
  provenance (`release.yml`, whose actions are pinned to commit SHAs), and goes live only when a
  maintainer approves it with two-factor authentication. `docs/RELEASING.md` describes the steps.

A way for another web page or another machine to get around these (to read your reviews, write to
hoop or run code through it), or for a release to ship something other than what CI built, is a
vulnerability: please report it as above.
