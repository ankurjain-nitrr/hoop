// The debt check: counts runtime import cycles (dependency-cruiser), unused code (knip), complex
// code (Biome's complexity rules), loose typing in src (type-coverage), duplicated code (jscpd) and
// comments that hide code from those tools, here and at a base commit, and exits 1 when a count is
// higher here. The base is measured in a temporary worktree, so there is no baseline file to keep
// up to date, and debt paid off anywhere lowers the bar for everyone. `--base` defaults to where
// this branch left origin/main; CI passes HEAD^1, the base branch for a pull request's merge commit
// and the previous commit on main.
// Usage: tsx scripts/debt.ts [--base <ref>]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type Counts = Record<string, number>;

const root = fileURLToPath(new URL("..", import.meta.url));
const SOURCES = ["src", "web", "scripts"];
const TOOL_TIMEOUT_MS = 180_000;

/** Knip 6's issue lists, grouped into the counts. */
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

/** The counts that are higher `now` than at `base`, and the ones that are lower. */
export function compare(base: Counts, now: Counts): { worse: string[]; better: string[] } {
  const worse: string[] = [];
  const better: string[] = [];
  for (const [name, n] of Object.entries(now)) {
    const was = base[name] ?? 0;
    if (n > was) worse.push(`${name}: ${was} → ${n}`);
    else if (n < was) better.push(`${name}: ${was} → ${n}`);
  }
  return { worse, better };
}

/** Whether the dependencies differ from the base's, so the base needs its own node_modules. */
export function dependenciesChanged(changed: string[]): boolean {
  return changed.some((f) => f === "package.json" || f === "package-lock.json");
}

/**
 * The counts at a git ref, in a temporary worktree. It shares this checkout's node_modules unless
 * the dependencies differ, since tools measure code against the packages it imports.
 */
function measureAt(ref: string): Counts {
  const dir = mkdtempSync(join(tmpdir(), "hoop-debt-base-"));
  try {
    const add = git("worktree", "add", "--detach", dir, ref);
    if (add.status !== 0) throw new Error(`Couldn't check out ${ref}: ${add.stderr.trim()}`);
    if (dependenciesChanged(lines(git("diff", "--name-only", ref, "--", "package.json", "package-lock.json").stdout))) {
      const install = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, encoding: "utf8", timeout: TOOL_TIMEOUT_MS });
      if (install.status !== 0) throw new Error(`npm ci failed: ${(install.stderr || install.error?.message || "").trim().slice(0, 500)}`);
    } else {
      symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "junction");
    }
    return checkCounts(measure(dir));
  } catch (e) {
    throw new Error(`Measuring ${ref}: ${(e as Error).message}`);
  } finally {
    git("worktree", "remove", "--force", dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(...args: string[]) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

function lines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

/** The commit to compare with: `ref`, or where this branch left origin/main. */
function baseCommit(ref: string | undefined): string {
  const r = ref ? git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`) : git("merge-base", "HEAD", "origin/main");
  if (r.status !== 0) throw new Error(ref ? `--base: no commit ${ref}` : "No origin/main to compare with; fetch it or pass --base <ref>");
  return r.stdout.trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: args } = parseArgs({ options: { base: { type: "string" } } });
  const ref = baseCommit(args.base);
  const base = measureAt(ref);
  const now = checkCounts(measure());
  const { worse, better } = compare(base, now);
  for (const line of worse) console.error(`More debt than ${ref.slice(0, 7)}: ${line}`);
  for (const line of better) console.log(`Less debt than ${ref.slice(0, 7)}: ${line}`);
  if (worse.length)
    console.error(
      "Run the tool for the count that grew (depcruise, knip, biome lint, type-coverage --detail or jscpd; grep for suppressions) to see what to fix.",
    );
  else console.log(`No new debt: ${JSON.stringify(now)}`);
  process.exit(worse.length ? 1 : 0);
}
