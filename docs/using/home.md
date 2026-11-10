# Home

Home, at `http://localhost:4747/`, shows everything hoop holds for you across every Claude session
on this machine. Run `hoop` with no command to open it in the browser and print its link.

## Waiting on you

At the top, **Waiting on you** lists everything Claude waits on you for, across every session, oldest
first. Each row says what kind of thing it is and what it asks, links to it, and shows how long it
has waited and its session:

- **Review · Approve or request changes**: a revision you haven't reviewed yet.
- **Question · Answer**: a quick question with a question unanswered.
- **Build section · Write or generate**: a build with an empty section, and nothing asked of Claude.
- **Work · Answer the prompt**: a permission prompt or dialog in Claude Code, from Work.
- An action item: something Claude needs you to do that isn't a review, such as merging a pull
  request, publishing a staged release or running a command. It says what to do and why, links to
  what it's about, and names its session.

What shows here leaves its session's group under Pending. For action items:

- An item closes when hoop sees it done (the pull request merged, the review approved or the version
  published), checked while Home is open, at most once a minute each.
- **Done** closes an item hoop can't check, and **Undo** takes it back right after.
- **Won't do** turns an item down, with a one-line reason.

Either way, hoop tells the session. With nothing open and nothing pending, Home says "Nothing
waiting on you."

## Pending and Completed

Reviews, quick questions and builds sit under **Pending**; approved, closed and replaced ones under
**Completed**, which starts folded. Each section is grouped by the Claude session that sent them, or
by you for a file you opened with `hoop open`. A session's group shows its name, the start of its
ID, its folder and whether it is still running. Each review shows its title and TL;DR, newest first,
and "Not read yet" while Claude hasn't read your latest review of it.

- **Rename** beside a session names it. hoop also adds the name to the session's transcript, as
  `/rename` does, so Claude Code shows the same name.
- **Close** beside a review ends it without approving it, after an optional reason.

## Pull requests

Home lists the pull requests Claude sessions opened: open ones under Pending, with whether checks
run, fail or passed, a conflict with the base branch, a review asked of you, or ready to merge;
merged and closed ones under Completed. hoop reads their state with `gh` while Home is open, at most
once a minute each. Without `gh` or a sign-in, Home says "State unknown" and asks again.

## Folding

A section's or session's heading folds it away, leaving the counts of what it holds beside its name
("1 awaiting review · 1 changes requested"). **Collapse all** and **Expand all** fold or open every
session. The browser remembers what is folded.

## In every tab

Every hoop tab counts the reviews waiting on you and the open items in its title, as
"(2) Home · hoop", and puts a dot on its icon. **Notify me** turns on a browser notification, while the tab is
hidden, for a review that arrives, for a pull request that becomes ready to merge, gets a conflict
or fails its checks, and for a todo or subagent on [Work](work.md) that comes to wait on you or
stalls. hoop asks the browser's permission only when you press it.

While Home lists nothing, it offers a sample review to try, and a prompt to copy that asks Claude to
send you one.
