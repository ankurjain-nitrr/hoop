// The debt ratchet: counts runtime import cycles (dependency-cruiser), unused code (knip), complex
// code (Biome's complexity rules), loose typing in src (type-coverage) and duplicated code (jscpd),
// and compares them with debt-baseline.json. It exits 1 when a count grew, and also when one fell,
// so the baseline records every improvement and can't grow back. `--update` writes the current
// counts to the baseline instead. `--base <ref>` also fails when debt-baseline.json holds a count
// higher than <ref> has, so a pull request can't raise its own baseline: above <ref>'s baseline only
// as far as <ref> measures, when debt reached it unchecked, and only while the dependencies match
// <ref>'s, since <ref> is measured with this checkout's node_modules. `--allow-falls` only reports
// a fall: CI on main uses it, since two merged pull requests can each record the same fall.
// Comments that hide code from these tools count too (suppressions), so they can't be used to pass.
// Usage: tsx scripts/debt.ts [--update] [--base <ref>] [--allow-falls]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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
function run(args: string[], dir = root) {
  const r = spawnSync("npx", ["--no-install", ...args], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: TOOL_TIMEOUT_MS });
  if (r.error) throw new Error(`${args[0]} failed: ${r.error.message}`);
  return r;
}

/** A tool's JSON output. */
function json(args: string[], dir = root): any {
  const r = run(args, dir);
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

/** Diagnostics of each counted rule, from Biome's JSON reporter. Any other diagnostic, such as a path it couldn't read, fails. */
export function lintCounts(lint: any): Counts {
  const other = lint.diagnostics.filter((d: any) => !Object.values(BIOME_RULES).some((r) => d.category === `lint/${r}`));
  if (other.length) throw new Error(`biome lint reported ${other.map((d: any) => d.category).join(", ")}`);
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

/** Comments that hide code from the counting tools, or from the type checker and Semgrep. */
const SUPPRESSION = /biome-ignore|type-coverage:ignore|jscpd:ignore|@ts-ignore|@ts-expect-error|@ts-nocheck|@public\b|nosemgrep/g;

/** The suppression comments in a file's text. */
export function suppressionCount(text: string): number {
  return text.match(SUPPRESSION)?.length ?? 0;
}

/** Suppression comments in the sources; this file names them all, so it's left out. */
function suppressions(at: string): Counts {
  const files = SOURCES.flatMap((dir) => readdirSync(join(at, dir), { recursive: true, encoding: "utf8" }).map((f) => join(dir, f)));
  const counted = files.filter((f) => /\.(ts|js|mjs|cjs)$/.test(f) && f !== join("scripts", "debt.ts"));
  return { suppressions: counted.reduce((n, f) => n + suppressionCount(readFileSync(join(at, f), "utf8")), 0) };
}

/** The counts for the checkout at `dir`, by default this one as it is now. */
export function measure(dir = root): Counts {
  const only = Object.values(BIOME_RULES).map((r) => `--only=${r}`);
  const counts = {
    ...cruiseCounts(json(["depcruise", ...SOURCES, "--output-type", "json"], dir)),
    ...knipCounts(json(["knip", "--no-progress", "--reporter", "json"], dir)),
    ...lintCounts(json(["biome", "lint", ...only, "--max-diagnostics=none", "--reporter=json", ...SOURCES], dir)),
    // src only (tsconfig.build.json). hoop allows non-null assertions, so they don't count.
    ...typeCounts(json(["type-coverage", "-p", "tsconfig.build.json", "--strict", "--ignore-non-null-assertion", "--json-output"], dir)),
    ...suppressions(dir),
  };
  const out = mkdtempSync(join(tmpdir(), "hoop-jscpd-"));
  try {
    const r = run(["jscpd", ...SOURCES, "--min-tokens", "60", "--ignore", "web/vendor/**", "--reporters", "json", "--output", out, "--silent"], dir);
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

/** Per count, the higher of `a` and `b`: how high a pull request may set the baseline. */
export function ceiling(a: Counts, b: Counts): Counts {
  return Object.fromEntries(Object.entries(a).map(([name, n]) => [name, Math.max(n, b[name] ?? n)]));
}

/** Whether a base can be measured with this checkout's node_modules: not when the change touches the dependencies. */
export function sameDependencies(changed: string[]): boolean {
  return !changed.some((f) => f === "package.json" || f === "package-lock.json");
}

/** The counts for a git ref, measured in a temporary worktree that shares this one's node_modules. */
function measureAt(ref: string): Counts {
  const dir = mkdtempSync(join(tmpdir(), "hoop-debt-base-"));
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    const add = git("worktree", "add", "--detach", dir, ref);
    if (add.status !== 0) throw new Error(`Couldn't check out ${ref}: ${add.stderr.trim()}`);
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "junction");
    return checkCounts(measure(dir));
  } catch (e) {
    throw new Error(`Measuring ${ref}: ${(e as Error).message}`);
  } finally {
    git("worktree", "remove", "--force", dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The baseline at a git ref, or null where it has none yet. A ref git doesn't know fails. */
function baselineAt(ref: string): Counts | null {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).status !== 0) throw new Error(`--base: no commit ${ref}`);
  const r = git("show", `${ref}:debt-baseline.json`);
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: args } = parseArgs({ options: { update: { type: "boolean" }, base: { type: "string" }, "allow-falls": { type: "boolean" } } });
  const base = args.base ? baselineAt(args.base) : null;
  const now = checkCounts(measure());
  if (args.update) {
    writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
    console.log(`Wrote ${JSON.stringify(now)} to debt-baseline.json`);
  } else {
    const { worse, better } = compare(JSON.parse(readFileSync(BASELINE, "utf8")), now);
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
    // Measuring the base takes as long again, so only when the baseline was raised.
    let up = base ? raised(base, baseline) : [];
    if (base && up.length && args.base) {
      const changed = spawnSync("git", ["diff", "--name-only", args.base, "HEAD"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
      if (sameDependencies(changed)) up = raised(ceiling(base, measureAt(args.base)), baseline);
      else console.error("This change touches package.json or package-lock.json, so the baseline can't be raised in it; land the dependency change first.");
    }
    const failOnFalls = !args["allow-falls"];
    for (const line of up) console.error(`debt-baseline.json raised above what ${args.base} has: ${line}. Remove the debt instead.`);
    for (const line of worse) console.error(`More debt: ${line}`);
    for (const line of better) console.error(`Less debt: ${line}. Record it with \`npm run debt -- --update\` and commit debt-baseline.json.`);
    if (worse.length)
      console.error(
        "Run the tool for the count that grew (depcruise, knip, biome lint, type-coverage --detail or jscpd; grep for suppressions) to see what to fix.",
      );
    if (!worse.length && !better.length && !up.length) console.log(`No new debt: ${JSON.stringify(now)}`);
    process.exit(worse.length || up.length || (failOnFalls && better.length) ? 1 : 0);
  }
}
