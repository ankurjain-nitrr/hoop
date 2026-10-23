import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoDir, repoIdentity } from "./util.js";
import { reviewStatus } from "./rules.js";
import { sessionLabel } from "./owner.js";
import { DOC, itemBlocks, itemLines, type ReviewDoc } from "./contract.js";
import { Hoop, HoopError, PORT } from "./hoop.js";
import { liveSessions, storeKey } from "./sessions.js";
import { codeId, ownInstall, release } from "./version.js";

const WEB = new URL("../web/", import.meta.url);
const STATIC: Record<string, [string, string]> = {
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/review.js": ["review.js", "text/javascript; charset=utf-8"],
  "/select.js": ["select.js", "text/javascript; charset=utf-8"],
  "/esc.js": ["esc.js", "text/javascript; charset=utf-8"],
  "/status.js": ["status.js", "text/javascript; charset=utf-8"],
  "/icons.js": ["icons.js", "text/javascript; charset=utf-8"],
  "/frame.js": ["frame.js", "text/javascript; charset=utf-8"],
  "/blocks.js": ["blocks.js", "text/javascript; charset=utf-8"],
  "/inline.js": ["inline.js", "text/javascript; charset=utf-8"],
  "/outline.js": ["outline.js", "text/javascript; charset=utf-8"],
  "/diagram.js": ["diagram.js", "text/javascript; charset=utf-8"],
  "/diagram-frame.js": ["diagram-frame.js", "text/javascript; charset=utf-8"],
  "/trail.js": ["trail.js", "text/javascript; charset=utf-8"],
};

/** The status key, repository identity and project the pages show for a review. */
function listed(hoop: Hoop, meta: ReturnType<Hoop["store"]["meta"]>) {
  const repo = repoIdentity(meta.repo_dir);
  return { ...reviewStatus(hoop.store, meta), ...(repo ? { repo, project: repo.name } : {}) };
}

/** Markdown line as plain text: link targets, emphasis and code marks dropped, joined source lines as spaces. */
const plain = (line: string) =>
  line
    .replace(/\u2028/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~|\*|\b_)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();

/** What Home says a review is about: its TL;DR, or else the first paragraph line of its body. */
export function reviewSummary(doc: ReviewDoc): string {
  if (plain(doc.tldr)) return plain(doc.tldr);
  for (const item of doc.items) {
    // Body lines come first in an item's lines; choices, the check and a lone title follow them.
    const body = (item.body ?? "").split("\n").filter((l) => l.trim()).length;
    const lines = itemLines(item);
    const i = itemBlocks(item).findIndex((b, n) => n < body && b.kind === "paragraph" && plain(lines[n]!));
    if (i >= 0) return plain(lines[i]!);
  }
  return "";
}

/** A review's meta without its folder path (pages see the repository only through its identity), with its owner as people read it. */
const pageMeta = ({ repo_dir: _path, owner, ...meta }: ReturnType<Hoop["store"]["meta"]>) => ({ ...meta, ...(owner ? { owner: sessionLabel(owner) } : {}) });

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void> | void;

/** What the pages process adds to a server: whether its code is out of date, and a hook on every request. */
export type PagesOptions = { stale?: () => boolean; onRequest?: () => void };

/** The page files as they were when the server started, so a server's pages always match its routes. */
function snapshot(): Map<string, string> {
  const files = new Map<string, string>([["index.html", readFileSync(new URL("index.html", WEB), "utf8")]]);
  for (const [file] of Object.values(STATIC)) files.set(file, readFileSync(new URL(file, WEB), "utf8"));
  return files;
}

const REPOS_TTL_MS = 10_000,
  FRESH_MIN_MS = 1000;
type OpenRepo = { id: NonNullable<ReturnType<typeof repoIdentity>>; dir: string };
let reposCache: { at: number; home: string; folder: string; repos: Map<string, OpenRepo> } | undefined;

/**
 * When the sessions folder last changed, and how many entries it holds. A session's start or end
 * writes or removes its entry there; the count covers file systems that keep whole seconds.
 */
const sessionsChanged = (home: string) => {
  const dir = join(home, "sessions");
  try {
    return `${statSync(dir).mtimeMs}:${readdirSync(dir).length}`;
  } catch {
    return "";
  }
};

