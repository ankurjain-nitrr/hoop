// The agent evals' scenarios 1–5 from the approved spec: each a prompt, the scripted person's
// steps and the checks. Bump a scenario's `script` whenever its prompt, steps or checks change, so a
// recorded trial says which version it ran.
import { type Check, callsOf, type Line, linkCount, noWritesBeforeApproval, oneReview, reviewOf, waitsWithCursor } from "./checks.js";
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
    noWritesBeforeApproval,
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
        // A reply answers a comment alone only when its review asked for no change; after a request for
        // changes, a reply that promises one needs the revision that makes it.
        const askedChange = (thread: string) => r!.feedback.some((f) => f.verdict === "changes_requested" && f.comments.some((c) => c.thread === thread));
        const replied = (th: (typeof mine)[number]) => th.entries.some((e) => e.role === "owner" && e.at > th.entries[0]!.at);
        const answered = (th: (typeof mine)[number]) =>
          th.outdated || r!.edits.some((e) => e.thread === th.thread) || (replied(th) && (!askedChange(th.thread) || r!.revisions.length > th.revision));
        const missed = mine.filter((th) => !answered(th));
        return missed.length ? `no revision, changed line or proposed edit on ${missed.map((th) => `${th.item} line ${th.line}`).join(", ")}` : undefined;
      },
    },
  ],
};

const [FROM, TO] = ["archiveWorker", "orderArchiver"];

// The person's review page offers only "approved" and "changes requested", so the rename comes as a
// request for changes, which hoop's instructions answer with "revise and ask again". A Claude that
// proposes the edit and also submits a revision makes its own edit stale, and fails edits-apply.
const usesExactEdits: Scenario = {
  name: "uses-exact-edits",
  script: 1,
  minutes: 20,
  prompt: `Draft a plan for a nightly job that archives old orders. Call the job ${FROM} throughout. ${PLAN}`,
  steps: [
    {
      name: "rename comment",
      act: (p, v) => {
        const l = bodyLines(v.latest.lines).find((x) => x.text.includes(FROM));
        if (!l) throw new Error(`no line names ${FROM}`);
        return p.review(v, { verdict: "changes_requested", comments: [{ item: l.item, line: l.line, body: `Rename ${FROM} to ${TO} on this line.` }] });
      },
    },
    { name: "accept edits", act: async (p, v) => p.settle(await p.acceptEdits(v)) },
    settleAgain,
  ],
  checks: [
    {
      name: "proposes-edits",
      run: (t) => {
        const renames = (e: any) => typeof e?.find === "string" && e.find.includes(FROM) && String(e.replace).includes(TO);
        const ok = callsOf(t, "hoop_propose_edits").some((c) => !c.error && (c.input.edits ?? []).some(renames));
        return ok ? undefined : `no hoop_propose_edits call renamed ${FROM}`;
      },
    },
    {
      name: "edits-apply",
      run: (t) => {
        const edits = reviewOf(t)?.edits ?? [];
        if (!edits.some((e) => e.status === "accepted")) return "the person accepted none of Claude's edits";
        // The person accepts every edit it finds; hoop refuses one whose line no longer reads as when proposed.
        const left = edits.filter((e) => e.status === "proposed");
        return left.length ? `${left.length} of Claude's edits no longer applied when the person accepted them` : undefined;
      },
    },
    {
      name: "only-that-line-changes",
      run: (t) => {
        const r = reviewOf(t);
        const th = r?.threads.find((x) => x.entries[0]?.role === "reviewer");
        if (!r || !th) return "the person's comment wasn't stored";
        // The revision the last accepted edit made (else the latest) reads as the commented one, with the
        // rename on the commented line and nothing else. Revisions after it, such as one that writes
        // in a question's answer, aren't the edit's.
        const made = r.edits.filter((e) => e.status === "accepted" && e.applied_revision).at(-1)?.applied_revision;
        const before = r.revisions[th.revision - 1]!.lines,
          after = (made ? r.revisions[made - 1] : undefined) ?? r.revisions.at(-1)!;
        const at = (l: { item: string; line: number }) => `${l.item} line ${l.line}`;
        const want = before.map((l) => ({ ...l, text: at(l) === at(th) ? l.text.replaceAll(FROM, TO) : l.text }));
        if (want.length !== after.lines.length) return `revision ${after.revision} added or removed lines`;
        const off = want.findIndex((l, i) => at(l) !== at(after.lines[i]!) || l.text !== after.lines[i]!.text);
        return off < 0 ? undefined : `revision ${after.revision} doesn't read as revision ${th.revision} with only the rename, at ${at(want[off]!)}`;
      },
    },
  ],
};

// Words, lower case, with a plural's "s" dropped.
const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 ? w.replace(/s$/, "") : w));
const FILLER = new Set("a an and as at by for from in into of on or our the to use using we with".split(" "));
/**
 * The ways an option is named: the label outside brackets, and each bracketed part, each up to its
 * first explanation (a comma, colon, semicolon, a dash or a spaced hyphen). Filler words, and words
 * the question's heading or every other option also has, don't name it.
 */
const namesOf = (label: string, heading: string, others: string[]): string[][] => {
  const shared = others.length ? tokens(others[0]!).filter((w) => others.every((o) => tokens(o).includes(w))) : [];
  const parts = [label.replace(/\([^)]*\)|\[[^\]]*\]/g, " "), ...[...label.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => m[1] ?? m[2] ?? "")];
  const names = (drop: Set<string>) =>
    parts.map((p) => tokens(p.split(/[,:;–—]|\s-\s/)[0]!).filter((w) => !FILLER.has(w) && !drop.has(w))).filter((n) => n.length);
  // An option named only by words another option also has ("RabbitMQ" beside "RabbitMQ with a standby") keeps them.
  const own = names(new Set([...tokens(heading), ...shared]));
  return own.length ? own : names(new Set(tokens(heading)));
};
/** A call that revises review `id`: a whole submit, or a few sections. */
const revises = (c: { name: string; input: Record<string, any> }, id: string) =>
  (c.name === "hoop_submit" && (c.input.review_id === id || c.input.document?.review_id === id)) ||
  (c.name === "hoop_revise_sections" && c.input.review_id === id);
