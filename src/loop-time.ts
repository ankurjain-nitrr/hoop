// How long the person takes to answer Claude, on this machine: from each request Claude made (a
// review's revision, a quick question, an action item) to the person's first response, read from what
// hoop already keeps. It reads only, and nothing here leaves the machine: these are people's numbers.
import { span } from "../web/activity.js";
import type { ActionItem } from "./actions.js";
import type { Store } from "./store.js";
import { median } from "./util.js";

/** The kinds of request whose answer is the person's. */
const KINDS = [
  { kind: "review", label: "Reviews" },
  { kind: "question", label: "Quick questions" },
  { kind: "action", label: "Action items" },
] as const;
type Kind = (typeof KINDS)[number]["kind"];

/** One request Claude made of the person: when, and when the person first answered it, if they have. */
export type Wait = { kind: Kind; id: string; asked: string; answered?: string };

/**
 * A review's requests: each revision, from when it was written to the person's first review of it.
 * A revision Claude replaced before the person answered is neither answered nor waiting.
 */
function reviewWaits(store: Store, id: string): Wait[] {
  const m = store.meta(id);
  const person = store.allFeedback(id).filter((f) => !f.session);
  const out: Wait[] = [];
  for (let n = 1; n <= m.revisions; n++) {
    const asked = n === 1 ? m.created : store.revisionAt(id, n);
    if (!asked) continue;
    const answered = person.find((f) => f.revision === n && f.at >= asked)?.at;
    const latest = n === m.revisions;
    if (answered || (latest && m.status === "open" && !m.closed)) out.push({ kind: "review", id, asked, ...(answered ? { answered } : {}) });
  }
  return out;
}

/** A quick question's request: from when Claude asked to the person's first answer. */
function askWaits(store: Store, id: string): Wait[] {
  const m = store.meta(id);
  const answered = store.allFeedback(id).find((f) => !f.session)?.at;
  if (!answered && (m.ask?.withdrawn || m.closed)) return [];
  return [{ kind: "question", id, asked: m.created, ...(answered ? { answered } : {}) }];
}

/**
 * Every request Claude made of the person that hoop keeps: its sessions' reviews and quick questions
 * (not a review the person opened from a file, the sample, or a document still being built) and action
 * items. An action item counts as answered when the person ticked it done or said Won't do; one hoop's
 * own check closed, or the session withdrew, isn't the person's answer.
 */
export function waits(store: Store, actions: ActionItem[]): Wait[] {
  const reviews = store.list().filter((m) => m.revisions > 0 && !m.opened_by && !m.sample && m.build !== "open");
  return [
    ...reviews.flatMap((m) => (m.ask ? askWaits(store, m.id) : reviewWaits(store, m.id))),
    ...actions.flatMap((a): Wait[] => {
      if (a.state === "open") return [{ kind: "action", id: a.id, asked: a.created }];
      const theirs = (a.state === "done" || a.state === "wont_do") && a.closed_by && a.closed_by !== "hoop" && a.closed_at;
      return theirs ? [{ kind: "action", id: a.id, asked: a.created, answered: a.closed_at! }] : [];
    }),
  ];
}

/** Each kind's loop time: the median from request to response over the answered ones, and how many wait now. */
type LoopTime = { kind: Kind; label: string; answered: number; waiting: number; median_ms?: number };

export function loopTimes(all: Wait[]): LoopTime[] {
  return KINDS.map(({ kind, label }) => {
    const mine = all.filter((w) => w.kind === kind);
    const took = mine.flatMap((w) => (w.answered ? [Math.max(0, Date.parse(w.answered) - Date.parse(w.asked))] : []));
    const mid = median(took);
    return { kind, label, answered: took.length, waiting: mine.length - took.length, ...(mid === undefined ? {} : { median_ms: mid }) };
  });
}

/** The loop times as `hoop loop-time` prints them. */
export function loopTimeText(rows: LoopTime[]): string {
  const width = Math.max(...rows.map((r) => r.label.length));
  const lines = rows.map((r) => {
    const took = r.median_ms === undefined ? "none answered yet" : `${span(r.median_ms)} median, of ${r.answered}`;
    return `  ${r.label.padEnd(width)}  ${took}${r.waiting ? `; ${r.waiting} waiting` : ""}`;
  });
  return `How long you take to answer Claude, from its request to your first response, on this machine:\n${lines.join("\n")}\nThese numbers stay on this machine.\n`;
}
