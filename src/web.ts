import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { currentUser, repoDir, repoIdentity } from "./util.js";
import { askAnswers, askState, carriedAnswers, reviewStatus } from "./rules.js";
import { ownerNow, renameSession, sessionLabel, validSession } from "./owner.js";
import { type GhRunner, parsePrUrl, PrStates, trackedPrs } from "./prs.js";
import { DOC, itemBlocks, itemLines, type ReviewDoc } from "./contract.js";
import { Hoop, HoopError, PORT } from "./hoop.js";
import { liveSessions, storeKey } from "./sessions.js";
import { codeId, ownInstall, release } from "./version.js";
import { receiptKey } from "./store.js";
import { claudeSessions, type SessionReader, titleReviews, workView } from "./work.js";
import { type BuildChange, joinBlocks } from "./build.js";
import { type Sender, Steer } from "./steer.js";
import { agentState, deliverAction, deliverReview } from "./wake.js";
import { isWaiting } from "./wait.js";
import { ACTIONS_KEY, Queue, STORE_HEADER, WRITE_PATH, WRITES } from "./writes.js";
import { type ActionItem, actionLink, ActionChecks, Actions, type ActionState, type NpmRunner, validReason } from "./actions.js";

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
  "/build.js": ["build.js", "text/javascript; charset=utf-8"],
  "/fold.js": ["fold.js", "text/javascript; charset=utf-8"],
  "/pending.js": ["pending.js", "text/javascript; charset=utf-8"],
  "/ask.js": ["ask.js", "text/javascript; charset=utf-8"],
  "/drafts.js": ["drafts.js", "text/javascript; charset=utf-8"],
  "/place.js": ["place.js", "text/javascript; charset=utf-8"],
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

/**
 * Whether the agent hasn't read a review's latest submitted review yet and isn't waiting for one,
 * so the feedback sits until someone tells the session.
 */
function unread(hoop: Hoop, meta: Meta): boolean {
  for (let n = meta.revisions; n > 0; n--) {
    const count = hoop.store.feedback(meta.id, n).length;
    if (!count) continue;
    return !hoop.store.receipts(meta.id)[receiptKey(n, count - 1)] && !isWaiting(hoop.store.home, meta.id);
  }
  return false;
}

/** A quick question's state, and how many of its questions there are and still lack an answer, as Home shows it. */
function askCounts(hoop: Hoop, meta: Meta) {
  const answers = askAnswers(hoop.store, meta.id);
  const items = hoop.store.revision(meta.id, 1).items;
  return { state: askState(hoop.store, meta), questions: items.length, unanswered: items.filter((q) => !answers.get(q.id)?.length).length };
}

/** The status key, owning session, place and unread flag the pages show for a review, and a quick question's counts. */
function listed(hoop: Hoop, meta: Meta, live = openState(hoop).live) {
  const session = sessionOf(hoop, meta, live);
  return {
    ...reviewStatus(hoop.store, meta),
    ...(session ? { session } : {}),
    place: placeOf(meta),
    unread: unread(hoop, meta),
    ...(meta.ask ? { ask: askCounts(hoop, meta) } : {}),
  };
}

/**
 * What the quick question page needs: its state, and each question with its options and every
 * answer, oldest first. An ask that points at a review line names that line and the review's title,
 * so its page links to the card there.
 */
