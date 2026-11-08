// Process helpers for hoop's scripts and tests: free ports, pauses, and stopping a child process.
import type { ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";

/** A port that was free on 127.0.0.1 a moment ago. */
export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stops `child` and waits until it has exited. */
export async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await exited;
}
