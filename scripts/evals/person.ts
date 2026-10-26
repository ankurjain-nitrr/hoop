// The scripted person for the agent evals: plays the reviewer's side of a scenario from a fixed
// script. It reads hoop's files read-only and writes only through the pages API the browser uses,
// at fixed points, so it is deterministic and a failed check is the agent's, not the reviewer's.
import { DOC, itemLines, type ReviewDoc } from "../../src/contract.js";
import { threadViews } from "../../src/rules.js";
import { Store } from "../../src/store.js";
import { isWaiting } from "../../src/wait.js";
import { wakeMessage } from "../../src/wake.js";
import type { Call, ReviewRecord, Revision } from "./checks.js";

/** The latest state of the review Claude submitted, as the script reads it. */
export type View = { id: string; record: ReviewRecord; latest: Revision };
export type State = { calls: Call[]; review: View };
/** One scripted action: it runs once, when Claude is idle (waiting or done) and `when` holds. */
export type Step = { name: string; when?: (s: State) => boolean; act: (p: Person, v: View) => Promise<void> };

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
  readonly log: { step: string; error?: string }[] = [];
  /** The message hoop sends a session for each review, for the runner to resume a session that had stopped. */
  readonly wakes: string[] = [];
  private next = 0;
  private seen = -1;

  constructor(
    readonly base: string,
    readonly home: string,
    readonly steps: Step[],
  ) {}

  get done() {
    return this.next >= this.steps.length;
  }

  /**
   * Runs the next step if it is due: Claude has stopped (`ended`) or hoop records a wait on the
   * review, Claude did something since the last step, and the step's `when` holds. A hoop_wait call
   * in the transcript isn't enough: a review given before hoop records the wait could be missed.
   */
  async tick(calls: Call[], ended: boolean): Promise<boolean> {
    const step = this.steps[this.next];
    if (!step || calls.length <= this.seen) return false;
    const review = this.view();
    if (!review || !(ended || isWaiting(this.home, review.id))) return false;
    if (step.when && !step.when({ calls, review })) return false;
    this.next++;
    this.seen = calls.length;
    try {
      await step.act(this, review);
      this.log.push({ step: step.name });
    } catch (err) {
      // The script can't go on from a refused action, so the person stops reviewing.
      this.log.push({ step: step.name, error: (err as Error).message });
      this.next = this.steps.length;
    }
    return true;
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
