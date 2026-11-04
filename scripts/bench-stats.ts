// The loop-timing benchmark's arithmetic and options (scripts/bench.ts runs it): targets, medians,
// the summary and its table, the verdicts' spread over hoop_wait's poll, and the ports it may use.
// Nothing here starts a process or touches the environment, so its tests leave nothing behind.
import { createServer } from "node:net";
import { parseArgs } from "node:util";
import { ipv6Held } from "../src/pages.js";

export type Measure = "cold start" | "page ready" | "hoop_wait";
/** What each measure should stay under, in milliseconds; a measure without one is reported only. */
export const TARGETS: Record<Measure, number | undefined> = { "cold start": undefined, "page ready": 300, hoop_wait: 1000 };
/** What each measure covers, as the table says it. */
export const COVERS: Record<Measure, string> = {
  "cold start": "starting hoop serve to its first answer",
  "page ready": "the review page's HTML and its review JSON, on a warm server; no JS, CSS or drawing",
  hoop_wait: "the verdict sent to hoop_wait returning it",
};
/** How often hoop_wait checks for a verdict, which sets how long a verdict waits on average. */
export const POLL_MS = 2000;
/** The fewest samples that spread the verdicts over the poll finely enough to judge hoop_wait by. */
export const MIN_SPREAD = 4;
/** The first port the benchmark uses, well clear of hoop's own 4747. */
export const FIRST_PORT = 4791;

export type Summary = { measure: Measure; samples: number[]; median: number; max: number; target?: number; ok: boolean; judged: boolean };

/** The run's options: how many samples of each measure, and whether to print JSON. */
export function benchOptions(args: string[]): { samples: number; json: boolean } {
  const { values } = parseArgs({ args, options: { samples: { type: "string" }, json: { type: "boolean" } } });
  const samples = values.samples === undefined ? 6 : Number(values.samples);
  if (!Number.isInteger(samples) || samples < 1 || samples > 50) throw new Error("--samples takes a whole number from 1 to 50");
  return { samples, json: Boolean(values.json) };
}

/** The middle value of `xs`, or the mean of the two middle ones. */
export function median(xs: number[]): number {
  if (!xs.length) throw new Error("no samples");
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * How long sample `n` of `of` waits, after hoop_wait starts, before it sends the verdict: 300 ms for
 * hoop_wait to settle, then the middle of the n-th of `of` equal slices of one poll. Over the samples
 * the verdicts land evenly across a whole poll, so the poll's share of the median is half a poll
 * (POLL_MS / 2) whatever the sample count, and the rest is the machine's.
 */
export const verdictDelay = (n: number, of: number) => 300 + Math.round(((n - 0.5) / of) * POLL_MS);

/**
 * Each measure's samples against its target: ok when the median is at or under it. hoop_wait is only
 * judged with MIN_SPREAD samples or more; with fewer, it is reported, as a measure with no target is.
 */
export function summarize(samples: Record<Measure, number[]>, targets = TARGETS): Summary[] {
  return (Object.keys(targets) as Measure[]).map((measure) => {
    const xs = samples[measure];
    const m = median(xs);
    const target = targets[measure];
    const judged = target !== undefined && (measure !== "hoop_wait" || xs.length >= MIN_SPREAD);
    return { measure, samples: xs, median: m, max: Math.max(...xs), ...(target === undefined ? {} : { target }), ok: !judged || m <= target!, judged };
  });
}

/** The summary as lines for a person: each measure's median, max and target, whether it met it, and what it covers. */
export function table(rows: Summary[], from: string): string {
  const ms = (x: number) => `${Math.round(x)} ms`;
  const verdict = (r: Summary) => {
    if (r.target === undefined) return "(no target)";
    if (!r.judged) return `(not judged: fewer than ${MIN_SPREAD} samples to spread over hoop_wait's poll; target ${ms(r.target)})`;
    return `${r.ok ? "ok" : "OVER"}: target ${ms(r.target)}`;
  };
  return [
    `hoop's loop on this machine, ${from}:`,
    ...rows.map((r) => `${r.measure.padEnd(11)} median ${ms(r.median).padStart(8)}, max ${ms(r.max).padStart(8)} over ${r.samples.length}  ${verdict(r)}`),
    "",
    ...rows.map((r) => `${r.measure}: ${COVERS[r.measure]}.`),
    `hoop_wait checks for a verdict every ${POLL_MS / 1000} s; the verdicts land evenly across one check, so half of that (${ms(POLL_MS / 2)}) is the poll's share of its median, and the rest is this machine's.`,
  ].join("\n");
}

/** Whether `port` can be bound on 127.0.0.1. */
const bindable = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });

/** The first port from `first` up that is free on 127.0.0.1 and that nothing holds on ::1, as hoop checks both. */
export async function portFrom(first = FIRST_PORT): Promise<number> {
  for (let port = first; port < first + 200; port++) if ((await bindable(port)) && !(await ipv6Held(port))) return port;
  throw new Error(`no free port from ${first}`);
}
