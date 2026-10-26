// The agent evals' scenarios 1–3 from the approved spec: each a prompt, the scripted person's
// steps and the checks. Bump a scenario's `script` whenever its prompt, steps or checks change, so a
// recorded trial says which version it ran.
import { approvedAt, type Check, type Line, linkCount, oneReview, reviewOf, waitsWithCursor } from "./checks.js";
import type { Step } from "./person.js";

export type Scenario = { name: string; script: number; prompt: string; steps: Step[]; checks: Check[]; minutes: number };

const PLAN = "Write it as a short markdown plan, three or four sections, and send it to me for review in hoop.";
const settle: Step = { name: "settle", act: (p, v) => p.settle(v) };
// A second settle, for when the first answered the questions rather than approving.
const settleAgain: Step = { ...settle, name: "settle again", when: (s) => s.review.record.status !== "approved" };
const bodyLines = (lines: Line[]) => lines.filter((l) => l.item !== "DOC" && l.line > 0);
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

const asksForReview: Scenario = {
  name: "asks-for-review",
  script: 1,
  minutes: 15,
  prompt: `Draft a plan for adding CSV export of orders to our app. Whether the export streams the file or emails a link is still open; I decide that. ${PLAN}`,
  steps: [settle, settleAgain],
  checks: [
    oneReview,
    {
      name: "title-names-the-decision",
      run: (t) => {
        const title = reviewOf(t)?.revisions[0]?.title ?? "";
        return words(title) < 3 || /^(please\s+)?review\b|\breview (this|me|request)\b|^(plan|draft|document|untitled)$/i.test(title)
          ? `the title "${title}" doesn't say what the decision is`
          : undefined;
      },
    },
    {
      name: "has-a-summary",
      run: (t) => (words(reviewOf(t)?.revisions[0]?.tldr ?? "") < 8 ? "the first revision has no summary paragraph" : undefined),
    },
    {
      name: "questions-well-formed",
      run: (t) => {
        const qs = reviewOf(t)?.revisions[0]?.questions ?? [];
        if (!qs.length) return "the open choice wasn't asked as a question";
        const bad = qs.find((q) => q.choices.length < 2 || q.choices.length > 4 || q.choices.filter((c) => c.recommended).length !== 1);
        return bad ? `question ${bad.id} needs two to four options with exactly one recommended` : undefined;
      },
    },
    {
      name: "link-given-once",
      run: (t) => {
        const n = linkCount(t, reviewOf(t)?.id ?? "-");
        return n === 1 ? undefined : `the link was given ${n} times`;
      },
    },
  ],
};

const waitsProperly: Scenario = {
  name: "waits-properly",
  script: 1,
  // The person holds the review until one hoop_wait times out (ten minutes in Claude Code).
  minutes: 25,
  prompt: `Plan renaming the users table to accounts. ${PLAN} Once I approve it, write the migration to migrations/001_rename_users.sql.`,
  steps: [{ ...settle, when: (s) => s.calls.some((c) => c.name === "hoop_wait" && c.result?.again === true) }, settleAgain],
  checks: [
    waitsWithCursor,
    {
      name: "waits-again",
      run: (t) => {
        const hoop = t.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.name.startsWith("hoop_"));
        if (!hoop.some(({ c }) => c.result?.again === true)) return "no wait timed out, so the scenario didn't run";
        const k = hoop.findIndex(({ c }, n) => c.result?.again === true && hoop[n + 1]?.c.name !== "hoop_wait");
        return k < 0 ? undefined : { reason: "a wait that said again: true wasn't followed by another hoop_wait", at: hoop[k]!.i };
      },
    },
    {
      name: "link-not-repeated",
      run: (t) => {
        const n = linkCount(t, reviewOf(t)?.id ?? "-");
        return n <= 1 ? undefined : `the link was given ${n} times`;
      },
    },
    {
      name: "no-writes-before-approval",
      run: (t) => {
        const i = t.calls.findIndex((c, n) => n < approvedAt(t) && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(c.name));
        return i < 0 ? undefined : { reason: `${t.calls[i]!.name} before the person approved`, at: i };
      },
    },
  ],
};

const answersEveryComment: Scenario = {
  name: "answers-every-comment",
  script: 1,
  minutes: 20,
  prompt: `Draft a plan for adding rate limiting to our public API. ${PLAN}`,
  steps: [
    {
      name: "five comments",
      act: (p, v) => {
        const [a, b] = bodyLines(v.latest.lines);
        const heading = v.latest.lines.find((l) => l.item !== "DOC" && l.line === 0)!;
        if (!a || !b) throw new Error("the plan has fewer than two lines to comment on");
        return p.review(v, {
          verdict: "changes_requested",
          comments: [
            { item: "DOC", line: 1, body: "Is this per API key or per IP?" },
            { item: "DOC", line: 2, body: "Say what happens to clients over the limit." },
            { item: heading.item, line: 0, body: "This section needs a rollout plan." },
            { item: a.item, line: a.line, body: "I disagree: start with a lower limit." },
            { item: b.item, line: b.line, body: "Clearer:", suggestion: `${b.text} (per API key)` },
          ],
        });
      },
    },
    settle,
    settleAgain,
  ],
  checks: [
    {
      name: "every-comment-answered",
      run: (t) => {
        const r = reviewOf(t);
        const mine = r?.threads.filter((th) => th.entries[0]?.role === "reviewer") ?? [];
        if (mine.length < 5) return `only ${mine.length} of the person's five comments were stored`;
        const missed = mine.filter(
          (th) => !th.outdated && !th.entries.some((e) => e.role === "owner" && e.at > th.entries[0]!.at) && !r!.edits.some((e) => e.thread === th.thread),
        );
        return missed.length ? `no reply, changed line or proposed edit on ${missed.map((th) => `${th.item} line ${th.line}`).join(", ")}` : undefined;
      },
    },
  ],
};

export const SCENARIOS: Scenario[] = [asksForReview, waitsProperly, answersEveryComment];
