import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { readTracker, trackerTables } from "./tracker.js";
import { DOC, itemLines } from "./contract.js";
import { Hoop, HoopError, PORT } from "./hoop.js";
import { audit } from "./audit.js";

const WEB = new URL("../web/", import.meta.url);
const STATIC: Record<string, [string, string]> = {
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/review.js": ["review.js", "text/javascript; charset=utf-8"],
  "/select.js": ["select.js", "text/javascript; charset=utf-8"],
  "/tree.js": ["tree.js", "text/javascript; charset=utf-8"],
  "/tracker.js": ["tracker.js", "text/javascript; charset=utf-8"],
};

const repoDir = () => process.env.HOOP_REPO_DIR ?? process.cwd();

/** The repository's trackers: the project's and each change's, relative to the repository. */
export function trackerFiles(repo: string): string[] {
  const changes = join(repo, "docs", "changes");
  const found = existsSync(changes) ? readdirSync(changes).sort((a, b) => (Number(a.match(/\d+/)?.[0]) || 0) - (Number(b.match(/\d+/)?.[0]) || 0)).map((d) => `docs/changes/${d}/TRACKER.md`) : [];
  return ["docs/TRACKER.md", ...found].filter((f) => existsSync(join(repo, f)));
}

/** A markdown file inside the repository, or a refusal; symlinks are resolved first. */
export function insideRepo(repo: string, file: string): string {
  const root = realpathSync(repo), path = resolve(root, file);
  if (!path.endsWith(".md")) throw new HoopError(`${file} is not a markdown file`);
  if (!existsSync(path)) throw new HoopError(`no tracker at ${file}`);
  const real = realpathSync(path);
  if (!real.startsWith(root + sep)) throw new HoopError(`${file} is outside the repository`);
  return real;
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void> | void;

export function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new HoopError("request body too large");
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new HoopError("request body is not valid JSON");
  }
}

/** Everything the review page needs: the latest revision with each item's lines, plus history. */
export function reviewView(hoop: Hoop, id: string) {
  const meta = hoop.store.meta(id);
  const doc = hoop.store.revision(id);
  const previous = meta.revisions > 1 ? hoop.store.revision(id, meta.revisions - 1) : undefined;
  // Each earlier revision's item lines, to tell whether a comment's line has changed since.
  const history: Record<number, Record<string, string | string[]>> = {};
  for (let n = 1; n < meta.revisions; n++) {
    const d = hoop.store.revision(id, n);
    history[n] = Object.fromEntries([
      ...d.items.map((i) => [i.id, itemLines(i)]),
      ...d.items.map((i) => [`#${i.id}`, i.title]),
      [DOC, [d.title, d.tldr]],
    ]);
  }
  const withLines = (d: typeof doc) => d.items.map((item) => ({ ...item, lines: itemLines(item) }));
  // Tracker tables in the latest revision, parsed here so the page renders them as trees (FR-10).
  const withTables = (items: ReturnType<typeof withLines>) => items.map((i) => {
    const tables = trackerTables(i.lines);
    return tables.length ? { ...i, tables } : i;
  });
  return {
    meta,
    doc: { ...doc, items: withTables(withLines(doc)) },
    previous: previous ? { revision: previous.revision, items: withLines(previous) } : undefined,
    feedback: hoop.store.allFeedback(id),
    replies: hoop.store.replies(id),
    applied: hoop.store.applied(id),
    edits: hoop.store.proposals(id).map((p) => ({ ...p, position: p.status === "proposed" ? hoop.editPosition(id, p) : null })),
    history,
  };
}

