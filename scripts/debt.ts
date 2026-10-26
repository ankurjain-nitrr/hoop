// The debt ratchet: counts import cycles (dependency-cruiser), unused code (knip), complex code
// (Biome's complexity rules), loosely typed code (type-coverage) and duplicated code (jscpd), and compares them with debt-baseline.json. It exits 1 when a count
// grew, and also when one fell, so the baseline records every improvement and can't grow back.
// `--update` writes the current counts to the baseline instead.
// Usage: tsx scripts/debt.ts [--update]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Counts = Record<string, number>;

const root = fileURLToPath(new URL("..", import.meta.url));
const BASELINE = `${root}debt-baseline.json`;
const SOURCES = ["src", "web", "scripts"];

/** Knip's issue lists, grouped into the counts the baseline keeps. */
const KNIP_GROUPS: Record<string, string[]> = {
  unusedFiles: ["files"],
  unusedExports: ["exports", "nsExports", "types", "nsTypes", "enumMembers", "duplicates"],
  dependencyIssues: ["dependencies", "devDependencies", "unlisted", "binaries"],
};

const BIOME_RULES: Record<string, string> = {
  complexFunctions: "complexity/noExcessiveCognitiveComplexity",
  nestedTernaries: "style/noNestedTernary",
};

/** Runs a tool from node_modules; these tools exit 1 when they find something, so the status is ignored. */
function run(args: string[]) {
  return spawnSync("npx", ["--no-install", ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** A tool's JSON output. */
function json(args: string[]): any {
  const r = run(args);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${args[0]} printed no JSON (exit ${r.status}): ${r.stderr.trim().slice(0, 500)}`);
  }
}

/** The counts for the repository as it is now. */
export function measure(): Counts {
  const counts: Counts = {};
  const cruise = json(["depcruise", ...SOURCES, "--output-type", "json"]);
  counts.importCycles = cruise.summary.violations.filter((v: any) => v.rule.name === "no-circular").length;
  const knip = json(["knip", "--no-progress", "--reporter", "json"]);
  for (const [name, keys] of Object.entries(KNIP_GROUPS)) {
    counts[name] = knip.issues.reduce((n: number, issue: any) => n + keys.reduce((m, k) => m + sizeOf(issue[k]), 0), 0);
  }
  if (Array.isArray(knip.files)) counts.unusedFiles += knip.files.length;
  const only = Object.values(BIOME_RULES).map((r) => `--only=${r}`);
  const lint = json(["biome", "lint", ...only, "--max-diagnostics=none", "--reporter=json", ...SOURCES]);
  for (const [name, rule] of Object.entries(BIOME_RULES)) {
    counts[name] = lint.diagnostics.filter((d: any) => d.category === `lint/${rule}`).length;
  }
  const types = json(["type-coverage", "-p", "tsconfig.json", "--strict", "--json-output"]);
  counts.looselyTyped = types.totalCount - types.correctCount;
  const out = mkdtempSync(join(tmpdir(), "hoop-jscpd-"));
  try {
    run(["jscpd", ...SOURCES, "--min-tokens", "60", "--ignore", "web/vendor/**", "--reporters", "json", "--output", out, "--silent"]);
    counts.duplicatedLines = JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8")).statistics.total.duplicatedLines;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  return counts;
}

/** Knip lists an issue either as an array or as an object keyed by name. */
function sizeOf(list: unknown): number {
  if (Array.isArray(list)) return list.length;
  return list && typeof list === "object" ? Object.keys(list).length : 0;
}

/** The counts that grew and the ones that fell since `baseline`; a count new to the baseline grew. */
export function compare(baseline: Counts, now: Counts): { worse: string[]; better: string[] } {
  const worse: string[] = [];
  const better: string[] = [];
  for (const [name, n] of Object.entries(now)) {
    const was = baseline[name];
    if (was === undefined || n > was) worse.push(`${name}: ${was ?? "none"} → ${n}`);
    else if (n < was) better.push(`${name}: ${was} → ${n}`);
  }
  return { worse, better };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const now = measure();
  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
    console.log(`Wrote ${JSON.stringify(now)} to debt-baseline.json`);
  } else {
    const { worse, better } = compare(JSON.parse(readFileSync(BASELINE, "utf8")), now);
    for (const line of worse) console.error(`More debt: ${line}`);
    for (const line of better) console.error(`Less debt: ${line}. Record it with \`npm run debt -- --update\` and commit debt-baseline.json.`);
    if (worse.length) console.error("Run the tool for the count that grew (depcruise, knip, biome lint, type-coverage --detail or jscpd) to see what to fix.");
    if (!worse.length && !better.length) console.log(`No new debt: ${JSON.stringify(now)}`);
    process.exit(worse.length || better.length ? 1 : 0);
  }
}
