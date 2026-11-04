// The loop-timing benchmark: how long this machine takes for the steps of hoop's loop, against
// targets. It runs only when someone asks for it, never in CI or the test suite, and it creates no
// load of its own: each sample is one ordinary request, in a fresh hoop folder on a port from 4791 up.
//   - cold start: from starting the pages process (`hoop serve`) to its first answer, no target;
//   - page ready: the review page's HTML and its review, both read, under 300 ms;
//   - hoop_wait: from the person's verdict being sent to hoop_wait returning it, under 1 s.
// It exits 1 when a measure's median misses its target.
// Usage: npm run bench -- [--samples 5] [--json]
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { storeKey } from "../src/sessions.js";
import { cli, connectMcp, root, runHome, tsx } from "./lib.js";

/** What each measure should stay under, in milliseconds; a measure without one is reported only. */
export const TARGETS: Record<Measure, number | undefined> = { "cold start": undefined, "page ready": 300, hoop_wait: 1000 };
export type Measure = "cold start" | "page ready" | "hoop_wait";
export type Summary = { measure: Measure; samples: number[]; median: number; max: number; target?: number; ok: boolean };

/** The run's options: how many samples of each measure, and whether to print JSON. */
export function benchOptions(args: string[]): { samples: number; json: boolean } {
  const { values } = parseArgs({ args, options: { samples: { type: "string" }, json: { type: "boolean" } } });
  const samples = values.samples === undefined ? 5 : Number(values.samples);
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

/** Each measure's samples summed up against its target: a median at or under the target is ok. */
export function summarize(samples: Record<Measure, number[]>, targets = TARGETS): Summary[] {
  return (Object.keys(targets) as Measure[]).map((measure) => {
    const xs = samples[measure];
    const m = median(xs);
    const target = targets[measure];
    return { measure, samples: xs, median: m, max: Math.max(...xs), ...(target === undefined ? {} : { target }), ok: target === undefined || m <= target };
  });
}

/** The summary as lines for a person: each measure's median, max and target, and whether it met it. */
export function table(rows: Summary[], from: string): string {
  const ms = (x: number) => `${Math.round(x)} ms`;
  const lines = rows.map(
    (r) =>
      `${r.measure.padEnd(11)} median ${ms(r.median).padStart(8)}, max ${ms(r.max).padStart(8)} over ${r.samples.length}  ${r.target === undefined ? "(no target)" : `${r.ok ? "ok" : "OVER"}: target ${ms(r.target)}`}`,
  );
  return [`hoop's loop on this machine, ${from}:`, ...lines].join("\n");
}

/** The first port from `first` up that nothing listens on. */
export async function portFrom(first = 4791): Promise<number> {
  for (let port = first; port < first + 200; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port from ${first}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** hoop as installed would run: the build when there is one, else the sources through tsx. */
const built = join(root, "dist/cli.js");
const hoopArgs = existsSync(built) ? [built] : [tsx, cli];

/**
 * How long a sample waits before it sends the verdict: spread over hoop_wait's two-second poll, so
 * the samples together time the verdict landing at each point of it, not always at the same one.
 */
export const verdictDelay = (n: number, of: number) => 300 + Math.round(((n - 1) / of) * 2000);

/** One sample of each measure, in a fresh hoop folder with its own pages process, which it stops. */
async function sample(delay: number): Promise<Record<Measure, number>> {
  const home = runHome("hoop-bench-home-");
  const port = await portFrom();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...(process.env as Record<string, string>),
    HOOP_HOME: home,
    HOOP_REPO_DIR: runHome("hoop-bench-repo-"),
    HOOP_PORT: String(port),
    HOOP_NO_BROWSER: "1",
  };
  const started = performance.now();
  const pages = spawn(process.execPath, [...hoopArgs, "serve"], { env: { ...env, HOOP_PAGES: "background" }, stdio: "ignore" });
  try {
    let cold: number | undefined;
    for (const end = Date.now() + 20_000; cold === undefined && Date.now() < end; ) {
      const info = (await fetch(`${base}/api/info`).then(
        (r) => r.json(),
        () => undefined,
      )) as { hoop?: string; store?: string } | undefined;
      if (info?.hoop === "pages" && info.store === storeKey(home)) cold = performance.now() - started;
      else await sleep(10);
    }
    if (cold === undefined) throw new Error(`the pages process didn't answer on port ${port} within 20 seconds`);

    const { client, call } = await connectMcp(env);
    try {
      const { review_id: id } = await call("hoop_submit", {
        markdown: "# Bench: time the loop\n\nA review to time the page and hoop_wait on.\n\n## Plan\n\nOne step.\n",
      });
      const t0 = performance.now();
      await Promise.all([fetch(`${base}/r/${id}`).then((r) => r.text()), fetch(`${base}/api/reviews/${id}`).then((r) => r.json())]);
      const page = performance.now() - t0;

      const waiting = call("hoop_wait", { review_id: id, seconds: 30 });
      // hoop_wait reads the review and starts waiting before the verdict comes.
      await sleep(delay);
      const sent = performance.now();
      const res = await fetch(`${base}/api/reviews/${id}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict: "approved", comments: [] }),
      });
      if (!res.ok) throw new Error(`the verdict was refused: ${res.status} ${await res.text()}`);
      const got = (await waiting) as { status?: string; approved?: boolean };
      const wait = performance.now() - sent;
      if (!got.approved) throw new Error(`hoop_wait returned without the approval: ${JSON.stringify(got).slice(0, 200)}`);
      return { "cold start": cold, "page ready": page, hoop_wait: wait };
    } finally {
      await client.close();
    }
  } finally {
    pages.kill();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const o = benchOptions(process.argv.slice(2));
  const samples: Record<Measure, number[]> = { "cold start": [], "page ready": [], hoop_wait: [] };
  for (let n = 1; n <= o.samples; n++) {
    if (!o.json) process.stdout.write(`• sample ${n}/${o.samples}\n`);
    const s = await sample(verdictDelay(n, o.samples));
    for (const k of Object.keys(samples) as Measure[]) samples[k].push(s[k]);
  }
  const rows = summarize(samples);
  const from = hoopArgs[0] === built ? "from the build (dist/)" : "from the sources, through tsx (run npm run build to time the build)";
  process.stdout.write(o.json ? `${JSON.stringify({ from, rows }, null, 1)}\n` : `${table(rows, from)}\n`);
  process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
}
