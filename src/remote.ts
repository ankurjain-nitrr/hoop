import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Hoop, HoopError, PORT, type Place } from "./hoop.js";
import type { Op } from "./ops.js";
import { type Agent, agentFromEnv, sessionHoop } from "./owner.js";
import { ensurePages, type PagesNotice } from "./pages.js";
import { storeKey } from "./sessions.js";
import { Store } from "./store.js";
import { gitRoot, hoopHome, repoDir } from "./util.js";
import { STORE_HEADER, WRITE_PATH } from "./writes.js";

/** How long a write waits for a pages process from an older release to hand the address over. */
const HANDOVER_WAIT_MS = 8000;
const REQUEST_TIMEOUT_MS = 60_000;

type Answer = { status: number; hoop: boolean; body: { error?: string; errors?: { path: string; message: string }[] } & Record<string, unknown> };

/**
 * Sends a session's or a command's writes to the pages process, the only process that writes hoop's
 * files. When nothing answers it starts the pages process (as `ensurePages` does for links) and
 * tries once more; when that fails too, the write fails with the reason. It never writes a file itself.
 * With `start: false` (the hooks that must stay fast) it doesn't start one.
 */
export class Remote {
  constructor(
    readonly home: string,
    readonly port = PORT,
    private readonly opts: { start?: boolean; timeoutMs?: number } = {},
  ) {}

  /** Where this process works, for the pages process to record with a review. */
  place(agent: Agent | null): Place {
    const repo_dir = repoDir();
    const repo = gitRoot(repo_dir);
    const folder = agent?.claude ? sessionHoop(agent.session) : undefined;
    return { repo_dir, ...(repo ? { repo } : {}), ...(folder ? { folder } : {}) };
  }

  /** Sends one write and resolves its result; rejects with the pages process's refusal, or when no pages process can take it. */
  async post<T = unknown>(action: string, body: Record<string, unknown>): Promise<T> {
    let a = await this.send(action, body);
    if (typeof a === "string" && this.opts.start !== false) {
      const pages = await ensurePages(this.home, this.port, { wait: true });
      if (pages.notice) throw new HoopError(`hoop couldn't save this: ${pages.notice.message}`);
      if (pages.status === "off")
        throw new HoopError(
          `hoop saves its files only through its pages process, and none runs on port ${this.port} (HOOP_PAGES=off keeps hoop from starting one)`,
        );
      a = await this.send(action, body);
    }
    // A pages process from an older release has no write route; it hands the address to this release
    // within seconds, and the address refuses connections for a moment while it does.
    let old = false;
    for (const end = Date.now() + HANDOVER_WAIT_MS; Date.now() < end; a = await this.send(action, body)) {
      if (typeof a !== "string" && oldPages(a)) old = true;
      else if (!old || typeof a !== "string") break;
      await sleep(250);
    }
    if (typeof a === "string")
      throw new HoopError(`hoop saves its files only through its pages process, and none answers on port ${this.port}: ${a}. Run hoop serve to see why.`);
    // Only hoop's pages process for this store answers a write with the store's key.
    if (a.status >= 200 && a.status < 300 && a.hoop) return a.body as T;
    if (a.status >= 200 && a.status < 300)
      throw new HoopError(`hoop couldn't save this: another program answers on port ${this.port}. Set HOOP_PORT to use another port.`);
    const message = a.body.error ?? `the pages process answered ${a.status}`;
    if (oldPages(a)) throw new HoopError(`the pages process on port ${this.port} is an older hoop that can't save this yet; try again in a moment`);
    if (a.status === 400 || a.status === 409 || a.status === 403) throw new HoopError(message, a.body.errors ?? []);
    throw new Error(message);
  }

  /** One request: the answer, or why the address refused the connection (the write never arrived). */
  private send(action: string, body: Record<string, unknown>): Promise<Answer | string> {
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: this.port,
          method: "POST",
          path: `${WRITE_PATH}${action}`,
          headers: {
            host: `localhost:${this.port}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(data),
            [STORE_HEADER]: storeKey(this.home),
          },
          timeout: this.opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (text += d));
          res.on("end", () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = { error: text.slice(0, 200) || `status ${res.statusCode}` };
            }
            const status = res.statusCode ?? 500;
            resolve({
              status,
              hoop: res.headers[STORE_HEADER] === storeKey(this.home),
              body: (status < 300 ? parsed : parsed && typeof parsed === "object" ? parsed : { error: String(parsed) }) as Answer["body"],
            });
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`the pages process didn't answer within ${(this.opts.timeoutMs ?? REQUEST_TIMEOUT_MS) / 1000} seconds`)));
      // Only a refused connection is safe to send again: the write never arrived.
      req.on("error", (err: NodeJS.ErrnoException) =>
        err.code === "ECONNREFUSED" ? resolve(err.code) : reject(new HoopError(`hoop's pages process failed to save this: ${err.message}`)),
      );
      req.end(data);
    });
  }
}

const oldPages = (a: Answer) => a.status === 404 && /^no route/.test(String(a.body?.error ?? ""));

/** A Hoop for a session or a command: it reads the files directly and sends every write to the pages process. */
export function clientHoop(agent: Agent | null = agentFromEnv() ?? null, home = hoopHome()): Hoop {
  const hoop = new Hoop(new Store(home, { readOnly: true }), agent);
  hoop.remote = new Remote(home);
  return hoop;
}

/** Runs an operation: one that writes runs in the pages process for this session, any other here. */
export async function runOp(hoop: Hoop, op: Op, input: Record<string, unknown>, ctx: { actor: string; pages?: PagesNotice }): Promise<unknown> {
  if (!op.writes || !hoop.remote) return op.run(hoop, input, ctx);
  // Pages that can't be served for this store can't take its write either: the reason is the refusal.
  if (ctx.pages) throw new HoopError(`hoop couldn't save this: ${ctx.pages.message}`);
  return hoop.remote.post("op", { name: op.name, input, agent: hoop.actor, place: hoop.remote.place(hoop.actor), actor: ctx.actor });
}
