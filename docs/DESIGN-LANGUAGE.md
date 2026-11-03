# hoop's design language

How hoop's pages look, behave and speak: Home, Work, the review page, quick questions and the build
page. Read it before changing a page. A pattern here is changed only through a hoop review, then
written into this file (#336). Where a page doesn't follow a rule yet, #336's fixes bring it in
line, and the tests that hold each rule come with them.

## Principles

1. **Show each fact once.** A row, its note and its description never repeat each other (#333).
2. **The same thing looks and acts the same on every page.** A reply, an error, a confirmation, a
   time or a disclosure has one form, wherever it appears.
3. **Say who is speaking.** Every message, note and reply names its author and its time.
4. **Keep the person where they were.** After an action, focus goes to the next sensible control,
   and a refresh never drops what they are typing.
5. **Quiet by default.** Colour, popups and confirmations are spent only where they carry meaning.

## Tokens

Every colour, font and size comes from the custom properties at the top of `web/app.css`, defined
for the light and the dark theme. A style never uses a raw colour; the one exception is a shadow or
a dialog backdrop, which is black at low opacity.

| Token | Means | Where |
| --- | --- | --- |
| `--live` (amber) | Agent work running now (a clock icon), or your move (a person icon) | Running, Working, Checks running, a live session; Awaiting review, Waiting on you, open action items, an unsent comment. Also the current page in the nav, its one use that isn't live |
| `--ok` (green) | Finished well | Approved, Done, Checks passed, Merged, a recommended option |
| `--warn` (red) | Needs fixing | Changes requested, Checks failing, Stalled, Not running, a change Claude overrode, a contradiction Claude flagged in its own text, the pages-stopped banner |
| `--info` (blue) | A neutral fact, nothing to do | Commented, Building, In review, Not read yet, what Claude generated or changed, the TL;DR, a new revision |
| `--muted` (grey) | Everything else | Queued, Idle, Ended, Withdrawn, Closed, Replaced, how far a comment got |
| `--link` | A link, always underlined (except a link inside a link; see Exceptions) | Links in notes, descriptions and action items |
| `--focus` | Keyboard focus and the line jumped to | Focus rings, a block being edited |
| `--pressed` | A toggle that is on, or a chosen option | Notify me, a quick question's chosen answer |
| `--mark` | Text that a comment is on | Highlights and selections on the review page |

The surfaces and text carry no meaning of their own: `--paper` (the page), `--surface` (cards),
`--ink` (text), `--muted` (secondary text) and `--rule` (borders). The rest pair with a meaning above:
`--live-wash` is amber's background, `--mark-line` underlines marked text, `--code` is code's
background, and `--add`/`--add-ink` and `--del`/`--del-ink` show text added and removed in a change.
`--bug` is unused and goes; red means only "needs fixing".

`--link` and `--focus` are the same blue on purpose: both say "you can go here". `--info` is a close
blue, and the two never meet in one form: a link is always underlined text (except a link inside a
link; see Exceptions), and an info state is always a badge or a callout with its icon.

Primary buttons are filled with `--ink`, not a colour, so the next step stands out without claiming
a meaning. Amber is never a link, a toggle, a tab or a button. A new state that is neither running
nor your move picks one of the other meanings. A note that something ended without finishing well
(closed, withdrawn, replaced) takes `--muted`, never `--ok`. Every colour pair passes axe's contrast
check in both themes, and `--mark-line` keeps at least 3:1 against the surface, the paper and
`--mark`.

**Sizes.** Text comes in five sizes: 15px body; 14px supporting text (descriptions, notes, labels,
errors, quotes); 13px secondary details (times, counts, bylines, in `--muted`); 12px small print; and
11px tags. Headings come in two: 1.35rem for the page title on every page, and 17px for a section or
session heading, so Home's title (22px today) and its section headings (20px) shrink to them. Two
things keep their own sizes: the brand in the top bar, and a document's own content as the review
and build pages render it, whose headings keep a scale of their own so its levels stay distinct. Any
other size between these steps moves to the nearest one. Spacing steps are 4, 8, 12 and 16px. Radii are 3px for tags, 4px for fields, 6px for
buttons, cards and rows, 8px for what floats above the page (popovers, toasts, dialogs), and 999px for
pills. A new value is a new token, decided in review.

## Inventory

| Piece | Looks | Pages |
| --- | --- | --- |
| Card | Surface background, 1px rule border, 6px radius | All |
| Row | A card holding one link, with its controls beside the link, never inside it | Home, Work |
| Button | `.btn`; `.small` inside rows; `.primary` (ink) for the next step; `.danger` (red outline) for a destructive one, set apart from the others | All |
| Status badge | One pill with one tone and one icon, only from the tables in `web/status.js` | All |
| Callout | A 3px coloured left rule on the surface, the rule's colour by the table above | All |
| Tag | Mono 11px, 3px radius | All |
| Field | One style: rule border, 4px radius, paper background, a visible label | All |
| Message | The author, the time, then the text; replies beneath it, indented, in order | Review, Work, quick questions, build |
| Note | One line saying what happened to an item, by whom and when | Work, review history |
| Confirmation | The question, the verb button, Cancel, then the error line | Rows and panels on every page |
| Dialog | A native modal dialog with the question, the verb button and Cancel | Work (Remove session) |
| Disclosure | A chevron fold button with its count: "History 3" | All |
| Error line | Red text with `role="alert"`, directly under the control that failed | All |
| Live region | One hidden status region per page, written through `announce()`, for a change with no visible message | All |
| Toast | A floating card with `role="status"` that says something succeeded out of view; never an error. It announces itself, so it doesn't also go through `announce()` | Review |

## Interaction patterns

Each pattern says when to use it, when not, how it behaves, and the page that shows it best.

### Confirming an action

- **When to use:** before an action that destroys something or tells Claude to stop.
- **When not:** an action that can be reversed or sent again (Withdraw an unsent change, Discard a draft, Unresolve, Park): it happens at once, and the result says how to undo it. Where nothing else on the page brings it back, Undo sits beside the result right after: Remove a block on the build page, Done on an action item, Dismiss on a request on Work and on a suggested heading. Apply a suggestion, Accept and Reject Claude's edit don't ask either: an applied or accepted change is put back by another suggestion or edit, and a rejected edit can be proposed again.
- **A choice isn't a confirmation:** Remove on a heading with blocks under it asks what to remove ("Remove this heading and everything under it", "Remove only the heading", Cancel), since the two do different things. Once chosen, the removal happens at once, and Undo follows as for any removal.
- **Deliberate exception:** Move on Work asks in place when it puts a todo above one it starts after, though a move can be reversed: it breaks an order Claude relies on.
- **How:** in place, as a confirmation beside or under the control: the question names the thing, the verb button repeats the action ("Remove", "Stop", "Close"), or says what it leaves out when that is the point ("Finish without drafts"), Cancel follows, and the error line is last. Escape and Cancel close it and put focus back on the control that opened it. A popup (a native modal dialog) is used only for removing something hoop can't bring back, such as Remove session; Tab stays inside it, and the action isn't sent until the person presses its button. An open confirmation or dialog counts as an open form, so the page doesn't refresh under it.
- **Reference:** a todo's Remove on Work; Remove session's dialog.

### Conversations and replies

- **When to use:** anything the person writes to Claude: a comment on a line, a comment on a todo or agent, a todo they add, an Other answer to a question.
- **How:** the person's message, then Claude's replies beneath it, oldest first, each signed and timed. Every kind of item the person writes to Claude takes replies, and a reply shows wherever the message shows. A conversation is open while its item is live, and read-only after.
- **When not:** a note on what changed (moved, parked, edited) is not a conversation.
- **Reference:** a comment thread on the review page.

### Notes and descriptions

- **How:** a row shows the item's text and description; its notes say only what happened (who did what, when, and whether Claude saw it). A note repeats text only when the row can't show it.
- **Reference:** a todo the person added on Work (#333).

### Errors

- **How:** an error appears on the error line directly under the control that failed, says what went wrong and what to do, and takes focus on its field when it has one. It stays until the next attempt. It is never a toast that vanishes, never at the top of the page, and never styled as success. A toast says only that something succeeded out of view, and the review page's two error toasts (a refused approval, a failed Accept or Reject) move onto the error line.
- **Reference:** the Close confirmation's error.

### Focus after an action

- **How:** after an action, focus goes to what comes next: back to the opening control after Cancel, to the next row after a row is removed or moves away, to the changed control after a toggle. It never drops to the top of the page. The live region says what happened when the change happened out of view.
- **Reference:** closing a review from Home.

### Disclosures

- **How:** sections fold with a chevron button and keep their state per page. A fold's summary is its name and count, "History 3", or the count of each state inside it. Native details elements are used only where the browser's own behaviour is the point.
- **Reference:** Home's sections.

### Writing and sending

- **How:** where the text is likely to run to paragraphs or markdown (a comment on a line, a suggestion, an overall comment, a build note, a todo's description, a quick question's note), Ctrl+Enter (⌘+Enter on a Mac) does what the box's button does and the box says so under it, with the button's verb ("⌘+Enter sends; Escape cancels.", "⌘+Enter previews; Escape cancels." for a build block's Preview); Enter starts a new line. On the review page's comment, suggestion and edit boxes it reads "⌘+Enter adds; Escape keeps your words for later, Cancel discards them." A quick question's note goes with the answer picked ("⌘+Enter sends."); with none picked, focus goes to the first option. Everywhere else (a comment on Work, an Other answer, a reason, a rename) Enter sends and Shift+Enter starts a new line. Neither key sends while an input method is still composing, and a held key sends once. Escape cancels any of them; in a review page's comment, suggestion or edit box it keeps the text, which comes back when the box opens on that line again. The send button says what it does: **Send** for a message to Claude, **Save** for a change to existing text, **Add** for a new item. The review page's **Start a review**, **Add review comment** and **Submit review** keep their names, because they say what happens to the review.
- **Reference:** a comment on Work; a comment on a line of the review page (`web/send.js` for both).

### Refreshing

- **How:** pages refresh on their own. A refresh waits while a form, a confirmation or a dialog is open. It keeps focus on the same control, the scroll position and any text selection (a selection on the review page is where a comment starts), and never drops what the person typed.

### Empty, loading and stale states

- **How:** an empty list says what will appear there and how. While something loads, show nothing for the first second; after that, a short muted line ("Loading…"). A load that fails replaces that line with the error line. When the hoop server stops answering, or runs older code than the installed one, the banner at the top says so. A section holding only an Undo line, as Waiting on you on Home right after Done on its last item, shows its name and the Undo line, with no count and no fold, until Undo goes.

## Words

**Who's speaking.** The assistant is **Claude**. Where it matters which session, as on Work and in
replies, the session's name stands in. The person is **You** in what they did and see, and their
name where others read it, such as in a review's history. The person's own comments, replies and
answers, and a close they made, say "You" on the pages, sent or not; a session that commented keeps
its name. A page never says "the agent". A helper
agent Claude starts is a **subagent** everywhere ("Stop subagent", "Unnamed subagent", "2 finished
subagents"), never a bare "agent".

**Reviews opened from a file.** A review the person opened with `hoop open` reads "Opened by you" on
the page and on Home, never the operating system's account name. It has no session, so its pages
never say Claude reads, picks up or revises it, and show no receipts. What the person sends
is kept with the review: the words say so ("Your answers are kept with this review", "Approved. Your
answers are kept with this review."). Approve is complete on its own and asks for no further step;
editing the file and opening it again is optional. The verdict reason is as on any review ("2
questions unanswered", "2 answers, nothing open").

**Receipts.** How far something sent got reads as a short status with its time, never a sentence:
"Sent to Claude 14:01", then "Read by Claude 14:02" (or "Read by" the session's name), "Answered by
Claude 14:03". Not "Claude read this at 14:02".

**hoop's terms.** Words hoop uses for its own parts, the same on every page:

| Term | Means |
| --- | --- |
| the gate | hoop's hook that stops Claude from starting a changed todo and tells it why, and refuses a stopped subagent's tool calls ("Waits for the gate") |
| subagent | A helper agent Claude starts for part of its work |

**Verbs.** One verb per action, on every page:

| Verb | Means |
| --- | --- |
| Approve | Accept a review's latest revision |
| Request changes | Send a review that asks for a new revision |
| Send | Send a message to Claude |
| Save | Keep a change to existing text, keep Claude's draft or rewrite, or put an earlier version of a section's text back (**Save this version**) |
| Add | Create a new item |
| Remove | Delete an item hoop holds: a todo, a session's record |
| Close | End a review or quick question without approving it |
| Withdraw | Take back something sent that hasn't been acted on |
| Discard | Throw away an unsent draft, or a draft or rewrite from Claude |
| Undo | Put back text as it was before a save, or take back an action right after it (a removal, a Done, a Dismiss) |
| Park / Unpark | Keep a todo in the list but don't start it, or put it back in the queue |
| Stop | Stop a running subagent |
| Won't do | Turn down an action item, with a reason |
| Resolve / Unresolve | Mark a conversation settled, or open it again. Resolving Claude's contradiction note on the build page removes it for good, with no Unresolve: Claude raises it again if it still applies |

**Times.** Times follow the browser's locale for the clock and the month's name, and one shared
formatter writes all of them, so no page formats a time itself. A time today shows only the clock
("17:02", or "5:02 PM" in a 12-hour locale). An earlier one adds the day ("Oct 27, 17:02"), and the
year when it isn't this year. How long ago reads "3 m ago", and a duration reads "2 h 14 m", with
seconds only under a minute ("42 s"). Nothing shows seconds otherwise.

**Labels.** Sentence case. A button is a verb, with its object when the row doesn't name it. Every
control names its target for screen readers: "Remove todo #3 Write the docs", "Close: Export plan".

## Accessibility baseline

Every page works in both themes, at 400px wide, from the keyboard alone, and with every other host
blocked, since fonts and scripts are served by hoop itself. It passes axe with no serious problem.
Rows' controls on devices with a mouse show while the row is pointed at or focused and keep their
place; on touch they always show.

## Exceptions

Each deliberate exception is listed here with its reason, and a new one is added through a review.

| Exception | Reason |
| --- | --- |
| The brand in the top bar keeps its own size | It is the product's name, not a heading |
| A document's own content, as the review and build pages render it, keeps its own heading scale | Its levels must stay distinct; the page's two heading sizes would make its h1 and h2 the same |
| A shadow or a dialog backdrop uses black at low opacity, not a token | Both darken what is behind them, in either theme, and carry no meaning |
| A file path may say "agent", as a subagent's transcript path under Details does | It is Claude Code's path, shown as written so it can be found |
| A link in a title shown inside a link, as a review's title in its row on Home, shows only its words in `--ink`, not underlined | A link can't sit inside another link, and the row is the link |

## Do and don't

| Don't | Do | Test |
| --- | --- | --- |
| Say "the agent" on a page | Say "Claude", or the session's name | `test/pages.test.ts`, the word check on every page and state |
| Call a helper agent "agent" ("Stop agent") | Say "subagent" ("Stop subagent") | `test/pages.test.ts`, the word check |
| Write a receipt as a sentence ("Claude read this at 14:02") | Write a short status ("Read by Claude 14:02") | `test/pages.test.ts`, the word check |
| Repeat an added todo's description in its note | Say who added it and when | `test/steer-todos.test.ts` (#333) |
| Count a session as nothing while it works | Count it for itself when no todo stands for it | `test/activity.test.ts` (#330) |
| Confirm Remove session in the header's text | Ask in a modal dialog | `test/work-remove.test.ts` (#329) |
| Offer a Reopen button on a closed review | Let Request changes reopen it | `test/close.test.ts` (#298) |
| Show Approve and Request changes together | Show the one verdict that's valid now | `test/pages.test.ts` (#311) |
| Say Claude reads, picks up or revises a review opened from a file | Say what is kept with the review | `test/ui.test.ts` (#381) |
