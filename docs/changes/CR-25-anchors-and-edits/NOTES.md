# CR-25: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away.

## What it covers

Usability items 3 and 4, and idea B-19 from the second review's items 5 and 6.

- A comment or edit can name the words it covers, and hoop finds the line. Line numbers stay, so
  existing callers keep working.
- Feedback states each comment's edit scope, so an agent knows where it may edit before it tries.
- The tool description and each refusal name the edit rules. Each find occurs once in its line,
  edits stay in scope, large rewrites are flagged, and a proposal needs its line unchanged.
- A reviewer can delete text or a whole line in one action, and edit a line in place.

## Our view

We partly agree. Reviewer suggestions and agent proposals stay separate on purpose. A person's
suggestion applies at once, and an agent's edit waits for a person to accept it. What must change is
discovery. The rules must show before a call fails, and quoted words beat counted lines. Any new
field or tool needs the requester's approval first.

## Capture check

The verdict is new, and it absorbs B-19. It runs after CR-12, whose first story keeps a section's
comments when its heading changes. Quoted anchors build on that.
