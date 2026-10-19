import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A finding from the project's check command. `line` is the document's source line, from 1. */
export type Finding = { line?: number; message: string; place?: { item: string; line: number } };
export type CheckReason = "not_allowed" | "failed" | "timeout" | "running" | "stopped";
/**
 * What happened when hoop checked a document. A check that ran has its command and findings; one
 * that didn't says why. `allow` is the entry a user adds to allow the command, for the agent only.
 */
export type CheckOutcome = {
  ran: boolean;
  reason?: CheckReason;
  message?: string;
  command?: string[];
  allow?: { repo: string; command: string[] };
  findings: Finding[];
  ms?: number;
  started?: string;
};

export const CHECK_TIMEOUT_MS = 10_000;
const REPO_CONFIG = "hoop.config.json";

const readJson = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
};
const realPath = (p: string): string | undefined => {
  try { return realpathSync.native(p); } catch { return undefined; }
};
const isArgs = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0);
const sameArgs = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The check command a repository sets in its `hoop.config.json`, or undefined. */
export function repoCommand(repo: string): string[] | undefined {
  const check = (readJson(join(repo, REPO_CONFIG)) as { check?: unknown } | undefined)?.check;
  return isArgs(check) ? check : undefined;
}

/** Whether the user's own config, in the hoop folder `home`, allows exactly this command for this folder. */
export function isAllowed(repo: string, command: string[], home: string): boolean {
  const entries = (readJson(join(home, "config.json")) as { checks?: unknown } | undefined)?.checks;
  const here = realPath(repo);
  if (!here || !Array.isArray(entries)) return false;
  return entries.some((e: { repo?: unknown; command?: unknown }) =>
    typeof e?.repo === "string" && realPath(e.repo) === here && isArgs(e.command) && sameArgs(e.command, command));
}

/**
 * Findings from a check's output: only `path:line: message` lines count, so snippet and summary
 * lines are ignored. Findings reported with no such line become one finding without a line.
 */
export function parseFindings(output: string, exitCode: number): Finding[] {
  const findings: Finding[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = raw.match(/^(\S.*?):(\d+): (.+)$/);
    if (m) findings.push({ line: Number(m[2]), message: m[3]!.trim() });
  }
  if (!findings.length && exitCode === 1) {
    const first = output.split(/\r?\n/).find((l) => l.trim());
    findings.push({ message: first?.trim() || "The check reported problems but printed no finding lines." });
  }
  return findings;
}

/**
 * Checks a markdown document with the repository's command, when the user allows it. The command
 * runs without a shell, in `repo`, with the document's path as its last argument. Exit 0 means no
 * findings and exit 1 means findings; anything else, or a timeout, means the check didn't run.
 * Returns undefined when the repository sets no command. It never throws.
 */
export async function runCheck(repo: string, markdown: string, home: string, opts: { timeoutMs?: number } = {}): Promise<CheckOutcome | undefined> {
  const command = repoCommand(repo);
  if (!command) return undefined;
  if (!isAllowed(repo, command, home)) {
    const allow = { repo: realPath(repo) ?? repo, command };
    return {
      ran: false, reason: "not_allowed", findings: [], allow,
      message: `This repository's check command isn't allowed yet. Ask the user to add this entry to "checks" in ${join(home, "config.json")}: ${JSON.stringify(allow)}`,
    };
  }
  const dir = mkdtempSync(join(tmpdir(), "hoop-check-"));
  const file = join(dir, "document.md");
  writeFileSync(file, markdown);
  const timeout = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const started = Date.now();
  try {
    const run = await new Promise<{ code: number | string | null; signal?: string | null; stdout: string; stderr: string; killed?: boolean }>((resolve) => {
      execFile(command[0]!, [...command.slice(1), file], { cwd: repo, timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
        resolve({ code: e ? (e.code ?? null) : 0, signal: e?.signal, killed: e?.killed, stdout: stdout ?? "", stderr: stderr ?? "" });
      });
    });
    const ms = Date.now() - started;
    if (run.killed && ms >= timeout) return { ran: false, reason: "timeout", message: `The check took longer than ${timeout / 1000} seconds.`, command, findings: [], ms };
    if (run.code === 0 || run.code === 1) return { ran: true, command, findings: parseFindings(run.stdout, run.code), ms };
    const why = typeof run.code === "string" ? `it couldn't start (${run.code})` : run.signal ? `it stopped on ${run.signal}` : `it exited with code ${run.code}`;
    const detail = run.stderr.trim().split(/\r?\n/)[0];
    return { ran: false, reason: "failed", message: `The check didn't run, because ${why}.${detail ? ` ${detail}` : ""}`, command, findings: [], ms };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
