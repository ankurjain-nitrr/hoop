import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { repoDir, repoIdentity } from "./util.js";
import { reviewStatus } from "./rules.js";
import { ownerNow, renameSession, sessionLabel, validSession } from "./owner.js";
import { type GhRunner, parsePrUrl, PrStates, trackedPrs } from "./prs.js";
import { DOC, itemBlocks, itemLines, type ReviewDoc } from "./contract.js";
import { Hoop, HoopError, PORT } from "./hoop.js";
import { liveSessions, storeKey } from "./sessions.js";
import { codeId, ownInstall, release } from "./version.js";
import { receiptKey } from "./store.js";
import { claudeSessions, type SessionReader, workView } from "./work.js";

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
  "/work.js": ["work.js", "text/javascript; charset=utf-8"],
};

type Meta = ReturnType<Hoop["store"]["meta"]>;

/**
 * Where a review was written, as optional details: the name of the folder its session worked in, and
 * of its git repository when that is another folder. Pages see names, never paths.
 */
function placeOf(meta: Meta): { folder?: string; repo?: string } {
  const folder = meta.repo_dir ? basename(meta.repo_dir) : undefined;
  const repo = meta.repo && meta.repo !== meta.repo_dir ? basename(meta.repo) : undefined;
  return { ...(folder ? { folder } : {}), ...(repo ? { repo } : {}) };
}

/** The agent session that owns a review, as the pages show it: its ID, name, label and whether it still runs. */
function sessionOf(hoop: Hoop, meta: Meta, live: Set<string>) {
  if (!meta.owner) return undefined;
  const owner = ownerNow(meta.owner, hoop.store.home);
  return { id: owner.session, ...(owner.name ? { name: owner.name } : {}), label: sessionLabel(owner), live: live.has(owner.session) };
}

/** The status key, owning session and place the pages show for a review. */
function listed(hoop: Hoop, meta: Meta, live = openState(hoop).live) {
  const session = sessionOf(hoop, meta, live);
  return { ...reviewStatus(hoop.store, meta), ...(session ? { session } : {}), place: placeOf(meta) };
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

/**
 * What Home says a pull request is about: the first paragraph of its description as plain text,
 * past any headings, HTML comments and rules.
 */
export function prSummary(body: string | undefined): string {
  const text = (body ?? "").replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?(-->|$)/g, "");
  for (const para of text.split(/\n\s*\n/)) {
    const lines = para.split("\n").filter((l) => l.trim() && !/^\s{0,3}(#{1,6}\s|#{1,6}$|([-*_])(\s*\2){2,}\s*$)/.test(l));
    const s = plain(lines.map((l) => l.replace(/^\s{0,3}(>\s?|[-*+]\s+|\d+[.)]\s+)/, "")).join(" "));
    if (s) return s;
  }
  return "";
}

/** Every tracked pull request, newest first, with its state from `gh` and the session that opened it. */
async function prList(hoop: Hoop, states: PrStates) {
  const prs = trackedPrs(hoop.store.home).reverse();
  return Promise.all(
    prs.map(async (pr) => {
      const { body, ...state } = await states.get(pr.url);
      const where = parsePrUrl(pr.url)!;
      return { url: pr.url, ...where, added: pr.added, owner: hoop.ownerLabel(pr.owner), summary: prSummary(body), ...state };
    }),
  );
}

/** A review's meta without its folder paths (pages see only their names, in `place`), with its owner as people read it. */
const pageMeta = (hoop: Hoop, { repo_dir: _path, repo: _repo, owner, ...meta }: Meta) => ({ ...meta, ...(owner ? { owner: hoop.ownerLabel(owner) } : {}) });

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void> | void;

/** What the pages process adds to a server: whether its code is out of date, and a hook on every request. */
export type PagesOptions = { stale?: () => boolean; onRequest?: () => void; gh?: GhRunner; sessions?: SessionReader };

/** The page files as they were when the server started, so a server's pages always match its routes. */
function snapshot(): Map<string, string> {
  const files = new Map<string, string>([["index.html", readFileSync(new URL("index.html", WEB), "utf8")]]);
  for (const [file] of Object.values(STATIC)) files.set(file, readFileSync(new URL(file, WEB), "utf8"));
  return files;
}

const REPOS_TTL_MS = 10_000,
  FRESH_MIN_MS = 1000;
type OpenRepo = { id: NonNullable<ReturnType<typeof repoIdentity>>; dir: string };
type Open = { repos: Map<string, OpenRepo>; live: Set<string> };
let openCache: ({ at: number; home: string; folder: string } & Open) | undefined;

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
 * The open repositories by key (the server's own, and each live session's), and the Claude Code
 * sessions whose `hoop mcp` still runs. Reading sessions runs `ps`, so they are read again only when
 * the sessions folder changed, after ten seconds, or when `fresh` asks and a second passed since the
 * last read.
 */
function openState(hoop: Hoop, fresh = false): Open {
  const home = hoop.store.home,
    folder = sessionsChanged(home),
    c = openCache;
  const old = !c || c.home !== home || c.folder !== folder || Date.now() - c.at > REPOS_TTL_MS;
  if (old || (fresh && Date.now() - c!.at > FRESH_MIN_MS)) {
    const repos = new Map<string, OpenRepo>(),
      live = new Set<string>();
    const sessions = liveSessions(home);
    for (const dir of [repoDir(), ...sessions.map((s) => s.repo)]) {
      const id = repoIdentity(dir);
      if (id && !repos.has(id.key)) repos.set(id.key, { id, dir });
    }
    for (const s of sessions) if (validSession(s.claude)) live.add(s.claude!);
    openCache = { at: Date.now(), home, folder, repos, live };
  }
  return openCache!;
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
    meta: pageMeta(hoop, meta),
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
    receipts: hoop.store.receipts(id),
  };
}

