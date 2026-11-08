import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { type NpmRunner, runNpm } from "./actions.js";
import { MARKETPLACE_NAME, PLUGIN } from "./init.js";
import { tryReadJson, writeJson } from "./util.js";
import { isNewer } from "./version.js";

// A new release of hoop: the pages process asks npm for the latest version at most once a day, keeps
// the answer in `update.json` under hoop's home, and Home says when it is newer than the running
// code, with the one command that updates. `hoop update` updates the package and the plugin.

export const PACKAGE = "@ankurjain-nitrr/hoop";
const DAY_MS = 24 * 60 * 60 * 1000;

type Cache = { checked_at: string; latest?: string };

const cacheFile = (home: string) => join(home, "update.json");

function readCache(home: string): Cache | undefined {
  const v = tryReadJson<Partial<Cache> | null>(cacheFile(home));
  if (!v || typeof v.checked_at !== "string") return undefined;
  return { checked_at: v.checked_at, ...(typeof v.latest === "string" ? { latest: v.latest } : {}) };
}

/** The one command Home shows: `hoop update`, or through npx when these pages run from npx's cache. */
export const updateCommand = (install: string) => (/[/\\]_npx[/\\]/.test(install) ? `npx -y ${PACKAGE}@latest update` : "hoop update");

/**
 * The pages process's check for a newer hoop. `available` answers from the kept answer, and asks npm
 * in the background when that is a day old or missing; a failed ask, as offline, keeps the last
 * answer and waits another day, and says nothing.
 */
export class UpdateCheck {
  private pending: Promise<void> | undefined;
  /** When this process last asked, so a home it can't write to doesn't make every poll ask again. */
  private askedAt: number | undefined;

  constructor(
    private home: string,
    private npm: NpmRunner = runNpm,
    private now = () => Date.now(),
  ) {}

  /** The newer release than `current`, when one is known. */
  available(current: string | undefined): string | undefined {
    const c = readCache(this.home);
    const checked = Math.max(c ? Date.parse(c.checked_at) || 0 : 0, this.askedAt ?? 0);
    if (!this.pending && !(this.now() - checked < DAY_MS)) {
      this.pending = this.check(c?.latest).finally(() => {
        this.pending = undefined;
      });
    }
    return c?.latest && isNewer(c.latest, current) ? c.latest : undefined;
  }

  /** Waits for a check that is running: for tests. */
  settled(): Promise<void> {
    return this.pending ?? Promise.resolve();
  }

  private async check(last: string | undefined) {
    this.askedAt = this.now();
    let latest = last;
    try {
      const out = (await this.npm(["view", PACKAGE, "version"])).trim();
      if (/^\d+\.\d+\.\d+$/.test(out)) latest = out;
    } catch {
      /* offline, or npm missing: keep the last answer */
    }
    try {
      writeJson(cacheFile(this.home), { checked_at: new Date(this.now()).toISOString(), ...(latest ? { latest } : {}) });
    } catch {
      /* hoop's home can't be written: ask again next time */
    }
  }
}

/** Runs a command with the terminal, and gives its exit status (null when it couldn't start). */
export type Runner = (cmd: string, args: string[]) => number | null;
const runInherit: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return r.error ? null : r.status;
};

/**
 * How hoop is installed globally with npm: from the registry (its package sits in `npm root -g`),
 * `linked` with `npm link` from a checkout (a symbolic link there, or a package that resolves outside
 * it), or not at all.
 */
export type Install = { kind: "registry" } | { kind: "linked"; at: string } | { kind: "none" };

/** How `root`, npm's global folder, holds hoop. */
export function installIn(root: string): Install {
  const dir = join(root, PACKAGE);
  try {
    if (!existsSync(join(dir, "package.json"))) return { kind: "none" };
    const at = realpathSync(dir);
    const inside = !relative(realpathSync(root), at).startsWith("..");
    return lstatSync(dir).isSymbolicLink() || !inside ? { kind: "linked", at } : { kind: "registry" };
  } catch {
    return { kind: "none" };
  }
}

function globalInstall(): Install {
  const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
  return !r.error && r.status === 0 ? installIn(r.stdout.trim()) : { kind: "none" };
}

const hasClaude = () => {
  const r = spawnSync("claude", ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
};

const line = (c: string[]) => c.join(" ");

/** Runs each command, saying it first; at a failure, says what is left to run. True when all ran. */
function runSteps(steps: string[][], run: Runner, out: (s: string) => void): boolean {
  for (const [i, c] of steps.entries()) {
    out(`hoop: ${line(c)}\n`);
    const status = run(c[0]!, c.slice(1));
    if (status === 0) continue;
    const rest = steps.slice(i);
    const code = status === null ? "" : ` (exit ${status})`;
    out(`hoop: that failed${code}. Run ${rest.length > 1 ? "these" : "it"} yourself:\n\n${list(rest)}`);
    return false;
  }
  return true;
}

/** What `hoop update` runs: npm for a global install, then claude for the plugin. */
const NPM_STEP = ["npm", "install", "-g", `${PACKAGE}@latest`];
const PLUGIN_STEPS = [
  ["claude", "plugin", "marketplace", "update", MARKETPLACE_NAME],
  ["claude", "plugin", "update", PLUGIN],
];
const list = (steps: string[][]) => steps.map((c) => `  ${line(c)}\n`).join("");

/** What `hoop update` says it can't update here, and why. */
function notes(install: Install, claude: boolean): string {
  const pkg = {
    registry: "",
    none: `hoop isn't installed with npm -g here, so there is no package to update; the plugin runs ${PACKAGE} at its own version.\n`,
    linked: `hoop is linked from ${install.kind === "linked" ? install.at : ""}; update it there with git pull && npm run build.\n`,
  }[install.kind];
  const noClaude = `claude isn't on PATH. To update the plugin, run:\n\n${list(PLUGIN_STEPS)}\n`;
  return pkg + (claude ? "" : noClaude);
}

/**
 * `hoop update`: updates the global package with npm, when hoop is installed that way, and the Claude
 * Code plugin with `claude`, which then runs the package of its new version. It prints the commands
 * first, then runs each, saying it; with `print` it only prints them. Returns the exit code: 1 when
 * a command failed or the plugin couldn't be updated.
 */
export function update(opts: { print?: boolean; out?: (s: string) => void; run?: Runner; install?: () => Install; claude?: () => boolean } = {}): number {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const install = (opts.install ?? globalInstall)();
  const claude = (opts.claude ?? hasClaude)();
  // A linked install is a checkout: npm install -g would replace it with the registry's copy.
  const steps = [...(install.kind === "registry" ? [NPM_STEP] : []), ...(claude ? PLUGIN_STEPS : [])];
  out(notes(install, claude));
  if (!steps.length) return 1;
  out(`hoop update ${opts.print ? "would run" : "runs"}:\n\n${list(steps)}\n`);
  if (opts.print) return 0;
  if (!runSteps(steps, opts.run ?? runInherit, out)) return 1;
  if (!claude) return 1;
  out("hoop: updated. Start a new Claude Code session to use the new plugin; the review pages restart into the new code on their own.\n");
  return 0;
}
