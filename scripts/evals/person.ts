// The scripted person for the agent evals: plays the reviewer's side of a scenario from a fixed
// script. It reads hoop's files read-only and writes only through the pages API the browser uses,
// at fixed points, so it is deterministic and a failed check is the agent's, not the reviewer's.
import { DOC, itemLines, type ReviewDoc } from "../../src/contract.js";
import { threadViews } from "../../src/threads.js";
import { Store } from "../../src/store.js";
import { isWaiting } from "../../src/wait.js";
import { answerMessage, wakeMessage } from "../../src/wake.js";
import { readWork } from "../../src/work.js";
import type { Call, ReviewRecord, Revision, WorkSnapshot } from "./checks.js";

/** The latest state of the review Claude submitted, as the script reads it. */
export type View = { id: string; record: ReviewRecord; latest: Revision };
type State = { calls: Call[]; review: View };
/** One scripted action on the review: it runs once, when Claude is idle (waiting or done) and `when` holds. */
export type ReviewStep = { name: string; when?: (s: State) => boolean; act: (p: Person, v: View) => Promise<void> };
/** One scripted action on the Work page: it runs once, when `due` holds, whether Claude has stopped or is still running. */
export type WorkStep = {
  name: string;
  due: (s: { calls: Call[]; work: WorkSnapshot; ended: boolean }) => boolean;
  onWork: (p: Person, w: WorkSnapshot) => Promise<void>;
};
export type Step = ReviewStep | WorkStep;

/** The session's work as a trial record keeps it, or undefined when hoop has none for it. */
export function workSnapshot(home: string, session: string): WorkSnapshot | undefined {
  const r = readWork(home, session);
  return (
    r && {
      todos: r.todos.map((t) => ({ id: t.id, text: t.text, status: t.status })),
      agents: r.agents.map((a) => ({
        id: a.id,
        ...(a.description ? { description: a.description } : {}),
        status: a.status,
        ...(a.call ? { call: a.call } : {}),
      })),
      changes: (r.changes ?? []).map((c) => ({ kind: c.kind, ...(c.todo ? { todo: c.todo } : {}), ...(c.agent ? { agent: c.agent } : {}), at: c.at })),
    }
  );
}

const revisionOf = (doc: ReviewDoc, revision: number): Revision => ({
  revision,
  title: doc.title,
  tldr: doc.tldr,
  lines: [
    { item: DOC, line: 1, text: doc.title },
    { item: DOC, line: 2, text: doc.tldr },
    ...doc.items.flatMap((i) => [{ item: i.id, line: 0, text: i.title }, ...itemLines(i).map((text, n) => ({ item: i.id, line: n + 1, text }))]),
  ],
  // A markdown "## Question:" section carries its options as choices.
  questions: doc.items.filter((i) => i.choices?.length).map((i) => ({ id: i.id, choices: i.choices ?? [] })),
});

/**
 * Every review in a hoop folder, oldest first, as a trial record keeps it. hoop writes a new
 * review's record before its first revision, so a review with no revision yet isn't submitted.
 */
export function snapshot(home: string): ReviewRecord[] {
  const store = new Store(home, { readOnly: true, migrate: false });
  return store
    .list()
    .filter((m) => m.revisions > 0)
    .sort((a, b) => a.created.localeCompare(b.created))
    .map((m) => ({
      id: m.id,
      status: m.status,
      revisions: Array.from({ length: m.revisions }, (_, n) => revisionOf(store.revision(m.id, n + 1), n + 1)),
      feedback: store.allFeedback(m.id),
      threads: threadViews(store, m.id),
      edits: store.proposals(m.id),
    }));
}

export class Person {
  /** Each step taken, with how many of Claude's calls (`at`) and of its texts (`said`) came before it. */
  readonly log: { step: string; at: number; said: number; error?: string }[] = [];
  /** The message hoop sends a session for each review, for the runner to resume a session that had stopped. */
  readonly wakes: string[] = [];
  private next = 0;
  private seen = -1;

  /** `session` is the trial's Claude Code session, whose work the Work steps change. */
  constructor(
    readonly base: string,
    readonly home: string,
    readonly steps: Step[],
    readonly session = "",
  ) {}

  get done() {
    return this.next >= this.steps.length;
  }