/**
 * One event on a review, as its history shows it. The last event of each submitted review names it
 * in `review`, its `receiptKey`, so the history can say when the agent read it.
 */
export type TrailEntry = { at: string; who: string; what: string; revision?: number; review?: string };

/** Every event on a review, oldest first: reviews and their verdicts, replies, applied suggestions and edits. */
export function trail(hoop: Hoop, id: string): TrailEntry[] {
  const out: TrailEntry[] = [];
  const counts: Record<number, number> = {};
  for (const f of hoop.store.allFeedback(id)) {
    const index = (counts[f.revision] = (counts[f.revision] ?? -1) + 1);
    const from = out.length;
    const at = { at: f.at, who: f.reviewer, revision: f.revision };
    const n = f.comments.length;
    if (n) out.push({ ...at, what: `${n} ${n === 1 ? "comment" : "comments"}` });
    if (f.resolved_threads.length) out.push({ ...at, what: `resolved ${f.resolved_threads.length} ${f.resolved_threads.length === 1 ? "thread" : "threads"}` });
    if (f.verdict === "approved") out.push({ ...at, what: "approval" });
    if (f.verdict === "changes_requested") out.push({ ...at, what: "requested changes" });
    if (!n && f.verdict === "comment" && !f.resolved_threads.length && f.summary) out.push({ ...at, what: "comment" });
    if (out.length > from) out[out.length - 1]!.review = receiptKey(f.revision, index);
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
  // Pull request states are read from gh only while Home asks for them.
  const prStates = new PrStates(opts.gh);
  return [
    ["GET", /^\/$/, page],
    ["GET", /^\/r\/(rv_[a-z0-9]+)$/, page],
    ["GET", /^\/work$/, page],
    [
      "GET",
      /^\/api\/reviews$/,
      (_q, res) => {
        const live = openState(hoop).live;
        send(
          res,
          200,
          hoop.store.list().map((m) => ({ ...pageMeta(hoop, m), ...listed(hoop, m, live), summary: reviewSummary(hoop.store.revision(m.id)) })),
        );
      },
    ],
    // The Work page asks for this every few seconds while it is visible.
    ["GET", /^\/api\/work$/, (_q, res) => send(res, 200, { sessions: workView(hoop.store.home, opts.sessions ?? claudeSessions) })],
    ["GET", /^\/api\/prs$/, async (_q, res) => send(res, 200, await prList(hoop, prStates))],
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
          repos: [...openState(hoop).repos.values()].map((r) => r.id),
        }),
    ],
    ["GET", /^\/api\/reviews\/(rv_[a-z0-9]+)$/, (_q, res, [id]) => send(res, 200, reviewView(hoop, id!))],
    // The page asks for these every few seconds, to show when the agent read each submitted review.
    ["GET", /^\/api\/reviews\/(rv_[a-z0-9]+)\/receipts$/, (_q, res, [id]) => send(res, 200, { receipts: hoop.store.receipts(hoop.store.meta(id!).id) })],
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
      /^\/api\/sessions\/([A-Za-z0-9_-]{1,128})\/name$/,
      async (req, res, [session]) => {
        const body = (await readJson(req)) as { name?: unknown };
        // Only a session that owns a review here can be renamed from the pages.
        const owners = hoop.store.list().flatMap((m) => (m.owner && m.owner.session === session ? [m.owner] : []));
        if (!owners.length) return send(res, 404, { error: `no session ${session}` });
        // Only a Claude Code session has a transcript to write the name to.
        const claude = owners.every((o) => o.claude !== false);
        const renamed = renameSession(hoop.store.home, session!, body?.name, claude);
        send(res, 201, { session, ...renamed, label: sessionLabel({ session: session!, name: renamed.name }) });
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
