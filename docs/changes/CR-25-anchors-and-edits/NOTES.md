# CR-25: intake notes

Captured on 2026-10-19 with `hoop cr create`, from the usability review in `REQUEST.md`. The same
request also made CR-22 to CR-28. The project is hoop. Every current capability stays. A change may
move, rename or hide a tool, but nothing a user can do today goes away. The reviewer read only the
README, so each section below starts from what the code does today.

## What it covers

It covers usability items 3 and 4, and idea B-19 from the second review's items 5 and 6.

## What happens today

- Every comment and edit names an item and a counted line number.
- The `hoop_propose_edits` description already states most edit rules. Each find occurs once in its
  line, a replacement has no line breaks, and edits stay in the comment's scope.
- Two rules show only when they bite. Edits that replace over half a line's words are flagged, and a
  proposal applies only while its line is unchanged.

## What it likely includes

- A comment or edit can name the words it covers, and hoop finds the line. Line numbers stay, so
  existing callers keep working.
- Feedback states each comment's edit scope, so an agent knows where it may edit.
- The tool description names the two missing rules, and each refusal names the rule it broke.
- A reviewer can delete text or a whole line in one action, and edit a line in place.

## Our view

We partly agree. Reviewer suggestions and agent proposals stay separate on purpose. A person's
suggestion applies at once, and an agent's edit waits for a person to accept it. What must change is
discovery, and quoted words are easier than counted lines. Any new field or tool needs the
requester's approval first.

## Capture check

The verdict is new, and it absorbs B-19. It runs after CR-12, whose first story keeps a section's
comments when its heading changes. Quoted anchors build on that.
