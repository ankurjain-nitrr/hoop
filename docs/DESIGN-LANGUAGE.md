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
| `--ok` (green) | Finished well | Approved, Done, Checks passed, Merged, Applied in rev N, a recommended option |
| `--warn` (red) | Needs fixing | Changes requested, Checks failing, Stalled, Not running, a change Claude overrode, a contradiction Claude flagged in its own text, the pages-stopped banner |
| `--info` (blue) | A neutral fact, nothing to do | Commented, Building, In review, Not read yet, what Claude generated or changed, a change Claude proposes until it is accepted (its card's border, and the text it would insert, blue on `--info-wash`), the TL;DR, a new revision |
| `--muted` (grey) | Everything else | Queued, Idle, Ended, the "Claude's session has ended" line on the review and quick-question pages (its resume command stays as code), Withdrawn, Closed, Replaced, how far a comment got |
| `--link` | A link, always underlined (except a link inside a link; see Exceptions) | Links in notes, descriptions and action items |
| `--focus` | Keyboard focus and the line jumped to | Focus rings, a block being edited |
| `--pressed` | A toggle that is on, or a chosen option | Notify me, a quick question's chosen answer |
| `--mark` | Text that a comment is on | Highlights and selections on the review page |

The surfaces and text carry no meaning of their own: `--paper` (the page), `--surface` (cards),
`--ink` (text), `--muted` (secondary text) and `--rule` (borders). The rest pair with a meaning above:
`--live-wash` is amber's background, `--mark-line` underlines marked text, `--code` is code's
background, `--add`/`--add-ink` and `--del`/`--del-ink` show text added and removed in a change
(a person's suggestion, a revision's diff), and `--info-wash` with `--info` text is the text a change
Claude proposes would insert.
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

**Sizes.** Every size is a custom property at the top of `web/app.css`, and `test/tokens.test.ts`
fails on a raw one outside its listed exceptions. Text comes in five sizes: 15px body
(`--text-body`); 14px supporting text (descriptions, notes, labels, errors, quotes;
`--text-support`); 13px secondary details (times, counts, bylines, in `--muted`; `--text-detail`);
12px small print (`--text-small`); and 11px tags (`--text-tag`). Headings come in two: 1.35rem for
the page title on every page (`--text-title`), and 17px for a section or session heading
(`--text-heading`). A session's name on Home and Work is 17px and bold, as a section heading is; a
section heading is told apart by where it sits, above its sessions over a rule. Two things keep their
own sizes: the brand in the top bar, and a document's own content as the review and build pages
render it, whose headings keep a scale of their own so its levels stay distinct. Any other text size
moves to the nearest step.

Spacing steps are 4, 8, 12 and 16px (`--space-1` to `--space-4`). A gap off the steps moves to the nearest
one (3 or 5px becomes 4), and one halfway between two steps rounds up: 6px becomes 8, 10 becomes 12
and 14 becomes 16. 18 or 20 become 16. Page margins, and indents
wider than 16px that line a block up with the comment gutter, a list's marker or a nesting level, are
widths rather than steps: they stay as the check's listed exceptions. So do 1px and 2px, a tag's or a
badge's inner padding and a nudge that lines up a glyph.

Radii are 3px for tags (`--radius-tag`), 4px for fields (`--radius-field`), 6px for buttons, cards
and rows (`--radius-card`), 8px for what floats above the page (popovers, toasts, dialogs;
`--radius-float`), and 999px for pills (`--radius-pill`).

A control that is only an icon is at least 24px square (`--target`), the smallest target the
accessibility guidelines ask for. A new value is a new token, decided in review.

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
| Live region | One hidden status region per page, written through `announce()`, for a change the person may not see: one with no visible message, or one out of view (see Announcing a change) | All |
| Panel | A card at the top of the page's main column, under the page's header (on the review page, under its title, tabs and history), that a key or a button opens and closes in place; never a popup. Escape or the same key closes it, and focus goes back to where it was | Review (the shortcut panel) |
| Selection bar | One floating surface (`--surface`, a rule border, 8px radius, a low shadow) placed above selected words so it never covers them, holding **Comment on selection** and **Delete selection** in ink and, while it shows, the selection's tip as a plain line under them | Review |
| Toast | A floating card with `role="status"` that says something succeeded out of view; never an error. It announces itself, so it doesn't also go through `announce()` | Review |
| Stat line | One line per kind: its name, then its value ("20 m median, of 3", durations as Times writes them) in `--muted`; no badge, no colour, no waiting count. A muted closing line says what the numbers are | Home (Your response times: its last section, folded by default, with no count; it shows once any request has an answer) |

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

### Announcing a change

- **When to use:** a change the person may not see: one with no visible message (a verdict that swaps, an action item marked done), or one that shows out of view (a new revision, Claude's status line in the header, the pages-stopped banner, a request's status on the build page, a review replaced or a quick question withdrawn while its page is open, or what Claude adds to an open review: a reply, an edit or a quick question beside a line).
- **When not:** what a page shows as it loads, which isn't a change; a diagram that fails to draw, which shows only in place; an error, which is on its error line; and a success out of view on the review page, which its toast says.
- **How:** the page's one hidden status region says it, through `announce()`. Nothing else on a page is a live region: no `aria-live`, and `role="status"` only on the toast. A change is said once, when it happens, and the same words said again are heard again. A status on the build page names its block first ("Paragraph 4: Claude is writing this again…"). What Claude adds to an open review is said with its place: "Claude replied on “X” line N.", "Claude proposed an edit on “X” line N." or "Claude asked a quick question on “X” line N."; several at once read "Claude replied in N conversations.", "Claude proposed N edits." or "Claude asked N quick questions.", and everything one refresh brings, with a verdict it changed, is combined into one message. When a warning clears, the region no longer says it.
- **Reference:** a new revision on the review page.

### Keyboard shortcuts

- **When to use:** a review page action a reviewer repeats while reading: moving between lines and open conversations, commenting, suggesting, Claude's tracked changes, a Question section's answers, and Viewed. The review page has them; other pages get theirs later.
- **When not:** sending a verdict. Approve and Request changes have no key; only a press of their button sends one.
- **How:** one letter or digit each: **j** / **k** next and previous line, **n** / **p** next and previous open conversation, **c** comment, **s** suggest a change, **a** / **x** accept or reject Claude's change on the line, **1**–**4** an option in the line's question, **g** its recommended option, **v** the section's Viewed. A key acts where focus is, and focus then goes where the same press would leave it (Focus after an action). A key does nothing while the person types, in the comment box, the verdict panel, a dialog or a popover, with a modifier held, held down, or while an input method composes. A key with nothing to act on changes nothing, and the live region says why in a few words ("No change from Claude on this line"). **?** opens the shortcut panel, which lists the keys and holds the **Keyboard shortcuts** switch and **Hide keys**, which closes it, as **?** and Escape do (**Close** only ever means closing a review). The switch is on by default and kept in this browser, and on when the browser can't keep it. While it is off every letter and digit key does nothing; **?** still opens the panel, so the keys can be turned on again.
- **Reference:** the review page's shortcut panel.

### Disclosures

- **How:** sections fold with a chevron button (`web/fold.js`), with `aria-expanded` on the button. Every fold button is one size: a chevron alone sits in a 24px square (`--target`), and a fold with a label is at least 24px tall. A fold's label is 14px, bold, in `--ink`, with a `--muted` chevron; a fold in a heading takes the heading's look. Every fold keeps its state through a reload, on every page, the build page's section folds and Versions included. A fold's summary is its name and count, "History 3", or the count of each state inside it. A time window names its own span and shows no count: "Last 5 minutes", not "Last 5 minutes 4". A folded part stays reachable by find in page, which opens it. Native details elements are used only where the browser's own behaviour is the point.
- **Deliberate exception:** the build page's section fold is the chevron alone. Its name is the editable heading beside it, and "N blocks folded" shows under the heading while it is folded.
- **Not a fold:** More / Less on a todo's description on Work shows the rest of clamped text; it stays a link-style More / Less.
- **Reference:** Home's sections.

### Writing and sending

- **How:** where the text is likely to run to paragraphs or markdown (a comment on a line, a suggestion, an overall comment, a build note, a todo's description, a quick question's note), Ctrl+Enter (⌘+Enter on a Mac) does what the box's button does and the box says so under it, with the button's verb ("⌘+Enter sends; Escape cancels.", "⌘+Enter previews; Escape cancels." for a build block's Preview); Enter starts a new line. On the review page's comment, suggestion and edit boxes it reads "⌘+Enter adds; Escape keeps your words for later, Cancel discards them." A quick question's note goes with the answer picked ("⌘+Enter sends."); with none picked, focus goes to the first option. Everywhere else (a comment on Work, an Other answer, a reason, a rename) Enter sends and Shift+Enter starts a new line. Neither key sends while an input method is still composing, and a held key sends once. Escape cancels any of them; in a review page's comment, suggestion or edit box it keeps the text, which comes back when the box opens on that line again. The send button says what it does: **Send** for a message to Claude, **Save** for a change to existing text, **Add** for a new item. The review page's **Start a review**, **Add review comment** and **Submit review** keep their names, because they say what happens to the review.
- **Reference:** a comment on Work; a comment on a line of the review page (`web/send.js` for both).

### Drafts

- **When to use:** every box where the person writes something not yet sent or saved: the review page's comments, replies, answers and overall comment; a block being edited on the build page; a quick question's Other answer and note; and a comment, an edit or a new todo on Work.
- **How:** what is typed is kept in this browser once typing stops, and comes back, in its box, after a reload or a closed tab. Then a quiet grey "Draft saved" shows beside the box, only when the browser stored it; it isn't announced. Its place is kept for it, on the box's label line or in its buttons row, so showing it moves nothing. Each block, form and question field is kept on its own, so two tabs never write over each other's, and a tab drops only what it sent or cancelled. A draft whose block or todo changed since it was typed isn't put back over the newer text: when the person opens that box to edit, a note above it says "You had unsent text from before this changed", shows the kept words, and offers **Use it**, which puts them in the box (focus starts on it, since the note comes first), and **Discard**, which drops the draft; until one is pressed, typing in the box keeps a draft of its own and leaves the offered words alone. A draft is kept until it is sent or cancelled, or until what it is for is closed, approved or withdrawn: a review closed or replaced, an approval after the draft was kept, a quick question withdrawn or closed, a question answered since its Other words were typed, a build turned into a review, or a todo that is gone. A request for changes typed on an approved review stays. Whichever page learns that something ended drops its drafts, and the browser keeps at most 500, dropping the oldest, never one the open page is using. Leaving a page does nothing extra, since nothing typed is lost. A browser that can't keep anything (a private window that refuses storage) keeps nothing, and the page works as before.
- **Reference:** a comment on a review page's line.

### Refreshing

- **How:** pages refresh on their own. A refresh waits while a form, a confirmation or a dialog is open. It keeps focus on the same control, the scroll position and any text selection (a selection on the review page is where a comment starts), and never drops what the person typed. A refresh doesn't redraw what didn't change: a diagram, an open box or the line you're reading stays put.

### Tips

- **When to use:** one tip, at the moment its feature applies, and never more than one on a page: the first time the person selects text on the review page ("Comment on just these words"), whenever the comment box is open on selected words ("Suggest the wording instead"), and on the build page beside **Suggest the next heading**, the first time it shows while a section has nothing under it ("Ask Claude for the next section").
- **How:** a tip is one quiet line in the hint line's look (`--text-detail`, `--muted`), beside the control it names. It is never a popup, a callout or a live region: it isn't news, so screen readers reach it through the control's `aria-describedby`. Showing it moves nothing, since it takes a place kept for it (as a plain line on the selection bar's own surface, in the comment box as it opens, under the heading's Suggest buttons as the page draws), and a tip the page showed keeps its place, unseen, until the page loads again, so retiring it moves nothing either. Each tip ends with a link to its page in `docs/using/`: "How comments work", "How suggestions work", "How building works". A tip goes for good, in this browser, once its feature is used: a comment on selected words added (by the selection bar or by typing the words), Delete selection, a suggestion added, or a Generate, Suggest or Generate all on the build page; the control it described is no longer described by it. No tip has a hide of its own; the **Tips** switch on Home, beside Notify me, turns every tip off, and on again, on every page.
- **Reference:** the review page's first selection, on the selection bar. Decided in rv_mw7ips3wabf46f; the bar's surface in rv_mw7qy5pwc557ea.

### Empty, loading and stale states

- **How:** an empty list says what will appear there and how. While something loads, show nothing for the first second; after that, a short muted line ("Loading…"). A load that fails replaces that line with the error line. When the hoop server stops answering, or runs older code than the installed one, the banner at the top says so. A section holding only an Undo line, as Waiting on you on Home right after Done on its last item, shows its name and the Undo line, with no count and no fold, until Undo goes.

## Words

**Who's speaking.** The assistant is **Claude**. Where it matters which session, as on Work and in
replies, the session's name stands in. The person is **You** in what they did and see, and their
name where others read it, such as in a review's history. The person's own comments, replies and
answers, and a close they made, say "You" on the pages, sent or not; a session that commented keeps
its name. A page never says "the agent". A helper agent Claude starts is a **subagent** everywhere
("Stop subagent", "Unnamed subagent", "2 finished subagents"), never a bare "agent".

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

**Parts turned off.** When hoop's off list turns a part off, the page says so where the part
would have shown, naming the list, not as an error. With `messages` off, what you send isn't
told to Claude. Every receipt and status keeps the short form, "Not sent: messages into a session
are off in hoop's off list": a review's receipt on its page, the Not read yet badge's place on
Home's review and quick-question cards (a muted badge), a closed action item's line, a quick
question's answer, Work's change and its session's gate note. The one sentence that says what
happens next goes in the review page's submit toast, after "Review submitted: Approved.": "Messages
into a session are off in hoop's off list, so Claude wasn't told; it reads this with hoop_wait or
hoop_feedback." (the decided "Saved. …" without its "Saved", which the toast already says). A
quick question's page message says only "Saved.", since its answer's receipt says the rest. With
`mermaid` off, a diagram shows its source under the muted note "Diagrams are off in hoop's off
list, so this shows its source." (decided in rv_mw7v3t9e01fc83).

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
| Use it | Put a kept draft that was typed on older text back in its box |
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
