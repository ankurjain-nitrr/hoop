import { hookFields } from "./hook-input.js";
import { decisionOutput, hasResult, isOn, openCall, PERMISSION_PROMPTS, readPermission } from "./permissions.js";
import { isRecord } from "./util.js";

// `hoop permission-hook`, Claude Code's PermissionRequest hook while permission prompts are on: it
// records the prompt through the pages process, then waits for the first answer. An answer on a
// page becomes the hook's decision; an answer in the terminal, which still asks, shows as the call's
// result in the session's transcript, and the hook ends with no decision. When it stops waiting
// first, it hands the prompt to the terminal. It never decides by itself.

/** What the hook needs from the pages process: its writes. */
type Writer = { post(action: string, body: Record<string, unknown>): Promise<unknown> };

export type HookOptions = {
  home: string;
  remote: Writer;
  /** How long to wait for an answer before handing the prompt to the terminal. */
  waitMs: number;
  pollMs?: number;
  /** Called with a function that hands the prompt to the terminal, for the process to run on a signal. */
  onStop?: (stop: () => Promise<void>) => void;
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Records the prompt through the pages process; its ID, or undefined when no pages process took it. */
async function ask(remote: Writer, input: unknown): Promise<string | undefined> {
  try {
    const out = await remote.post("permission_ask", { input });
    return isRecord(out) && typeof out.id === "string" ? out.id : undefined;
  } catch {
    return undefined;
  }
}

/** The prompt's call, in the session's transcript, and whether it has its result: the terminal answered. */
function terminalWatch(transcript: string | undefined, tool: string, input: Record<string, unknown>) {
  let call = transcript ? openCall(transcript, tool, input) : undefined;
  return () => {
    if (!transcript) return false;
    call ??= openCall(transcript, tool, input);
    return Boolean(call && hasResult(transcript, call));
  };
}

/** The hook's decision for one PermissionRequest input, or undefined to leave it to the terminal. */
export async function permissionHook(input: unknown, o: HookOptions): Promise<Record<string, unknown> | undefined> {
  if (!isOn(o.home, PERMISSION_PROMPTS)) return undefined;
  const f = hookFields(input);
  if (f.event !== "PermissionRequest" || !f.session || !f.tool) return undefined;
  const id = await ask(o.remote, input);
  if (!id) return undefined;
  const settle = async (how: "terminal" | "handed") => {
    try {
      await o.remote.post("permission_settle", { id, how });
    } catch {
      /* the page shows it waiting until the pages process hears */
    }
  };
  o.onStop?.(() => settle("terminal"));
  const answeredInTerminal = terminalWatch(f.transcript, f.tool, f.toolInput);
  for (const end = Date.now() + o.waitMs; Date.now() < end; await pause(o.pollMs ?? 500)) {
    const p = readPermission(o.home, id);
    const out = decisionOutput(p);
    if (out) return out;
    if (p?.state !== "waiting") return undefined;
    if (answeredInTerminal()) {
      await settle("terminal");
      return undefined;
    }
  }
  await settle("handed");
  return undefined;
}
