// The debt ratchet: counts runtime import cycles (dependency-cruiser), unused code (knip), complex
// code (Biome's complexity rules), loose typing in src (type-coverage) and duplicated code (jscpd),
// and compares them with debt-baseline.json. It exits 1 when a count grew, and also when one fell,
// so the baseline records every improvement and can't grow back. `--update` writes the current
// counts to the baseline instead. `--base <ref>` also fails when debt-baseline.json holds a count
// higher than at <ref>, so a pull request can't raise its own baseline. `--allow-falls` only reports
// a fall: CI on main uses it, since two merged pull requests can each record the same fall.
// Usage: tsx scripts/debt.ts [--update] [--base <ref>] [--allow-falls]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Counts = Record<string, number>;

const root = fileURLToPath(new URL("..", import.meta.url));
const BASELINE = `${root}debt-baseline.json`;
const SOURCES = ["src", "web", "scripts"];
const TOOL_TIMEOUT_MS = 180_000;

/** Knip 6's issue lists, grouped into the counts the baseline keeps. */
const KNIP_GROUPS: Record<string, string[]> = {
  unusedFiles: ["files"],
  unusedExports: ["exports", "types", "enumMembers", "duplicates", "namespaceMembers"],
  dependencyIssues: ["dependencies", "devDependencies", "optionalPeerDependencies", "unlisted", "unresolved", "binaries", "catalog", "catalogReferences"],
};
const KNIP_OTHER_KEYS = ["file", "owners"];

const BIOME_RULES: Record<string, string> = {
  complexFunctions: "complexity/noExcessiveCognitiveComplexity",
  nestedTernaries: "style/noNestedTernary",
};

