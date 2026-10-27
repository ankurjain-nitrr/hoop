import { Hoop, HoopError, type Place } from "./hoop.js";
import { type DoneLook, doneGate } from "./done.js";
import { stampHook } from "./hook-health.js";
import { checkInput, OPS } from "./ops.js";
import { type Agent, validSession } from "./owner.js";
import { savePlanCursor, submitPlan } from "./plan.js";
import { prHook } from "./prs.js";
import { gateOutput, workGate } from "./steer.js";
import { stopGate, stopOutput } from "./stop.js";
import type { Store } from "./store.js";
import { saveWaitMark } from "./wait.js";
import { workHook } from "./work.js";

// The pages process is the only process that writes hoop's files. Sessions and commands send it
// their writes at POST /api/write/<action>; these are the actions, run in the pages process.

/** The route's prefix, and the header that names the caller's store, so a write never lands in another store. */
export const WRITE_PATH = "/api/write/";
export const STORE_HEADER = "x-hoop-store";
/** The queue key every action item write runs under: the pages' Done and Won't do, checks and the agent's tools. */
export const ACTIONS_KEY = "actions";

/**
 * Runs writes one after another for each key (a review, a session's work record, a file), so two
 * requests that await in the middle of a write never interleave. Different keys run side by side.
 */
export class Queue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const next = (this.tails.get(key) ?? Promise.resolve()).then(fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

type Body = Record<string, unknown>;

const obj = (v: unknown): Body | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Body) : undefined);

/** The session a write acts for, as the caller sent it, or null for a process outside any session. */
function agentOf(v: unknown): Agent | null {
  if (v === null || v === undefined) return null;
  const a = obj(v);
  const session = validSession(a?.session);
  if (!a || !session || typeof a.claude !== "boolean" || (a.name !== undefined && (typeof a.name !== "string" || a.name.length > 64)))
    throw new HoopError("invalid agent in write", [{ path: "agent", message: "expected { session, claude, name? }" }]);
  return { session, claude: a.claude, ...(typeof a.name === "string" ? { name: a.name } : {}) };
}

