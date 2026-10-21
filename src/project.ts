import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** What a project turns on for hoop's agent tools. */
export type ProjectSettings = { devloop: boolean };

/**
 * A project has devloop when its `hoop.config.json` says `"devloop": true`, or when it already holds
 * a change request folder in `docs/changes/`. A session reads this once, when it starts.
 */
export function projectSettings(repo: string): ProjectSettings {
  return { devloop: configSays(repo) || hasChanges(repo) };
}

function configSays(repo: string): boolean {
  try {
    return JSON.parse(readFileSync(join(repo, "hoop.config.json"), "utf8"))?.devloop === true;
  } catch {
    return false;
  }
}

function hasChanges(repo: string): boolean {
  const dir = join(repo, "docs", "changes");
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && /^CR-\d+-/.test(e.name));
  } catch {
    return false;
  }
}
