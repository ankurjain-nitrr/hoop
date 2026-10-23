# Security policy

## Reporting a vulnerability

Report a vulnerability privately through a security advisory at
https://github.com/ankurjain-nitrr/hoop/security/advisories/new. Please don't open a public issue
for it. We aim to answer within a week.

## Supported versions

Only the latest release gets security fixes.

## What hoop protects, and its limits

hoop runs its review pages on 127.0.0.1 for the person at the machine.

- The pages refuse a request with a foreign Host or Origin, and every write that isn't JSON. So
  another web page can't comment or approve through the person's browser.
- Approving or requesting changes needs no sign-in. Only a person approves, on the review page:
  Claude has no tool to approve, and its instructions tell it never to approve for the person.
- A program running as the same user on the same machine can read hoop's files and call the local
  API, so it could act as the person. hoop is not a boundary against such a program.
- Diagrams draw in a sandboxed frame that can't run script in the page or load anything.
