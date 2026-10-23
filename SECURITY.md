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
- Approving or requesting changes needs the person's GitHub sign-in in the browser, unless they
  turned the sign-in off in their own settings. Without it, the pages refuse the verdict.
- The sign-in lasts eight hours. Its ID stays in the review page's own storage, which belongs to
  that address and port, and travels in a request header. Other local servers never receive it.
- hoop asks GitHub only for the person's login, and drops the token once it has it.
- A program running as the same user on the same machine can read hoop's files and could act as
  the person. The sign-in raises the bar for an agent on the machine, but it is not a boundary
  against malware.
- Diagrams draw in a sandboxed frame that can't run script in the page or load anything.