export function askView(hoop: Hoop, id: string) {
  const meta = hoop.store.meta(id);
  const answers = askAnswers(hoop.store, meta.id);
  const anchor = meta.ask?.anchor;
  let on: string | undefined;
  try {
    on = anchor && hoop.store.meta(anchor.review_id).title;
  } catch {
    /* the review is gone */
  }
  return {
    id: meta.id,
    state: askState(hoop.store, meta),
    ...(meta.ask?.withdrawn ? { withdrawn: meta.ask.withdrawn } : {}),
    ...(anchor ? { anchor: { ...anchor, ...(on !== undefined ? { title: on } : {}) } } : {}),
    questions: hoop.store.revision(meta.id, 1).items.map((q) => ({
      id: q.id,
      question: q.title,
      ...(q.body ? { context: q.body } : {}),
      options: q.choices ?? [],
      answers: answers.get(q.id) ?? [],
    })),
  };
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

/** An action item as Home shows it: no folder, its link, and the session that added it. */
function actionView(hoop: Hoop, item: ActionItem, live: Set<string>) {
  const owner = ownerNow(item.owner, hoop.store.home);
  const title = (id: string) => {
    try {
      return hoop.store.meta(id).title || undefined;
    } catch {
      return undefined;
    }
  };
  const link = actionLink(item.done_when, title);
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    state: item.state,
    kind: item.done_when.kind,
    ...(link ? { link } : {}),
    session: { id: owner.session, label: sessionLabel(owner), live: live.has(owner.session) },
    created: item.created,
    ...(item.closed_at ? { closed_at: item.closed_at, closed_by: item.closed_by } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
    ...(item.delivery ? { delivery: item.delivery.outcome } : {}),
  };
}

/** A review's meta without its folder and file paths (pages see only their names, in `place`), with its owner as people read it. */
const pageMeta = (hoop: Hoop, { repo_dir: _path, repo: _repo, source: _source, owner, ...meta }: Meta) => ({
  ...meta,
  ...(owner ? { owner: hoop.ownerLabel(owner) } : {}),
});

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void> | void;

/** What the pages process adds to a server: whether its code is out of date, and a hook on every request. */
export type PagesOptions = {
  stale?: () => boolean;
  /** How many code checks the pages process has made, so a test can wait for checks instead of time. */
  checks?: () => number;
  onRequest?: () => void;
  gh?: GhRunner;
  /** How action items' npm checks run: injectable for tests. */
  npm?: NpmRunner;
  sessions?: SessionReader;
  /** How the Work page's changes and the pages' reviews reach a session, and how long changes wait to batch: injectable for tests. */
  send?: Sender;
  steerMs?: number;
};

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

/**
 * Everything the review page needs: the latest revision with each item's lines, plus history, and
 * what the agent that owns it is doing (`agent`, from the Claude Code sessions `sessions` reads).
 */
export function reviewView(hoop: Hoop, id: string, sessions: SessionReader = claudeSessions) {
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
    carried: carriedAnswers(hoop.store, id),
    replies: hoop.store.replies(id),
    applied: hoop.store.applied(id),
    edits: hoop.store.proposals(id).map((p) => ({ ...p, position: p.status === "proposed" ? hoop.editPosition(id, p) : null })),
    history,
    history_blocks,
    renamed: hoop.store.renamed(id),
    trail: trail(hoop, id),
    receipts: hoop.store.receipts(id),
    deliveries: hoop.store.deliveries(id),
    agent: agentState(hoop.store, meta, sessions),
    ...(meta.build === "open" ? { build: buildView(hoop, id) } : {}),
    ...(meta.ask ? { ask: askView(hoop, id) } : {}),
    asks: meta.ask ? undefined : anchoredAsks(hoop, meta.id),
  };
}

/**
 * The quick questions that point at lines in a review, oldest first, each with its receipts and how
 * its answers reached the asking session, as their cards beside those lines show them.
 */
function anchoredAsks(hoop: Hoop, id: string) {
  return hoop.store
    .list()
    .filter((m) => m.ask?.anchor?.review_id === id)
    .sort((a, b) => a.created.localeCompare(b.created))
    .map((m) => ({ ...askView(hoop, m.id), receipts: hoop.store.receipts(m.id), deliveries: hoop.store.deliveries(m.id) }));
}

