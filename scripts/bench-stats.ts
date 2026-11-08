// The loop-timing benchmark's arithmetic and options (scripts/bench.ts runs it): targets, medians,
// the summary and its table, and the ports it may use.
// Nothing here starts a process or touches the environment, so its tests leave nothing behind.
import { createServer } from "node:net";
import { parseArgs } from "node:util";
import { ipv6Held } from "../src/pages.js";
import { median as middle } from "../src/util.js";

export type Measure = "cold start" | "page ready" | "hoop_wait";
/** What each measure should stay under, in milliseconds; a measure without one is reported only. */
export const TARGETS: Record<Measure, number | undefined> = { "cold start": undefined, "page ready": 300, hoop_wait: 1000 };
/** What each measure covers, as the table says it. */
export const COVERS: Record<Measure, string> = {
  "cold start": "starting hoop serve to its first answer",
  "page ready": "the review page's HTML and its review JSON, on a warm server; no JS, CSS or drawing",
  hoop_wait: "the verdict sent to hoop_wait returning it",
};
/** The first port the benchmark uses, well clear of hoop's own 4747. */
export const FIRST_PORT = 4791;

export type Summary = { measure: Measure; samples: number[]; median: number; max: number; target?: number; ok: boolean };

/** The run's options: how many samples of each measure, and whether to print JSON. */
export function benchOptions(args: string[]): { samples: number; json: boolean } {
  const { values } = parseArgs({ args, options: { samples: { type: "string" }, json: { type: "boolean" } } });
  const samples = values.samples === undefined ? 6 : Number(values.samples);
  if (!Number.isInteger(samples) || samples < 1 || samples > 50) throw new Error("--samples takes a whole number from 1 to 50");
  return { samples, json: Boolean(values.json) };
}

/** The middle value of `xs`, or the mean of the two middle ones; a measure with no samples is an error. */
export function median(xs: number[]): number {
  const m = middle(xs);
  if (m === undefined) throw new Error("no samples");
  return m;
}

/**
 * How long a sample waits, after hoop_wait starts, before it sends the verdict. hoop_wait wakes when
 * the verdict is written (src/wait.ts), so when in its 2 s fallback check the verdict lands no longer
 * matters: this only lets the wait settle.
 */
export const VERDICT_DELAY_MS = 300;

/** Each measure's samples against its target: ok when the median is at or under it, or it has no target. */
export function summarize(samples: Record<Measure, number[]>, targets = TARGETS): Summary[] {
  return (Object.keys(targets) as Measure[]).map((measure) => {
    const xs = samples[measure];
    const m = median(xs);
    const target = targets[measure];
    return { measure, samples: xs, median: m, max: Math.max(...xs), ...(target === undefined ? {} : { target }), ok: target === undefined || m <= target };
  });
}

/** The summary as lines for a person: each measure's median, max and target, whether it met it, and what it covers. */
export function table(rows: Summary[], from: string): string {
  const ms = (x: number) => `${Math.round(x)} ms`;
  const verdict = (r: Summary) => {
    if (r.target === undefined) return "(no target)";
    return `${r.ok ? "ok" : "OVER"}: target ${ms(r.target)}`;
  };
  return [
    `hoop's loop on this machine, ${from}:`,
    ...rows.map((r) => `${r.measure.padEnd(11)} median ${ms(r.median).padStart(8)}, max ${ms(r.max).padStart(8)} over ${r.samples.length}  ${verdict(r)}`),
    "",
    ...rows.map((r) => `${r.measure}: ${COVERS[r.measure]}.`),
    "hoop_wait wakes when the verdict is written; its check every 2 s is only the fallback.",
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