/** Runs a tool from node_modules. These tools exit 1 when they find something, so the status is ignored. */
function run(args: string[]) {
  const r = spawnSync("npx", ["--no-install", ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: TOOL_TIMEOUT_MS });
  if (r.error) throw new Error(`${args[0]} failed: ${r.error.message}`);
  return r;
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

/** Imports that close a cycle of runtime imports, from dependency-cruiser's JSON. */
export function cruiseCounts(cruise: any): Counts {
  return { cyclicImports: cruise.summary.violations.filter((v: any) => v.rule.name === "no-circular").length };
}

/** Knip's issues by group. An issue list this doesn't know fails, rather than going uncounted. */
export function knipCounts(knip: any): Counts {
  const known = new Set([...Object.values(KNIP_GROUPS).flat(), ...KNIP_OTHER_KEYS]);
  for (const issue of knip.issues) {
    const unknown = Object.keys(issue).filter((k) => !known.has(k));
    if (unknown.length) throw new Error(`knip reported issue lists scripts/debt.ts doesn't count: ${unknown.join(", ")}`);
  }
  const counts: Counts = {};
  for (const [name, keys] of Object.entries(KNIP_GROUPS)) {
    counts[name] = knip.issues.reduce((n: number, issue: any) => n + keys.reduce((m, k) => m + sizeOf(issue[k]), 0), 0);
  }
  return counts;
}

/** Knip lists an issue either as an array or as an object keyed by name. */
function sizeOf(list: unknown): number {
  if (Array.isArray(list)) return list.length;
  return list && typeof list === "object" ? Object.keys(list).length : 0;
}

/** Diagnostics of each counted rule, from Biome's JSON reporter. */
export function lintCounts(lint: any): Counts {
  return Object.fromEntries(
    Object.entries(BIOME_RULES).map(([name, rule]) => [name, lint.diagnostics.filter((d: any) => d.category === `lint/${rule}`).length]),
  );
}

/** Identifiers typed `any` and type assertions, from type-coverage's JSON. */
export function typeCounts(types: any): Counts {
  return { looselyTyped: types.totalCount - types.correctCount };
}

/** Duplicated lines, from jscpd's JSON report. */
export function jscpdCounts(report: any): Counts {
  return { duplicatedLines: report.statistics.total.duplicatedLines };
}

/** The counts for the repository as it is now. */
export function measure(): Counts {
  const only = Object.values(BIOME_RULES).map((r) => `--only=${r}`);
  const counts = {
    ...cruiseCounts(json(["depcruise", ...SOURCES, "--output-type", "json"])),
    ...knipCounts(json(["knip", "--no-progress", "--reporter", "json"])),
    ...lintCounts(json(["biome", "lint", ...only, "--max-diagnostics=none", "--reporter=json", ...SOURCES])),
    // src only (tsconfig.build.json). hoop allows non-null assertions, so they don't count.
    ...typeCounts(json(["type-coverage", "-p", "tsconfig.build.json", "--strict", "--ignore-non-null-assertion", "--json-output"])),
  };
  const out = mkdtempSync(join(tmpdir(), "hoop-jscpd-"));
  try {
    const r = run(["jscpd", ...SOURCES, "--min-tokens", "60", "--ignore", "web/vendor/**", "--reporters", "json", "--output", out, "--silent"]);
    let report: any;
    try {
      report = JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8"));
    } catch {
      throw new Error(`jscpd wrote no report (exit ${r.status}): ${r.stderr.trim().slice(0, 500)}`);
    }
    return { ...counts, ...jscpdCounts(report) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Fails unless every count is a whole number, so a tool whose output changed can't pass unchecked. */
export function checkCounts(counts: Counts): Counts {
  const bad = Object.entries(counts).filter(([, n]) => !Number.isInteger(n) || n < 0);
  if (bad.length) throw new Error(`Couldn't read ${bad.map(([k, n]) => `${k} (${n})`).join(", ")}; did a tool's output change?`);
  return counts;
}

/** The counts that grew and the ones that fell since `baseline`. A count only one side has is worse. */
export function compare(baseline: Counts, now: Counts): { worse: string[]; better: string[] } {
  const worse: string[] = [];
  const better: string[] = [];
  for (const name of new Set([...Object.keys(baseline), ...Object.keys(now)])) {
    const was = baseline[name];
    const n = now[name];
    if (n === undefined) worse.push(`${name}: no longer measured; run \`npm run debt -- --update\` if that's deliberate`);
    else if (was === undefined || n > was) worse.push(`${name}: ${was ?? "none"} → ${n}`);
    else if (n < was) better.push(`${name}: ${was} → ${n}`);
  }
  return { worse, better };
}

/** The counts `baseline` raised above `base`, the baseline the pull request started from. */
export function raised(base: Counts, baseline: Counts): string[] {
  return Object.entries(baseline)
    .filter(([name, n]) => base[name] !== undefined && n > base[name])
    .map(([name, n]) => `${name}: ${base[name]} → ${n}`);
}

/** The baseline at a git ref, or null where it has none yet. */
function baselineAt(ref: string): Counts | null {
  const r = spawnSync("git", ["show", `${ref}:debt-baseline.json`], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const now = checkCounts(measure());
  if (args.includes("--update")) {
    writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
    console.log(`Wrote ${JSON.stringify(now)} to debt-baseline.json`);
  } else {
    const { worse, better } = compare(JSON.parse(readFileSync(BASELINE, "utf8")), now);
    const ref = args.includes("--base") ? args[args.indexOf("--base") + 1] : undefined;
    const base = ref ? baselineAt(ref) : null;
    const up = base ? raised(base, JSON.parse(readFileSync(BASELINE, "utf8"))) : [];
    const failOnFalls = !args.includes("--allow-falls");
    for (const line of up) console.error(`debt-baseline.json raised above ${ref}: ${line}. Remove the debt instead.`);
    for (const line of worse) console.error(`More debt: ${line}`);
    for (const line of better) console.error(`Less debt: ${line}. Record it with \`npm run debt -- --update\` and commit debt-baseline.json.`);
    if (worse.length) console.error("Run the tool for the count that grew (depcruise, knip, biome lint, type-coverage --detail or jscpd) to see what to fix.");
    if (!worse.length && !better.length && !up.length) console.log(`No new debt: ${JSON.stringify(now)}`);
    process.exit(worse.length || up.length || (failOnFalls && better.length) ? 1 : 0);
  }
}
