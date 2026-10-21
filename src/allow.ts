import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { isAllowed, repoCommand } from "./checks.js";
import { updateHoopConfig } from "./util.js";

export type AllowOutcome = { status: "allowed" | "already" | "declined" | "none" | "refused"; message: string };

/** Asks a yes or no question on the terminal; only a person at a terminal can answer it. */
async function askTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * Shows the check command `repo` declares and, once the person confirms, allows it in their own
 * settings in the hoop folder `home`. Without a terminal it refuses, so an agent can't allow a
 * command on the person's behalf. Declining changes nothing.
 */
export async function allowCheck(
  repo: string,
  home: string,
  opts: { ask?: (question: string) => Promise<boolean>; terminal?: boolean } = {},
): Promise<AllowOutcome> {
  const command = repoCommand(repo);
  if (!command) return { status: "none", message: "This repository declares no check command in hoop.config.json." };
  if (isAllowed(repo, command, home)) return { status: "already", message: `This repository's check is already allowed: ${JSON.stringify(command)}` };
  if (!(opts.terminal ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)))
    return { status: "refused", message: "hoop allow-check asks you to confirm, so run it yourself in a terminal." };
  const folder = realpathSync.native(repo);
  process.stdout.write(`This repository runs this check on every document it submits:\n\n  ${JSON.stringify(command)}\n\nin ${folder}\n\n`);
  const yes = await (opts.ask ?? askTerminal)("Allow it on this machine? [y/N] ");
  if (!yes) return { status: "declined", message: "Nothing changed. The check stays off." };
  updateHoopConfig(home, (config) => ({ ...config, checks: [...(Array.isArray(config.checks) ? config.checks : []), { repo: folder, command }] }));
  return { status: "allowed", message: "Allowed. The next submit runs the check." };
}