export function routes(hoop: Hoop): [string, RegExp, Handler][] {
  const page = (_req: IncomingMessage, res: ServerResponse) =>
    send(res, 200, readFileSync(new URL("index.html", WEB), "utf8"), "text/html; charset=utf-8");
  return [
    ["GET", /^\/$/, page],
    ["GET", /^\/r\/(rv_[a-z0-9]+)$/, page],
    ["GET", /^\/tracker$/, page],
    ["GET", /^\/api\/trackers$/, (_q, res) => send(res, 200, trackerFiles(repoDir()))],
    ["GET", /^\/api\/tracker$/, (req, res) => {
      const file = new URL(req.url ?? "/", "http://localhost").searchParams.get("file") || "docs/TRACKER.md";
      send(res, 200, readTracker(insideRepo(repoDir(), file)));
    }],
    ["GET", /^\/api\/reviews$/, (_q, res) => send(res, 200, hoop.store.list())],
    ["GET", /^\/api\/reviews\/(rv_[a-z0-9]+)$/, (_q, res, [id]) => send(res, 200, reviewView(hoop, id!))],
    ["POST", /^\/api\/reviews\/(rv_[a-z0-9]+)\/feedback$/, async (req, res, [id]) => {
      const body = await readJson(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new HoopError("expected a JSON object");
      send(res, 201, hoop.review(id!, body as Record<string, unknown>));
    }],
    ["POST", /^\/api\/reviews\/(rv_[a-z0-9]+)\/edits\/(ed_[a-z0-9_]+)$/, async (req, res, [id, edit]) => {
      const body = (await readJson(req)) as { action?: unknown };
      if (body?.action !== "accept" && body?.action !== "reject") throw new HoopError('expected { action: "accept" | "reject" }');
      send(res, 201, hoop.decideEdit(id!, edit!, body.action));
    }],
    ["POST", /^\/api\/reviews\/(rv_[a-z0-9]+)\/apply$/, async (req, res, [id]) => {
      const body = (await readJson(req)) as { thread?: unknown };
      if (typeof body?.thread !== "string") throw new HoopError("expected { thread }");
      send(res, 201, hoop.applySuggestion(id!, body.thread));
    }],
  ];
}

export function createWebServer(hoop = new Hoop(), extra: [string, RegExp, Handler][] = []): Server {
  const table = [...routes(hoop), ...extra];
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Only this machine's pages may use the API: check Host (DNS rebinding), and for writes, Origin
    // and a JSON content type (a cross-site form or text/plain POST needs no CORS preflight).
    const port = req.socket.localPort;
    const allowed = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!allowed.includes(req.headers.host ?? "")) return send(res, 403, { error: "unexpected Host header" });
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin && !allowed.some((h) => origin === `http://${h}`)) return send(res, 403, { error: "cross-origin request refused" });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
        return send(res, 415, { error: "send JSON with content-type: application/json" });
    }
    try {
      const file = STATIC[url.pathname];
      if (req.method === "GET" && file) return send(res, 200, readFileSync(new URL(file[0], WEB), "utf8"), file[1]);
      for (const [method, pattern, handler] of table) {
        const m = url.pathname.match(pattern);
        if (m && req.method === method) return await handler(req, res, m.slice(1));
      }
      send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    } catch (err) {
      const status = err instanceof HoopError ? 400 : /^no review|invalid review id/.test(String((err as Error).message)) ? 404 : 500;
      if (req.method === "POST") {
        const action = url.pathname.endsWith("/feedback") ? "review" : url.pathname.endsWith("/apply") ? "apply_suggestion" : url.pathname.includes("/edits/") ? "decide_edit" : "api";
        audit(action, { ok: false, actor: "reviewer", review_id: url.pathname.match(/rv_[a-z0-9]+/)?.[0], error: (err as Error).message,
          errors: err instanceof HoopError ? err.errors.map((e) => `${e.path}: ${e.message}`) : undefined });
      }
      send(res, status, err instanceof HoopError ? { error: err.message, errors: err.errors } : { error: (err as Error).message });
    }
  });
}

/** Serves the review pages on localhost. If another hoop already serves the port, it serves the same store. */
export function startWeb(hoop = new Hoop(), port = PORT): Promise<Server | undefined> {
  return new Promise((resolve, reject) => {
    const server = createWebServer(hoop);
    server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(undefined) : reject(err)));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