const asked = (t: Parameters<Check["run"]>[0]) => reviewOf(t)?.feedback.find((f) => !f.session && f.verdict === "changes_requested");

const revisesAfterChanges: Scenario = {
  name: "revises-after-changes",
  script: 1,
  minutes: 20,
  prompt: `Draft a plan for moving our background jobs from cron to a queue service. Which queue service to use is open; ask me. ${PLAN}`,
  steps: [
    {
      name: "answer and comment",
      act: (p, v) => {
        const q = v.latest.questions[0];
        const l = bodyLines(v.latest.lines)[0];
        if (!q || !l) throw new Error("the plan asks no question");
        // The option Claude didn't recommend, so a revision that keeps the answer can't be the default.
        const choice = (q.choices.find((c) => !c.recommended) ?? q.choices[0])!;
        return p.review(v, {
          verdict: "changes_requested",
          answers: [{ item: q.id, choice: choice.id }],
          comments: [{ item: l.item, line: l.line, body: "Add a rollback step." }],
        });
      },
    },
    settle,
    settleAgain,
  ],
  checks: [
    oneReview,
    {
      name: "revises-the-same-review",
      run: (t) => {
        const fb = asked(t);
        if (!fb) return "the person's request for changes wasn't stored";
        // A reply answers a request for changes only with a later revision.
        return reviewOf(t)!.revisions.length > fb.revision
          ? undefined
          : `Claude never revised the review after the person asked for changes on revision ${fb.revision}`;
      },
    },
    {
      name: "answer-kept",
      run: (t) => {
        const r = reviewOf(t),
          fb = asked(t);
        const answer = fb?.answers?.[0];
        // The option as the revision the person answered stored it, not as Claude remembers it.
        const q = r?.revisions[(fb?.revision ?? 0) - 1]?.questions.find((x) => x.id === answer?.item);
        const choice = q?.choices.find((c) => c.id === answer?.choice);
        if (!r || !fb || !q || !choice) return "the person's answer isn't stored";
        const latest = r.revisions.at(-1)!;
        if (latest.revision === fb.revision) return `no revision after the person's answer on revision ${fb.revision}`;
        // A question keeps its section's ID across a revision, also with its heading reworded in place.
        if (latest.questions.some((x) => x.id === q.id)) return `revision ${latest.revision} still asks question ${q.id}`;
        const heading = r.revisions[fb.revision - 1]!.lines.find((l) => l.item === q.id && l.line === 0)?.text ?? "";
        const options = q.choices.map((c) => ({
          c,
          names: namesOf(
            c.label,
            heading,
            q.choices.filter((o) => o !== c).map((o) => o.label),
          ),
        }));
        const has = (ws: Set<string>, n: string[]) => n.every((w) => ws.has(w));
        // A line states the choice when it names it and no other option, so a line that also names a
        // rejected one doesn't count. An option whose name is within the chosen one's ("RabbitMQ" in
        // "RabbitMQ on our own hosts") isn't named by it. A paraphrase that leaves out the name
        // ("we self-host it") fails: a known limit of a check with no model.
        const states = (text: string) => {
          const ws = new Set(tokens(text));
          const mine = options.find((o) => o.c === choice)!.names.filter((n) => has(ws, n));
          if (!mine.length) return false;
          const within = (n: string[]) => mine.some((m) => n.every((w) => m.includes(w)));
          return !options.some((o) => o.c !== choice && o.names.some((n) => has(ws, n) && !within(n)));
        };
        const open = new Set(latest.questions.map((x) => x.id));
        return latest.lines.some((l) => !open.has(l.item) && states(l.text))
          ? undefined
          : `no line of revision ${latest.revision} names the person's choice "${choice.label}" and no other option`;
      },
    },
    {
      name: "waits-after-revision",
      run: (t) => {
        const last = t.calls.flatMap((c, i) => (revises(c, reviewOf(t)?.id ?? "-") ? [i] : [])).at(-1);
        if (last === undefined) return "no revision was submitted";
        return t.calls.slice(last + 1).some((c) => c.name === "hoop_wait") ? undefined : { reason: "Claude didn't wait after revising", at: last };
      },
    },
    {
      name: "comment-acted-on",
      run: (t) => {
        const r = reviewOf(t);
        const th = r?.threads.find((x) => x.entries[0]?.role === "reviewer");
        if (!r || !th) return "the person's comment wasn't stored";
        if (r.edits.some((e) => e.thread === th.thread)) return undefined;
        // A line, new since the commented revision, that adds the rollback step.
        const rollback = (text: string) => / roll ?back /.test(` ${tokens(text).join(" ")} `);
        const was = new Set(r.revisions[th.revision - 1]!.lines.map((l) => l.text));
        const added = r.revisions.slice(th.revision).some((rv) => rv.lines.some((l) => !was.has(l.text) && rollback(l.text)));
        return added ? undefined : "no later revision adds a rollback step, and no edit was proposed on the comment";
      },
    },
    noWritesBeforeApproval,
  ],
};

export const SCENARIOS: Scenario[] = [asksForReview, waitsProperly, answersEveryComment, usesExactEdits, revisesAfterChanges];
