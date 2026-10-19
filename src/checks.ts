import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

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
  // Only absolute folders count, so an entry never depends on where hoop happens to run.
  return entries.some((e: { repo?: unknown; command?: unknown }) =>
    typeof e?.repo === "string" && isAbsolute(e.repo) && realPath(e.repo) === here && isArgs(e.command) && sameArgs(e.command, command));
}

/**
 * Findings from a check's output: only `path:line: message` lines count, so snippet and summary
 * lines are ignored. Findings reported with no such line become one finding without a line.
 */
export function parseFindings(output: string, exitCode: number): Finding[] {
  const findings: Finding[] = [];
  for (const raw of output.split(/\r?\n/)) {
    // `path:line: message`, or `path:line:column: message`; lines count from 1.
    const m = raw.match(/^(\S.*?):(\d+)(?::\d+)?: (.+)$/);
    if (m && Number(m[2]) >= 1) findings.push({ line: Number(m[2]), message: m[3]!.trim() });
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
  const timeout = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const started = Date.now();
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "hoop-check-"));
    const file = join(dir, "document.md");
    writeFileSync(file, markdown);
    const run = await spawnChecked(command, file, repo, timeout);
    const ms = Date.now() - started;
    if (run.timedOut) return { ran: false, reason: "timeout", message: `The check took longer than ${timeout / 1000} seconds.`, command, findings: [], ms };
    if (run.error) return { ran: false, reason: "failed", message: `The check didn't run, because it couldn't start (${run.error}).`, command, findings: [], ms };
    if (run.code === 0 || run.code === 1) return { ran: true, command, findings: parseFindings(`${run.stdout}\n${run.stderr}`, run.code), ms };
    const why = run.signal ? `it stopped on ${run.signal}` : `it exited with code ${run.code}`;
    const detail = run.stderr.trim().split(/\r?\n/)[0];
    return { ran: false, reason: "failed", message: `The check didn't run, because ${why}.${detail ? ` ${detail}` : ""}`, command, findings: [], ms };
  } catch (err) {
    return { ran: false, reason: "failed", message: `The check didn't run: ${(err as Error).message}`, command, findings: [], ms: Date.now() - started };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** Output kept from a check; a checker that prints more is cut off, and its findings so far are kept. */
const MAX_OUTPUT = 1024 * 1024;

/**
 * Runs the command with the file as its last argument, without a shell. At the timeout it stops the
 * whole process group, first gently and then for good, and settles at once, so a checker that
 * ignores signals can't keep hoop waiting.
 */
function spawnChecked(command: string[], file: string, cwd: string, timeout: number):
  Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", done = false, timedOut = false;
    const child = spawn(command[0]!, [...command.slice(1), file], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (prev: string, chunk: Buffer) => (prev.length < MAX_OUTPUT ? (prev + chunk.toString("utf8")).slice(0, MAX_OUTPUT) : prev);
    child.stdout.on("data", (c: Buffer) => { stdout = keep(stdout, c); });
    child.stderr.on("data", (c: Buffer) => { stderr = keep(stderr, c); });
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already gone */ }
    };
    const finish = (r: { code: number | null; signal: string | null; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(soft);
      clearTimeout(hard);
      resolve({ ...r, stdout, stderr, timedOut });
    };
    const soft = setTimeout(() => { timedOut = true; kill("SIGTERM"); }, timeout);
    const hard = setTimeout(() => { kill("SIGKILL"); finish({ code: null, signal: "SIGKILL" }); }, timeout + 1000);
    child.on("error", (err: NodeJS.ErrnoException) => finish({ code: null, signal: null, error: err.code ?? err.message }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}