/** Where the caller's session works. A session's review folder is always a `.hoop` folder given by its full path. */
function placeOf(v: unknown): Place | undefined {
  if (v === undefined) return undefined;
  const p = obj(v);
  const ok =
    p &&
    typeof p.repo_dir === "string" &&
    (p.repo === undefined || typeof p.repo === "string") &&
    (p.folder === undefined || (typeof p.folder === "string" && p.folder.startsWith("/") && /\/\.hoop$/.test(p.folder)));
  if (!ok) throw new HoopError("invalid place in write", [{ path: "place", message: "expected { repo_dir, repo?, folder? }" }]);
  return { repo_dir: p.repo_dir as string, ...(p.repo ? { repo: p.repo as string } : {}), ...(p.folder ? { folder: p.folder as string } : {}) };
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The review a write changes, for the queue: named outright, in a document, or in a thread ID. */
function reviewKey(input: Body | undefined): string | undefined {
  const id = str(input?.review_id) ?? str(obj(input?.document)?.review_id);
  if (id) return id;
  const thread = str(input?.thread)?.match(/^(?:th|bt)_([a-z0-9]+)_\d+$/);
  return thread ? `rv_${thread[1]}` : undefined;
}

/** One kind of write: the queue key it runs under, and what it does in the pages process. */
/** What the pages process gives a write beside the store: what the done gate reads of reviews and pull requests. */
type WriteContext = { done?: () => DoneLook };

type Write = { key: (body: Body) => string; run: (store: Store, body: Body, ctx?: WriteContext) => unknown };

/** Each write a session or command can send. Every one validates what it was sent. */
export const WRITES: Record<string, Write> = {
  /** An agent operation that writes (`writes` in `OPS`), run for the caller's session and place. */
  op: {
    key: (b) => (b.name === "track_pr" ? "prs" : b.name === "action" || b.name === "action_withdraw" ? ACTIONS_KEY : (reviewKey(obj(b.input)) ?? "new")),
    run: (store, b) => {
      const op = OPS.find((o) => o.name === b.name && o.writes);
      if (!op) throw new HoopError(`no operation ${String(b.name)} to run in the pages process`);
      const hoop = new Hoop(store, agentOf(b.agent), placeOf(b.place));
      return op.run(hoop, checkInput(op, obj(b.input) ?? {}), { actor: str(b.actor) ?? "claude" });
    },
  },
  /** Feedback as the agent receives it, with a receipt for each review in it; a quick question's answers, for the session that asked. */
  receive: {
    key: (b) => str(b.review_id) ?? "",
    run: (store, b) => {
      const hoop = new Hoop(store, agentOf(b.agent));
      const id = String(b.review_id);
      return store.meta(id).ask ? hoop.receiveAsk(id) : hoop.receive(id);
    },
  },
  /** A wait's mark: started, or ended (with `until`). */
  wait: {
    key: (b) => str(b.review_id) ?? "",
    run: (store, b) => {
      saveWaitMark(store.home, String(b.review_id), {
        pid: Number(b.pid),
        started: str(b.started) ?? new Date().toISOString(),
        ...(str(b.until) ? { until: str(b.until) } : {}),
      });
      return { ok: true };
    },
  },
  /** The plan hook's submit, and its record. */
  plan: {
    key: (b) => `plan:${str(b.session)}`,
    run: (store, b) => submitPlan(new Hoop(store, agentOf(b.agent), placeOf(b.place)), str(b.session) ?? "", String(b.plan ?? "")),
  },
  plan_cursor: {
    key: (b) => `plan:${str(b.session)}`,
    run: (store, b) => {
      savePlanCursor(new Hoop(store, agentOf(b.agent)), str(b.session) ?? "");
      return { ok: true };
    },
  },
  /** A build's queued requests, taken by its owner's session (`hoop_build_wait`). */
  build_take: {
    key: (b) => str(b.review_id) ?? "",
    run: (store, b) => new Hoop(store, agentOf(b.agent)).takeRequests(String(b.review_id)),
  },
  /** `hoop open`: a review of a markdown file, the person's, from its full path. */
  open: {
    key: (b) => `open:${str(b.file)}`,
    run: (store, b) => {
      const file = str(b.file);
      if (!file?.startsWith("/")) throw new HoopError("expected { file } with a full path");
      return new Hoop(store, null).open(file, str(b.title) ? { title: str(b.title) } : {});
    },
  },
  /** A Claude Code hook input for the Work page, and its stamp. */
  work_hook: {
    key: (b) => `work:${str(obj(b.input)?.session_id)}`,
    run: (store, b) => {
      stampHook(store.home, b.input, undefined, b.plugin);
      return { recorded: Boolean(workHook(store.home, b.input)) };
    },
  },
  /** The Work view's gate on one tool call: its decision, recorded, and its stamp. */
  work_gate: {
    key: (b) => `work:${str(obj(b.input)?.session_id)}`,
    run: (store, b) => {
      stampHook(store.home, b.input, undefined, b.plugin);
      return gateOutput(workGate(store.home, b.input));
    },
  },
  /** The Stop gate on one turn's end: a block once per cause, recorded in the session's work record. */
  stop_gate: {
    key: (b) => `work:${str(obj(b.input)?.session_id)}`,
    run: (store, b) => stopOutput(stopGate(store, b.input)),
  },
  /** The done gate on one todo's completion: a refusal once per link it waits on, recorded in the session's work record, and the hook's stamp. */
  done_gate: {
    key: (b) => `work:${str(obj(b.input)?.session_id)}`,
    run: async (store, b, ctx) => {
      stampHook(store.home, b.input, undefined, b.plugin);
      const look = ctx?.done?.();
      return (look && (await doneGate(store.home, b.input, look))) ?? {};
    },
  },
  /** The pull request a `gh pr create` opened, for the hook's session, and the hook's stamp (written at once, so no queue is needed). */
  pr_hook: {
    key: () => "prs",
    run: (store, b) => {
      stampHook(store.home, b.input, undefined, b.plugin);
      return { tracked: Boolean(prHook(store.home, b.input, validSession(b.session))) };
    },
  },
  /** `hoop clear`: deletes reviews for good. */
  clear: {
    key: () => "clear",
    run: (store, b) => {
      const ids = Array.isArray(b.ids) ? b.ids : [];
      if (!ids.every((id) => typeof id === "string" && /^rv_[a-z0-9]+$/.test(id))) throw new HoopError("expected { ids: [review IDs] }");
      for (const id of ids as string[]) store.remove(id);
      return { cleared: ids };
    },
  },
};