  /**
   * Runs the next step if it is due and Claude did something since the last step. A review step is
   * due when Claude has stopped (`ended`) or hoop records a wait on the review, and its `when` holds:
   * a hoop_wait call in the transcript isn't enough, since a review given before hoop records the
   * wait could be missed. A Work step is due when its `due` holds on the session's work. `said` is
   * how many texts Claude has said so far: a text with no call between it and the step is ordered by it.
   */
  async tick(calls: Call[], ended: boolean, said = 0): Promise<boolean> {
    const step = this.steps[this.next];
    if (!step || calls.length <= this.seen) return false;
    const act = "onWork" in step ? this.workAct(step, calls, ended) : this.reviewAct(step, calls, ended);
    if (!act) return false;
    this.next++;
    this.seen = calls.length;
    try {
      await act();
      this.log.push({ step: step.name, at: calls.length, said });
    } catch (err) {
      // The script can't go on from a refused action, so the person stops reviewing.
      this.log.push({ step: step.name, at: calls.length, said, error: (err as Error).message });
      this.next = this.steps.length;
    }
    return true;
  }

  private reviewAct(step: ReviewStep, calls: Call[], ended: boolean) {
    const review = this.view();
    if (!review || !(ended || isWaiting(this.home, review.id))) return undefined;
    if (step.when && !step.when({ calls, review })) return undefined;
    return () => step.act(this, review);
  }

  private workAct(step: WorkStep, calls: Call[], ended: boolean) {
    const work = workSnapshot(this.home, this.session);
    if (!work || !step.due({ calls, work, ended })) return undefined;
    return () => step.onWork(this, work);
  }

  /** Makes one change to the session's work, as the Work page does. */
  change(change: Record<string, unknown>) {
    return this.post(`/api/work/${this.session}/changes`, { changes: [change] });
  }

  /** Tells a Claude that had stopped to go on, with `message`, as the person would in the terminal. */
  say(message: string) {
    this.wakes.push(message);
  }

  /** Presses Go with your recommendation on a quick question, and keeps the message hoop wakes the session with. */
  async goWithRecommendation(v: View) {
    await this.post(`/api/reviews/${v.id}/answer`, { recommended: true });
    const store = new Store(this.home, { readOnly: true, migrate: false });
    this.wakes.push(answerMessage(store.allFeedback(v.id).at(-1)!, store.revision(v.id, 1)));
  }

  async post(path: string, body: unknown) {
    const res = await fetch(`${this.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = (await res.json()) as any;
    if (!res.ok) throw new Error(`${path}: ${out?.error ?? res.status}`);
    return out;
  }

  /** Submits a review as the browser does, and keeps the message hoop would wake the session with. */
  async review(v: View, body: Record<string, unknown>) {
    const out = await this.post(`/api/reviews/${v.id}/feedback`, { comments: [], answers: [], ...body });
    this.wakes.push(wakeMessage(out, v.latest.title));
  }

  /** Resolves every open thread, then approves, or answers the questions left with the recommended options. */
  async settle(v: View) {
    const resolved_threads = v.record.threads.filter((t) => t.status !== "resolved").map((t) => t.thread);
    const qs = v.latest.questions;
    if (!qs.length) return this.review(v, { verdict: "approved", resolved_threads });
    const answers = qs.map((q) => ({ item: q.id, choice: (q.choices.find((c) => c.recommended) ?? q.choices[0])!.id }));
    return this.review(v, { verdict: "changes_requested", answers, resolved_threads });
  }

  /**
   * Accepts every edit Claude proposed that the person hasn't decided, read afresh, and returns the
   * review after. hoop refuses an edit whose line has changed since (line_unchanged): it stays
   * proposed, for the checks to find. Any other refusal is the harness's, and stops the person.
   */
  async acceptEdits(v: View): Promise<View> {
    for (const e of this.view()!.record.edits.filter((x) => x.status === "proposed"))
      await this.post(`/api/reviews/${v.id}/edits/${e.id}`, { action: "accept" }).catch((err: Error) => {
        if (!/: line_unchanged: /.test(err.message)) throw err;
      });
    return this.view()!;
  }

  /** The review as it stands now. */
  view(): View | undefined {
    const record = snapshot(this.home)[0];
    return record && { id: record.id, record, latest: record.revisions.at(-1)! };
  }
}