/**
 * The open repositories by key: the server's own, and each live session's. Reading sessions runs
 * `ps`, so they are read again only when the sessions folder changed, after ten seconds, or when
 * `fresh` asks and a second passed since the last read.
 */
function openRepos(hoop: Hoop, fresh = false): Map<string, OpenRepo> {
  const home = hoop.store.home,
    folder = sessionsChanged(home),
    c = reposCache;
  const old = !c || c.home !== home || c.folder !== folder || Date.now() - c.at > REPOS_TTL_MS;
  if (old || (fresh && Date.now() - c!.at > FRESH_MIN_MS)) {
    const repos = new Map<string, OpenRepo>();
    for (const dir of [repoDir(), ...liveSessions(home).map((s) => s.repo)]) {
      const id = repoIdentity(dir);
      if (id && !repos.has(id.key)) repos.set(id.key, { id, dir });
    }
    reposCache = { at: Date.now(), home, folder, repos };
  }
  return reposCache!.repos;
}

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
  // Each earlier revision's line kinds, beside `history` so they can never clash with an item ID.
  const history_blocks: Record<number, Record<string, ReturnType<typeof itemBlocks>>> = {};
  for (let n = 1; n < meta.revisions; n++) {
    const d = hoop.store.revision(id, n);
    history_blocks[n] = Object.fromEntries(d.items.map((i) => [i.id, itemBlocks(i)]));
    history[n] = Object.fromEntries([...d.items.map((i) => [i.id, itemLines(i)]), ...d.items.map((i) => [`#${i.id}`, i.title]), [DOC, [d.title, d.tldr]]]);
  }
  const withLines = (d: typeof doc) => d.items.map((item) => ({ ...item, lines: itemLines(item), blocks: itemBlocks(item) }));
  return {
    meta: pageMeta(meta),
    ...listed(hoop, meta),
    doc: { ...doc, items: withLines(doc) },
    previous: previous ? { revision: previous.revision, items: withLines(previous) } : undefined,
    feedback: hoop.store.allFeedback(id),
    replies: hoop.store.replies(id),
    applied: hoop.store.applied(id),
    edits: hoop.store.proposals(id).map((p) => ({ ...p, position: p.status === "proposed" ? hoop.editPosition(id, p) : null })),
    history,
    history_blocks,
    renamed: hoop.store.renamed(id),
    trail: trail(hoop, id),
  };
}

/** One event on a review, as its history shows it. */
export type TrailEntry = { at: string; who: string; what: string; revision?: number };