/** What the build page needs: the blocks, the version to tell when to redraw, the history and the markdown. */
export function buildView(hoop: Hoop, id: string) {
  const build = hoop.builds.read(hoop.store.meta(id).id);
  return {
    version: build.version,
    blocks: build.blocks,
    steps: build.steps,
    markdown: joinBlocks(build),
    // The requests still open, Claude's suggestions waiting on the person, and the sections whose earlier text Undo can put back.
    requests: (build.requests ?? []).filter((r) => r.status !== "written"),
    proposals: (build.proposals ?? []).filter((p) => p.status === "proposed"),
    undo: Object.keys(build.undo ?? {}),
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
  const sessions = opts.sessions ?? claudeSessions;
  const steer = new Steer(hoop.store.home, sessions, {
    ...(opts.send ? { send: opts.send } : {}),
    ...(opts.steerMs !== undefined ? { delayMs: opts.steerMs } : {}),
  });
  // A todo's description that links to a review shows the review's title.
  const title = (id: string) => {
    try {
      return hoop.store.meta(id).title || undefined;
    } catch {
      return undefined;
    }
  };
  const work = () => titleReviews(workView(hoop.store.home, sessions), title);
  // This process is the only writer: writes run one at a time for each review or record.
  const queue = new Queue();
  // Action items close when their check sees them done, read only while Home asks.
  const actions = new Actions(hoop.store);
  const checks = new ActionChecks(hoop.store, prStates, opts.npm);
  /** Closes an open item and tells the session that added it; an item closed meanwhile stays as it is. */
  const closeAction = (id: string, state: Exclude<ActionState, "open" | "withdrawn">, by: string, reason?: string, onlyOpen = false) =>
    queue.run(ACTIONS_KEY, async () => {
      if (onlyOpen && actions.get(id).state !== "open") return actions.get(id);
      const item = actions.close(id, state, by, reason);
      const delivery = await deliverAction(item, { sessions, ...(opts.send ? { send: opts.send } : {}) });
      return delivery ? actions.delivered(id, delivery) : item;
    });
  const store = storeKey(hoop.store.home);
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
    [
      "GET",
      /^\/api\/work$/,
      (_q, res) => {
        const view = work();
        steer.catchUp(view);
        send(res, 200, { sessions: view });
      },
    ],
    [
      "POST",
      /^\/api\/work\/([A-Za-z0-9_-]{1,128})\/changes$/,
      async (req, res, [session]) => {
        const body = (await readJson(req)) as { changes?: unknown };
        const changes = await queue.run(`work:${session}`, () => steer.record(session!, body?.changes));
        if (!changes) return send(res, 404, { error: `no work for session ${session}` });
        send(res, 201, { changes, session: work().find((s) => s.id === session) });
      },
    ],
    ["GET", /^\/api\/prs$/, async (_q, res) => send(res, 200, await prList(hoop, prStates))],
    // Every tab asks for this with the reviews, to count open items; Home adds ?check=1 to check them.
    [
      "GET",
      /^\/api\/actions$/,
      async (req, res) => {
        if (new URL(req.url ?? "/", "http://localhost").searchParams.get("check") === "1")
          await Promise.all(
            actions
              .list()
              .filter((i) => i.state === "open")
              .map(async (i) => {
                if (await checks.done(i)) await closeAction(i.id, "done", "hoop", undefined, true);
              }),
          );
        const live = openState(hoop).live;
        send(
          res,
          200,
          actions.list().map((i) => actionView(hoop, i, live)),
        );
      },
    ],
    // The person ticks a manual item done, or says Won't do with a reason.
    [
      "POST",
      /^\/api\/actions\/(ac_[a-z0-9]+)$/,
      async (req, res, [id]) => {
        const body = (await readJson(req)) as { action?: unknown; reason?: unknown };
        let item: ActionItem;
        if (body?.action === "done") {
          if (actions.get(id!).done_when.kind !== "manual") throw new HoopError("only a manual item is ticked done; hoop checks the others itself");
          item = await closeAction(id!, "done", currentUser());
        } else if (body?.action === "wont_do") {
          const reason = validReason(body.reason);
          item = await closeAction(id!, "wont_do", currentUser(), reason);
        } else throw new HoopError('expected { action: "done" } or { action: "wont_do", reason }');
        send(res, 201, actionView(hoop, item, openState(hoop).live));
      },
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
          ...(opts.checks ? { checks: opts.checks() } : {}),
          pid: process.pid,
          repos: [...openState(hoop).repos.values()].map((r) => r.id),
        }),
    ],
    ["GET", /^\/api\/reviews\/(rv_[a-z0-9]+)$/, (_q, res, [id]) => send(res, 200, reviewView(hoop, id!, sessions))],
    // The page asks for this every few seconds, to show whether the agent waits for the review.
    [
      "GET",
      /^\/api\/reviews\/(rv_[a-z0-9]+)\/agent$/,
      (_q, res, [id]) => send(res, 200, { agent: agentState(hoop.store, hoop.store.meta(id!), sessions) ?? null }),
    ],
    // The build page asks for this every few seconds, to show Claude's changes.
    ["GET", /^\/api\/reviews\/(rv_[a-z0-9]+)\/build$/, (_q, res, [id]) => send(res, 200, buildView(hoop, id!))],
    [
      "POST",
      /^\/api\/reviews\/(rv_[a-z0-9]+)\/build$/,
      async (req, res, [id]) => {
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HoopError("expected a JSON object");
        await queue.run(id!, () => hoop.buildChange(id!, body as BuildChange));
        send(res, 201, buildView(hoop, id!));
      },
    ],
    ["POST", /^\/api\/reviews\/(rv_[a-z0-9]+)\/finish$/, async (_q, res, [id]) => send(res, 201, await queue.run(id!, () => hoop.finishBuild(id!)))],
    // The page asks for these every few seconds, to show when the agent read each submitted review.
    ["GET", /^\/api\/reviews\/(rv_[a-z0-9]+)\/receipts$/, (_q, res, [id]) => send(res, 200, { receipts: hoop.store.receipts(hoop.store.meta(id!).id) })],
    [
      "POST",
      /^\/api\/reviews\/(rv_[a-z0-9]+)\/feedback$/,
      async (req, res, [id]) => {
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HoopError("expected a JSON object");
        const out = await queue.run(id!, async () => {
          const stored = hoop.review(id!, body as Record<string, unknown>, true);
          // The person's review wakes the session that asked for it; the page says whether it did.
          const delivery = await deliverReview(hoop.store, stored, { sessions, ...(opts.send ? { send: opts.send } : {}) });
          return { ...stored, ...(delivery ? { delivery } : {}) };
        });
        send(res, 201, out);
      },
    ],
    // A person's answer to a quick question: saved and sent at once, with no review to submit.
    [
      "POST",
      /^\/api\/reviews\/(rv_[a-z0-9]+)\/answer$/,
      async (req, res, [id]) => {
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HoopError("expected a JSON object");
        const delivery = await queue.run(id!, async () => {
          const { feedback, quiet } = hoop.answer(id!, body as Record<string, unknown>);
          // A change to an answer Claude hasn't read yet replaces it quietly; any other answer wakes the session.
          return quiet ? undefined : await deliverReview(hoop.store, feedback, { sessions, ...(opts.send ? { send: opts.send } : {}) });
        });
        send(res, 201, { ...reviewView(hoop, id!, sessions), ...(delivery ? { delivery } : {}) });
      },
    ],
    [
      "POST",
      /^\/api\/reviews\/(rv_[a-z0-9]+)\/edits\/(ed_[a-z0-9_]+)$/,
      async (req, res, [id, edit]) => {
        const body = (await readJson(req)) as { action?: unknown };
        if (body?.action !== "accept" && body?.action !== "reject") throw new HoopError('expected { action: "accept" | "reject" }');
        const action = body.action;
        send(res, 201, await queue.run(id!, () => hoop.decideEdit(id!, edit!, action)));
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
        const renamed = await queue.run("names", () => renameSession(hoop.store.home, session!, body?.name, claude));
        send(res, 201, { session, ...renamed, label: sessionLabel({ session: session!, name: renamed.name }) });
      },
    ],
    [
      "POST",
      /^\/api\/reviews\/(rv_[a-z0-9]+)\/apply$/,
      async (req, res, [id]) => {
        const body = (await readJson(req)) as { thread?: unknown };
        if (typeof body?.thread !== "string") throw new HoopError("expected { thread }");
        const thread = body.thread;
        send(res, 201, await queue.run(id!, () => hoop.applySuggestion(id!, thread)));
      },
    ],
    // Sessions and commands send their writes here (src/remote.ts). A browser can't: it always sends
    // Origin or Sec-Fetch-Site, and another site's page can't set the store header without a preflight.
    [
      "POST",
      new RegExp(`^${WRITE_PATH}([a-z_]+)$`),
      async (req, res, [action]) => {
        if (req.headers.origin || req.headers["sec-fetch-site"] || req.headers["sec-fetch-mode"])
          return send(res, 403, { error: "only hoop's sessions and commands send writes here" });
        if (req.headers[STORE_HEADER] !== store)
          return send(res, 409, { error: "this pages process serves another hoop store; set HOOP_PORT to use another port" });
        const write = WRITES[action!];
        if (!write) throw new HoopError(`no write ${action}`);
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HoopError("expected a JSON object");
        const b = body as Record<string, unknown>;
        const out = (await queue.run(write.key(b), () => write.run(hoop.store, b))) ?? null;
        res.setHeader(STORE_HEADER, store);
        send(res, 200, out);
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
