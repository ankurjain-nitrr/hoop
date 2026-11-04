// The loop-timing benchmark: how long this machine takes for the steps of hoop's loop, against
// targets. It runs only when someone asks for it, never in CI or the test suite, and it creates no
// load of its own: each sample is one ordinary request, in fresh temporary hoop, repository and
// Claude Code folders, which it removes, on a port from 4791 up.
//   - cold start: from starting the pages process (`hoop serve`) to its first answer, no target;
//   - page ready: the review page's HTML and its review JSON on a warm server, under 300 ms;
//   - hoop_wait: from the person's verdict being sent to hoop_wait returning it, under 1 s.
// It exits 1 when a measure's median misses its target.
// Usage: npm run bench -- [--samples 6] [--json]
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { storeKey } from "../src/sessions.js";
import { benchOptions, type Measure, portFrom, summarize, table, VERDICT_DELAY_MS } from "./bench-stats.js";
import { cli, connectMcp, root, runHome, tsx } from "./lib.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** hoop as installed would run: the build when there is one, else the sources through tsx. */
const built = join(root, "dist/cli.js");
const hoopArgs = existsSync(built) ? [built] : [tsx, cli];

/** The pages process and MCP client of the sample running now, which a signal stops before the benchmark exits. */
let current: ChildProcess | undefined;
let currentClient: { close: () => Promise<void> } | undefined;
let currentFolders: string[] = [];
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    // The client first: its `hoop mcp` process would start the pages again if they stopped under it.
    void Promise.allSettled([currentClient?.close()]).then(() => {
      current?.kill();
      for (const dir of currentFolders) rmSync(dir, { recursive: true, force: true });
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  });

/** Stops `child` and waits until it has exited. */
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await exited;
}

/** One sample of each measure, in fresh folders with their own pages process; it stops it and removes them. */
async function sample(delay: number): Promise<Record<Measure, number>> {
  const folders = { HOOP_HOME: runHome("hoop-bench-home-"), HOOP_REPO_DIR: runHome("hoop-bench-repo-"), HOOP_CLAUDE_DIR: runHome("hoop-bench-claude-") };
  currentFolders = Object.values(folders);
  const port = await portFrom();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...(process.env as Record<string, string>),
    ...folders,
    // A session of its own, never the one that runs the benchmark.
    CLAUDE_CODE_SESSION_ID: "bench-session-0000",
    HOOP_PORT: String(port),
    HOOP_NO_BROWSER: "1",
  };
  const started = performance.now();
  const pages = spawn(process.execPath, [...hoopArgs, "serve"], { env: { ...env, HOOP_PAGES: "background" }, stdio: "ignore" });
  current = pages;
  try {
    let cold: number | undefined;
    for (const end = Date.now() + 20_000; cold === undefined && Date.now() < end; ) {
      const info = (await fetch(`${base}/api/info`).then(
        (r) => r.json(),
        () => undefined,
      )) as { hoop?: string; store?: string } | undefined;
      if (info?.hoop === "pages" && info.store === storeKey(folders.HOOP_HOME)) cold = performance.now() - started;
      else await sleep(10);
    }
    if (cold === undefined) throw new Error(`the pages process didn't answer on port ${port} within 20 seconds`);

    const { client, call } = await connectMcp(env);
    currentClient = client;
    try {
      const { review_id: id } = await call("hoop_submit", {
        markdown: "# Bench: time the loop\n\nA review to time the page and hoop_wait on.\n\n## Plan\n\nOne step.\n",
      });
      const t0 = performance.now();
      await Promise.all([fetch(`${base}/r/${id}`).then((r) => r.text()), fetch(`${base}/api/reviews/${id}`).then((r) => r.json())]);
      const page = performance.now() - t0;

      const waiting = call("hoop_wait", { review_id: id, seconds: 30 });
      await sleep(delay);
      const sent = performance.now();
      const res = await fetch(`${base}/api/reviews/${id}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict: "approved", comments: [] }),
      });
      if (!res.ok) throw new Error(`the verdict was refused: ${res.status} ${await res.text()}`);
      const got = (await waiting) as { approved?: boolean };
      const wait = performance.now() - sent;
      if (!got.approved) throw new Error(`hoop_wait returned without the approval: ${JSON.stringify(got).slice(0, 200)}`);
      return { "cold start": cold, "page ready": page, hoop_wait: wait };
    } finally {
      await client.close();
      currentClient = undefined;
    }
  } finally {
    await stop(pages);
    current = undefined;
    for (const dir of Object.values(folders)) rmSync(dir, { recursive: true, force: true });
    currentFolders = [];
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const o = benchOptions(process.argv.slice(2));
  const samples: Record<Measure, number[]> = { "cold start": [], "page ready": [], hoop_wait: [] };
  for (let n = 1; n <= o.samples; n++) {
    if (!o.json) process.stdout.write(`• sample ${n}/${o.samples}\n`);
    const s = await sample(VERDICT_DELAY_MS);
    for (const k of Object.keys(samples) as Measure[]) samples[k].push(s[k]);
  }
  const rows = summarize(samples);
  const from = hoopArgs[0] === built ? "from the build (dist/)" : "from the sources, through tsx (run npm run build to time the build)";
  process.stdout.write(o.json ? `${JSON.stringify({ from, rows }, null, 1)}\n` : `${table(rows, from)}\n`);
  process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
  // scripts/lib.ts made a hoop folder and a Claude Code folder for the run when it loaded; they go too.
  for (const dir of [process.env.HOOP_HOME, process.env.HOOP_CLAUDE_DIR])
    if (dir && /[/\\]hoop-e2e-[^/\\]+$/.test(dir)) rmSync(dir, { recursive: true, force: true });
}