/** Every event on a review, oldest first: reviews and their verdicts, replies, applied suggestions and edits. */
export function trail(hoop: Hoop, id: string): TrailEntry[] {
  const out: TrailEntry[] = [];
  for (const f of hoop.store.allFeedback(id)) {
    const at = { at: f.at, who: f.reviewer, revision: f.revision };
    const n = f.comments.length;
    if (n) out.push({ ...at, what: `${n} ${n === 1 ? "comment" : "comments"}` });
    if (f.resolved_threads.length) out.push({ ...at, what: `resolved ${f.resolved_threads.length} ${f.resolved_threads.length === 1 ? "thread" : "threads"}` });
    if (f.verdict === "approved") out.push({ ...at, what: "approval" });
    if (f.verdict === "changes_requested") out.push({ ...at, what: "requested changes" });
    if (!n && f.verdict === "comment" && !f.resolved_threads.length && f.summary) out.push({ ...at, what: "comment" });
  }
  for (const r of hoop.store.replies(id)) out.push({ at: r.at, who: r.author, what: "reply" });
  for (const a of hoop.store.applied(id))
    out.push({ at: a.at, who: a.by, what: a.kind === "suggestion" ? "applied a suggestion" : "applied an edit", revision: a.revision });
  for (const p of hoop.store.proposals(id)) {
    out.push({ at: p.at, who: "claude", what: "proposed an edit", revision: p.revision });
    if (p.decided_at && p.status !== "proposed") out.push({ at: p.decided_at, who: p.decided_by ?? "reviewer", what: `${p.status} an edit` });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function routes(hoop: Hoop, files = snapshot(), opts: PagesOptions = {}): [string, RegExp, Handler][] {
  const page = (_req: IncomingMessage, res: ServerResponse) => send(res, 200, files.get("index.html")!, "text/html; charset=utf-8");
  const install = ownInstall();
  const started = { release: release(install), code: codeId(install) };
  return [
    ["GET", /^\/$/, page],
    ["GET", /^\/r\/(rv_[a-z0-9]+)$/, page],
    [
      "GET",
      /^\/api\/reviews$/,
      (_q, res) =>
        send(
          res,
          200,
          hoop.store.list().map((m) => ({ ...pageMeta(m), ...listed(hoop, m), summary: reviewSummary(hoop.store.revision(m.id)) })),
        ),
    ],
    [
      "GET",
      /^\/api\/info$/,
      (_q, res) =>
        send(res, 200, {
          hoop: "pages",
          ...started,
          store: storeKey(hoop.store.home),
          stale: opts.stale?.() ?? false,
          pid: process.pid,
          repos: [...openRepos(hoop).values()].map((r) => r.id),
        }),
    ],
    ["GET", /^\/api\/reviews\/(rv_[a-z0-9]+)$/, (_q, res, [id]) => send(res, 200, reviewView(hoop, id!))],
    [
      "POST",
      /^\/api\/reviews\/(rv_[a-z0-9]+)\/feedback$/,
      async (req, res, [id]) => {
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HoopError("expected a JSON object");
        send(res, 201, hoop.review(id!, body as Record<string, unknown>, true));
      },
    ],
    [
      "POST",
      /^\/api\/reviews\/(rv_[a-z0-9]+)\/edits\/(ed_[a-z0-9_]+)$/,
      async (req, res, [id, edit]) => {
        const body = (await readJson(req)) as { action?: unknown };
        if (body?.action !== "accept" && body?.action !== "reject") throw new HoopError('expected { action: "accept" | "reject" }');
        send(res, 201, hoop.decideEdit(id!, edit!, body.action));
      },
    ],
    [
      "POST",
      /^\/api\/reviews\/(rv_[a-z0-9]+)\/apply$/,
      async (req, res, [id]) => {
        const body = (await readJson(req)) as { thread?: unknown };
        if (typeof body?.thread !== "string") throw new HoopError("expected { thread }");
        send(res, 201, hoop.applySuggestion(id!, body.thread));
      },
    ],
  ];
}

export function createWebServer(hoop = new Hoop(), extra: [string, RegExp, Handler][] = [], opts: PagesOptions = {}): Server {
  const files = snapshot();
  const table = [...routes(hoop, files, opts), ...extra];
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Only this machine's pages may use the API: check Host (DNS rebinding), and for writes, Origin
    // and a JSON content type (a cross-site form or text/plain POST needs no CORS preflight).
    const port = req.socket.localPort;
    const allowed = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!allowed.includes(req.headers.host ?? "")) return send(res, 403, { error: "unexpected Host header" });
    // Only this machine's pages and hoop's own checks count as use. A browser marks another site's
    // requests as cross-site, and those can't keep the pages running.
    const site = req.headers["sec-fetch-site"];
    if (!site || site === "same-origin" || site === "none") opts.onRequest?.();
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin && !allowed.some((h) => origin === `http://${h}`)) return send(res, 403, { error: "cross-origin request refused" });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
        return send(res, 415, { error: "send JSON with content-type: application/json" });
    }
    try {
      const file = STATIC[url.pathname];
      if (req.method === "GET" && file) return send(res, 200, files.get(file[0])!, file[1]);
      for (const [method, pattern, handler] of table) {
        const m = url.pathname.match(pattern);
        if (m && req.method === method) return await handler(req, res, m.slice(1));
      }
      send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    } catch (err) {
      const status = err instanceof HoopError ? 400 : /^no review|invalid review id/.test(String((err as Error).message)) ? 404 : 500;
      send(res, status, err instanceof HoopError ? { error: err.message, errors: err.errors } : { error: (err as Error).message });
    }
  });
}

/** Serves the review pages on localhost, or resolves undefined when the port is taken. */
export function startWeb(hoop = new Hoop(), port = PORT, opts: PagesOptions = {}): Promise<Server | undefined> {
  return new Promise((resolve, reject) => {
    const server = createWebServer(hoop, [], opts);
    server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(undefined) : reject(err)));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
