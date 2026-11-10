import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { clip, currentUser, field, hoopHome, isList, isRecord, logPages, repoDir, repoIdentity } from "./util.js";
import { TLDR_MAX } from "./markdown.js";
import { askAnswers, askState, approvalHolds, carriedAnswers, fromFile, reviewStatus } from "./rules.js";
import { threadViews } from "./threads.js";
import { type Owner, ownerNow, renameSession, sessionLabel, validSession } from "./owner.js";
import { type GhRunner, parsePrUrl, PrStates, trackedPrs } from "./prs.js";
import { DOC, type Feedback, itemBlocks, itemLines, type ReviewDoc } from "./contract.js";
import { Hoop, HoopError, PORT } from "./hoop.js";
import { liveSessions, storeKey } from "./sessions.js";
import { codeId, ownInstall, release } from "./version.js";
import { isOff } from "./off.js";
import { answerPermission, listPermissions, prunePermissions } from "./permissions.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { UpdateCheck, updateCommand } from "./update.js";
import { type Applied, type Closed, receiptKey, receivedBy } from "./store.js";
import { dropStamps, hookWarnings, lastStamp } from "./hook-health.js";
import { editWork, KEEPS, removeWork, hasWork } from "./work.js";
import { DISMISSED_MAX, linkTodos, workView } from "./work-view.js";
import { claudeSessions, ownerSession, type SessionReader } from "./claude-sessions.js";
import { joinBlocks, requeue } from "./build.js";
import type { DraftSeen } from "./build-drafts.js";
import { Steer } from "./steer.js";
import type { Sender } from "./deliver.js";
import { recordStates } from "./history.js";
import { agentState, deliverAction, deliverBuild, deliverClose, deliverReview } from "./wake.js";
import { isWaiting, lastWaited } from "./wait.js";
import { ACTIONS_KEY, PERMISSIONS_KEY, Queue, STORE_HEADER, WRITE_PATH, WRITES } from "./writes.js";
import { type ActionItem, actionLink, ActionChecks, Actions, type ActionState, type NpmRunner, validReason } from "./actions.js";
import { loopTimes, waits } from "./loop-time.js";
import { childPattern, REVIEW_ID_PATTERN } from "./ids.js";
import { DOC_LINES } from "../web/doc-lines.js";

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
  "/api.js": ["api.js", "text/javascript; charset=utf-8"],
  "/blocks.js": ["blocks.js", "text/javascript; charset=utf-8"],
  "/inline.js": ["inline.js", "text/javascript; charset=utf-8"],
  "/outline.js": ["outline.js", "text/javascript; charset=utf-8"],
  "/diagram.js": ["diagram.js", "text/javascript; charset=utf-8"],
  "/diagram-frame.js": ["diagram-frame.js", "text/javascript; charset=utf-8"],
  "/trail.js": ["trail.js", "text/javascript; charset=utf-8"],
  "/work.js": ["work.js", "text/javascript; charset=utf-8"],
  "/activity.js": ["activity.js", "text/javascript; charset=utf-8"],
  "/build.js": ["build.js", "text/javascript; charset=utf-8"],
  "/format.js": ["format.js", "text/javascript; charset=utf-8"],
  "/revise.js": ["revise.js", "text/javascript; charset=utf-8"],
  "/context.js": ["context.js", "text/javascript; charset=utf-8"],
  "/build-drafts.js": ["build-drafts.js", "text/javascript; charset=utf-8"],
  "/build-history.js": ["build-history.js", "text/javascript; charset=utf-8"],
  "/fold.js": ["fold.js", "text/javascript; charset=utf-8"],
  "/permissions.js": ["permissions.js", "text/javascript; charset=utf-8"],
  "/pending.js": ["pending.js", "text/javascript; charset=utf-8"],
  "/ask.js": ["ask.js", "text/javascript; charset=utf-8"],
  "/drafts.js": ["drafts.js", "text/javascript; charset=utf-8"],
  "/tips.js": ["tips.js", "text/javascript; charset=utf-8"],
  "/place.js": ["place.js", "text/javascript; charset=utf-8"],
  "/send.js": ["send.js", "text/javascript; charset=utf-8"],
  "/links.js": ["links.js", "text/javascript; charset=utf-8"],
  "/doc-lines.js": ["doc-lines.js", "text/javascript; charset=utf-8"],
  "/review-keys.js": ["review-keys.js", "text/javascript; charset=utf-8"],
  "/focus.js": ["focus.js", "text/javascript; charset=utf-8"],
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

/** A session reader that reads Claude Code's session files once, for one request. */
const once = (read: SessionReader): SessionReader => {
  let v: ReturnType<SessionReader> | undefined;
  return () => (v ??= read());
};

/**
 * An owner under the session ID its Claude Code process runs now, when `/clear` gave the process a
 * new one since; otherwise the owner as recorded. Home groups a terminal's reviews under it.
 */
function following(owner: Owner, live: Set<string>, sessions: SessionReader): Owner {
  if (!owner.process || owner.claude === false || live.has(owner.session)) return owner;
  let now: ReturnType<typeof ownerSession>;
  try {
    now = ownerSession(owner, sessions());
  } catch {
    return owner;
  }
  return now && now.session !== owner.session ? { session: now.session, ...(now.name ? { name: now.name } : {}), process: owner.process } : owner;
}

/** The agent session that owns a review, as the pages show it: its ID, name, label and whether it still runs. */
function sessionOf(hoop: Hoop, meta: Meta, live: Set<string>, sessions: SessionReader) {
  if (!meta.owner) return undefined;
  const owner = ownerNow(following(meta.owner, live, sessions), hoop.store.home);
  return { id: owner.session, ...(owner.name ? { name: owner.name } : {}), label: sessionLabel(owner), live: live.has(owner.session) };
}

/**
 * Whether a submitted review asks Claude to act on it (changes requested, comments, answers), so
 * Home flags it while Claude hasn't read it. An approval or a closed review asks for nothing: its
 * session learns of it from the wake message, and the page shows that delivery instead. Nor does a
 * review on a review a person opened from a file (#381): no session reads one. #271's "Read, no
 * response" redefines this rule.
 */
export const asksClaudeToAct = (meta: Pick<Meta, "closed" | "opened_by" | "owner">, fb: Pick<Feedback, "verdict">): boolean =>
  !meta.closed && !fromFile(meta) && fb.verdict !== "approved";

/** Whether each submitted review of a review asks Claude to act, by receipt key. */
function asksToAct(hoop: Hoop, meta: Meta): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (let n = 1; n <= meta.revisions; n++) hoop.store.feedback(meta.id, n).forEach((fb, i) => (out[receiptKey(n, i)] = asksClaudeToAct(meta, fb)));
  return out;
}

/**
 * What Claude did after reading a submitted review that asks it to act: a revision of its own (not a
 * reviewer's Apply), a reply, or nothing yet ("none").
 */
type Responded = { kind: "revised" | "replied"; at: string } | { kind: "none" };

/**
 * Claude's response to each submitted review it read that asks it to act, by receipt key: its first
 * revision after it read the review, else its first reply after that, else none yet. A review that
 * asks Claude to act on nothing (an approval, a closed or file-opened review, a session's own
 * comment) has no entry, and neither has one Claude hasn't read.
 */
export function responses(hoop: Hoop, meta: Meta): Record<string, Responded> {
  const applied = new Set(hoop.store.applied(meta.id).map((a) => a.revision));
  const revised = Array.from({ length: meta.revisions }, (_, i) => i + 1)
    .filter((n) => n > 1 && !applied.has(n))
    .flatMap((n) => hoop.store.revisionAt(meta.id, n) ?? [])
    .sort();
  const replies = hoop.store
    .replies(meta.id)
    .map((r) => r.at)
    .sort();
  const receipts = hoop.store.receipts(meta.id);
  const out: Record<string, Responded> = {};
  // A response in the same millisecond as the read still comes after it.
  const after = (at: string, list: string[]) => list.find((x) => x >= at);
  for (let n = 1; n <= meta.revisions; n++)
    hoop.store.feedback(meta.id, n).forEach((fb, i) => {
      const key = receiptKey(n, i);
      const read = receipts[key]?.at;
      if (!read || fb.session || !asksClaudeToAct(meta, fb)) return;
      const rev = after(read, revised);
      const reply = after(read, replies);
      if (rev) out[key] = { kind: "revised", at: rev };
      else if (reply) out[key] = { kind: "replied", at: reply };
      else out[key] = { kind: "none" };
    });
  return out;
}

/**
 * Whether the agent hasn't read a review's latest submitted review yet and isn't waiting for one,
 * when that review asks it to act, so the feedback sits until someone tells the session.
 */
function unread(hoop: Hoop, meta: Meta): boolean {
  const key = latestKey(hoop, meta);
  return key !== undefined && !receivedBy(hoop.store.receipts(meta.id)[key], meta.owner?.session) && !isWaiting(hoop.store.home, meta.id);
}

/** The receipt key of a review's latest submitted review, when it asks the agent to act. */
function latestKey(hoop: Hoop, meta: Meta): string | undefined {
  for (let n = meta.revisions; n > 0; n--) {
    const all = hoop.store.feedback(meta.id, n);
    const last = all.at(-1);
    if (!last) continue;
    return asksClaudeToAct(meta, last) ? receiptKey(n, all.length - 1) : undefined;
  }
  return undefined;
}

/** Whether an unread review's latest submitted review wasn't sent, since messages into a session were off. */
function notSent(hoop: Hoop, meta: Meta): boolean {
  const key = latestKey(hoop, meta);
  return key !== undefined && hoop.store.deliveries(meta.id)[key]?.outcome === "off";
}

/** A quick question's state, and how many of its questions there are and still lack an answer, as Home shows it. */
function askCounts(hoop: Hoop, meta: Meta) {
  const answers = askAnswers(hoop.store, meta.id);
  const items = hoop.store.revision(meta.id, 1).items;
  return { state: askState(hoop.store, meta), questions: items.length, unanswered: items.filter((q) => !answers.get(q.id)?.length).length };
}

/** The status key, owning session, place and unread flag the pages show for a review, and a quick question's counts. */
function listed(hoop: Hoop, meta: Meta, live = openState(hoop).live, sessions: SessionReader = claudeSessions) {
  const session = sessionOf(hoop, meta, live, sessions);
  return {
    ...reviewStatus(hoop.store, meta),
    ...(session ? { session } : {}),
    place: placeOf(meta),
    unread: unread(hoop, meta),
    ...(unread(hoop, meta) && notSent(hoop, meta) ? { not_sent: true } : {}),
    ...(meta.ask ? { ask: askCounts(hoop, meta) } : {}),
  };
}

/**
 * What the quick question page needs: its state, and each question with its options and every
 * answer, oldest first. An ask that points at a review line names that line and the review's title,
 * so its page links to the card there.
 */
function askView(hoop: Hoop, id: string) {
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
    ...(meta.closed ? { closed: meta.closed } : {}),
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

/**
 * What Home says a review is about: its TL;DR, or else the first paragraph line of its body, at most
 * TLDR_MAX characters and never cut mid-word.
 */
export function reviewSummary(doc: ReviewDoc): string {
  // An older hoop cut a long first paragraph at character 279 for the TL;DR, often inside a word.
  const oldCut = doc.tldr_auto && doc.tldr.length === TLDR_MAX && doc.tldr.endsWith("…");
  const tldr = plain(oldCut ? doc.tldr.slice(0, -1) : doc.tldr);
  if (tldr && oldCut) {
    const kept = tldr.replace(/\s*\S*$/, "");
    // A single long word has no word to drop: keep it as it was.
    if (!kept) return `${tldr}…`;
    return /[.!?]$/.test(kept) ? `${kept} …` : `${kept.replace(/[\s,;:]+$/, "")}…`;
  }
  if (tldr) return clip(tldr, TLDR_MAX);
  for (const item of doc.items) {
    // Body lines come first in an item's lines; choices, the check and a lone title follow them.
    const body = (item.body ?? "").split("\n").filter((l) => l.trim()).length;
    const lines = itemLines(item);
    const i = itemBlocks(item).findIndex((b, n) => n < body && b.kind === "paragraph" && plain(lines[n]!));
    if (i >= 0) return clip(plain(lines[i]!), TLDR_MAX);
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
    if (s) return clip(s, TLDR_MAX);
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

/**
 * An action item as Home shows it: no folder, its link, and the session that added it. An open item
 * waiting on a pull request that can no longer merge (closed, or gone from GitHub) says so in `pr_state`.
 */
function actionView(hoop: Hoop, item: ActionItem, live: Set<string>, sessions: SessionReader, prs?: PrStates) {
  const owner = ownerNow(following(item.owner, live, sessions), hoop.store.home);
  const pr = item.state === "open" && item.done_when.kind === "pr_merged" ? prs?.known(item.done_when.url)?.state : undefined;
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
    ...(pr === "gone" || pr === "closed" ? { pr_state: pr } : {}),
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
  /** When hooks count from for the Work page's hook warning: this process's start, or a test's time. */
  hooksSince?: number;
  /** The check for a newer hoop, which Home shows; only the pages process (`startWeb`) has one. */
  updates?: UpdateCheck;
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

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  const chunks: AsyncIterable<Buffer, unknown, undefined> = req;
  for await (const chunk of chunks) {
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
  // The Changes tab compares with the last revision a person reviewed, as GitHub's "changes since
  // your last review" does. Once they reviewed the latest one too, or before any review, it compares
  // with the revision before.
  const last = Math.max(
    0,
    ...hoop.store
      .allFeedback(id)
      .filter((f) => !f.session)
      .map((f) => f.revision),
  );
  const reviewed = last < meta.revisions ? last : 0;
  const since = reviewed || meta.revisions - 1;
  const previous = meta.revisions > 1 ? hoop.store.revision(id, since) : undefined;
  // Each earlier revision's item lines, to tell whether a comment's line has changed since.
  const history: Record<number, Record<string, string | string[]>> = {};
  // Each earlier revision's line kinds, beside `history` so they can never clash with an item ID.
  const history_blocks: Record<number, Record<string, ReturnType<typeof itemBlocks>>> = {};
  for (let n = 1; n < meta.revisions; n++) {
    const d = hoop.store.revision(id, n);
    history_blocks[n] = Object.fromEntries(d.items.map((i) => [i.id, itemBlocks(i)]));
    history[n] = Object.fromEntries([
      ...d.items.map((i) => [i.id, itemLines(i)]),
      ...d.items.map((i) => [`#${i.id}`, i.title]),
      [DOC, DOC_LINES.map((l) => d[l.field])],
    ]);
  }
  const withLines = (d: typeof doc) => d.items.map((item) => ({ ...item, lines: itemLines(item), blocks: itemBlocks(item) }));
  return {
    meta: pageMeta(hoop, meta),
    ...listed(hoop, meta, undefined, sessions),
    doc: { ...doc, items: withLines(doc) },
    previous: previous ? { revision: since, ...(reviewed ? { reviewed: true } : {}), items: withLines(previous) } : undefined,
    feedback: hoop.store.allFeedback(id),
    carried: carriedAnswers(hoop.store, id),
    // What holds up an approval now; the page adds the reviewer's unsent comments, answers and resolutions.
    approval_holds: meta.ask || meta.build === "open" ? undefined : approvalHolds(hoop.store, id),
    replies: hoop.store.replies(id),
    // The threads resolved now, as src/rules.ts works it out, so the page keeps no rule of its own.
    threads_resolved: meta.ask || meta.build === "open" ? [] : threadViews(hoop.store, id).flatMap((t) => (t.status === "resolved" ? [t.thread] : [])),
    applied: hoop.store.applied(id),
    edits: hoop.store.proposals(id).map((p) => ({ ...p, position: p.status === "proposed" ? hoop.editPosition(id, p) : null })),
    // Whether each suggested removal can be applied now, as Apply decides it.
    removals: hoop.removalRefusals(id),
    history,
    history_blocks,
    renamed: hoop.store.renamed(id),
    trail: trail(hoop, id),
    receipts: hoop.store.receipts(id),
    deliveries: hoop.store.deliveries(id),
    // Whether each submitted review, by receipt key, asks Claude to act; the page says "not read yet" only then.
    asks_to_act: asksToAct(hoop, meta),
    // What Claude did after reading each submitted review: revised or replied, and when.
    responses: meta.ask ? undefined : responses(hoop, meta),
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

/**
 * What the build page needs: the blocks, the version to tell when to redraw, the history and the
 * markdown; and whether Claude's session waits on the build now, or when it last did.
 */
function buildView(hoop: Hoop, id: string) {
  const meta = hoop.store.meta(id);
  const build = hoop.builds.read(meta.id);
  // A request Claude took and left unanswered too long shows as queued again before Claude retakes it.
  requeue(build);
  const listening = isWaiting(hoop.store.home, meta.id);
  const checked = listening ? undefined : lastWaited(hoop.store.home, meta.id);
  return {
    claude: { listening, ...(checked ? { checked } : {}) },
    version: build.version,
    blocks: build.blocks,
    steps: build.steps,
    markdown: joinBlocks(build),
    // The requests still open, Claude's suggestions waiting on the person, and the sections whose earlier text Undo can put back.
    requests: (build.requests ?? []).filter((r) => r.status !== "written"),
    proposals: (build.proposals ?? []).filter((p) => p.status === "proposed"),
    undo: Object.keys(build.undo ?? {}),
    // What the person's last change removed, which Undo puts back after the block it followed.
    ...(build.removed ? { removed: { after: build.removed.after, before: build.removed.before, what: build.removed.what, level: build.removed.level } } : {}),
    // Claude's section texts waiting for the person to save or discard them.
    drafts: build.drafts ?? [],
    // Claude's block rewrites waiting to be accepted or undone.
    changes: (build.changes ?? []).filter((c) => c.blocks.some((b) => build.blocks.some((x) => x.id === b))),
    threads: (build.threads ?? []).filter((t) => t.status === "open"),
    // The documents Claude writes from, with its reason for one it couldn't open, and the person's brief.
    context: build.context ?? [],
    ...(build.brief ? { brief: build.brief } : {}),
    // Each section's earlier versions, and Claude's open notes on text it wrote that contradicts other text it wrote.
    history: build.history ?? {},
    notes: (build.notes ?? []).filter((n) => n.status === "open"),
  };
}

/** The drafts the page showed the person when they chose to finish without them (`discard_drafts`), or undefined. */
function draftsShown(body: unknown): DraftSeen[] | undefined {
  const list = isRecord(body) ? body.discard_drafts : undefined;
  if (list === undefined) return undefined;
  if (!isList(list)) throw new HoopError("expected discard_drafts: [{ section, block }]");
  return list.map((d) => {
    if (!isRecord(d) || typeof d.section !== "string" || typeof d.block !== "string") throw new HoopError("expected discard_drafts: [{ section, block }]");
    return { section: d.section, block: d.block };
  });
}

/**
 * A person's change to a build from the page. A change that asks Claude for something wakes the
 * session that started the build, as a submitted review does (`deliverBuild`).
 */
async function changeBuild(hoop: Hoop, id: string, body: Record<string, unknown>, opts: { sessions: SessionReader; send?: Sender }) {
  const meta = hoop.store.meta(id);
  const before = new Set((hoop.builds.has(meta.id) ? (hoop.builds.read(meta.id).requests ?? []) : []).map((r) => r.id));
  const build = hoop.buildChange(id, body);
  const added = (build.requests ?? []).find((r) => !before.has(r.id));
  if (!added) return;
  const queued = (build.requests ?? []).filter((r) => r.status === "queued").map((r) => r.id);
  await deliverBuild(hoop.store, meta, added.id, queued, opts);
}

/**
 * One event on a review, as its history shows it. The last event of each submitted review names it
 * in `review`, its `receiptKey`, so the history can say when the agent read it.
 */
export type TrailEntry = { at: string; who: string; what: string; revision?: number; review?: string };

/** A review's events: its comments, resolved threads and verdict, or an overall comment alone. */
function feedbackEvents(f: Feedback): TrailEntry[] {
  const out: TrailEntry[] = [];
  const at = { at: f.at, who: f.reviewer, revision: f.revision };
  const n = f.comments.length;
  const resolved = f.resolved_threads.length;
  if (n) out.push({ ...at, what: `${n} ${n === 1 ? "comment" : "comments"}` });
  if (resolved) out.push({ ...at, what: `resolved ${resolved} ${resolved === 1 ? "thread" : "threads"}` });
  if (f.verdict === "approved") out.push({ ...at, what: "approval" });
  if (f.verdict === "changes_requested") out.push({ ...at, what: "requested changes" });
  if (!n && f.verdict === "comment" && !resolved && f.summary) out.push({ ...at, what: "comment" });
  return out;
}

/** What each kind of applied change says in a review's history; anything else is an edit. */
const APPLIED: Partial<Record<Applied["kind"], string>> = { suggestion: "applied a suggestion", remove: "removed a section" };

/** Every event on a review, oldest first: reviews and their verdicts, replies, applied suggestions and edits. */
function trail(hoop: Hoop, id: string): TrailEntry[] {
  const out: TrailEntry[] = [];
  const counts: Record<number, number> = {};
  for (const f of hoop.store.allFeedback(id)) {
    const index = (counts[f.revision] = (counts[f.revision] ?? -1) + 1);
    const events = feedbackEvents(f);
    if (events.length) events.at(-1)!.review = receiptKey(f.revision, index);
    out.push(...events);
  }
  for (const r of hoop.store.replies(id)) out.push({ at: r.at, who: r.author, what: "reply" });
  // A person's closes, and the reopenings that followed.
  const meta = hoop.store.meta(id);
  const closedIt = (c: Closed): TrailEntry => ({ at: c.at, who: c.by, what: c.reason ? `closed it: ${c.reason}` : "closed it" });
  for (const c of meta.closes ?? []) out.push(closedIt(c), { at: c.reopened_at, who: c.reopened_by, what: "reopened it" });
  if (meta.closed) out.push(closedIt(meta.closed));
  for (const a of hoop.store.applied(id))
    out.push({
      at: a.at,
      who: a.by,
      what: APPLIED[a.kind] ?? "applied an edit",
      revision: a.revision,
    });
  for (const p of hoop.store.proposals(id)) {
    out.push({ at: p.at, who: "claude", what: "proposed an edit", revision: p.revision });
    if (p.decided_at && p.status !== "proposed") out.push({ at: p.decided_at, who: p.decided_by ?? "reviewer", what: `${p.status} an edit` });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

function routes(hoop: Hoop, files = snapshot(), opts: PagesOptions = {}): [string, RegExp, Handler][] {
  // A secret of this process's, which only a page it served holds: an HttpOnly cookie, sent only to
  // the permission answers, never written to disk or into any reply's body.
  const answerKey = randomBytes(32).toString("hex");
  const page = (_req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("set-cookie", `${ANSWER_COOKIE}=${answerKey}; HttpOnly; SameSite=Strict; Path=/api/permissions`);
    send(res, 200, files.get("index.html")!, "text/html; charset=utf-8");
  };
  const install = ownInstall();
  const started = { release: release(install), code: codeId(install) };
  // Pull request states are read from gh only while Home asks for them.
  const prStates = new PrStates(opts.gh);
  const sessions = opts.sessions ?? claudeSessions;
  const steer = new Steer(hoop.store.home, sessions, {
    ...(opts.send ? { send: opts.send } : {}),
    ...(opts.steerMs !== undefined ? { delayMs: opts.steerMs } : {}),
  });
  // A todo's description that links to a review shows the review's title; a running todo's links to
  // reviews and pull requests say what it waits on. Pull request states are read in the background.
  const review = (id: string) => {
    try {
      const meta = hoop.store.meta(id);
      // The waiting clock counts from the latest revision; a reply or a touch later doesn't move it.
      const at = hoop.store.revisionAt(id) ?? meta.created;
      return {
        ...(meta.title ? { title: meta.title } : {}),
        status: reviewStatus(hoop.store, meta).status_key,
        at,
        ...(meta.status === "approved" && meta.approved_at ? { approved_at: meta.approved_at } : {}),
      };
    } catch {
      return undefined;
    }
  };
  const pr = (url: string) => {
    void prStates.get(url);
    return prStates.known(url);
  };
  // Hooks drop their input while no pages process runs, so stamps count only from this one's start.
  const hooksSince = opts.hooksSince ?? Date.now();
  const evidence = () => ({
    review,
    pr,
    tracked: trackedPrs(hoop.store.home).map((p) => ({ url: p.url, session: p.owner.session, added: p.added })),
  });
  const work = () => linkTodos(workView(hoop.store.home, sessions), evidence());
  // The done gate reads the same evidence, and reads its pull requests again from gh, past the cache.
  const doneLook = (gone: () => boolean) => ({ evidence: evidence(), fresh: (url: string) => prStates.get(url, true), gone });
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
      const delivery = await deliverAction(hoop.store.home, item, { sessions, ...(opts.send ? { send: opts.send } : {}) });
      return delivery ? actions.delivered(id, delivery) : item;
    });
  const store = storeKey(hoop.store.home);
  const reviewApi = (tail = "") => new RegExp(`^/api/reviews/(${REVIEW_ID_PATTERN})${tail}$`);
  return [
    ["GET", /^\/$/, page],
    ["GET", new RegExp(`^/r/(${REVIEW_ID_PATTERN})$`), page],
    ["GET", /^\/work$/, page],
    [
      "GET",
      /^\/api\/reviews$/,
      (_q, res) => {
        const live = openState(hoop).live,
          running = once(sessions);
        send(
          res,
          200,
          hoop.store.list().map((m) => ({ ...pageMeta(hoop, m), ...listed(hoop, m, live, running), summary: reviewSummary(hoop.store.revision(m.id)) })),
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
        steer.markRead(view);
        steer.settleAdds(view);
        steer.noteDone(view);
        // The history is a nicety: a write that fails never fails the page.
        try {
          recordStates(hoop.store.home, view);
        } catch {
          /* the next ask tries again */
        }
        // Running sessions whose hooks don't reach hoop, with work or not.
        const hooks = hookWarnings(hoop.store.home, sessions(), hooksSince);
        // With messages off in hoop's off list, the page says why a change waits for the gate.
        const off = isOff(hoop.store.home, "messages");
        send(res, 200, { sessions: view, ...(hooks.length ? { hooks } : {}), ...(off ? { messages_off: true } : {}) });
      },
    ],
    [
      "POST",
      /^\/api\/work\/([A-Za-z0-9_-]{1,128})\/changes$/,
      async (req, res, [session]) => {
        const inputs = field(await readJson(req), "changes");
        const changes = await queue.run(`work:${session}`, () => steer.record(session!, inputs));
        if (!changes) return send(res, 404, { error: `no work for session ${session}` });
        send(res, 201, { changes, session: work().find((s) => s.id === session) });
      },
    ],
    // A request the person says needs no todos stops showing as not registered, until they undo it
    // (`undo: true`), when it shows as not registered again.
    [
      "POST",
      /^\/api\/work\/([A-Za-z0-9_-]{1,128})\/dismiss$/,
      async (req, res, [session]) => {
        const body = await readJson(req);
        const id = field(body, "request");
        if (typeof id !== "string" || !/^[A-Za-z0-9_:.-]{1,128}$/.test(id)) throw new HoopError("expected { request: <request ID> }");
        const undo = field(body, "undo") === true;
        const done = await queue.run(`work:${session}`, () =>
          editWork(hoop.store.home, session!, (r) => {
            const was = Array.isArray(r.dismissed) ? r.dismissed : [];
            r.dismissed = undo ? was.filter((x) => x !== id) : [...new Set([...was, id])].slice(-DISMISSED_MAX);
            return true;
          }),
        );
        if (!done) return send(res, 404, { error: `no work for session ${session}` });
        send(res, 201, { session: work().find((s) => s.id === session) });
      },
    ],
    // The person removes hoop's own record of an ended session: its work record, gate files and hook
    // stamps. Claude Code's transcript and session stay; a later hook from it starts a fresh record.
    [
      "POST",
      /^\/api\/work\/([A-Za-z0-9_-]{1,128})\/remove$/,
      async (req, res, [session]) => {
        await readJson(req);
        const done = await queue.run(`work:${session}`, () => {
          const out = removeWork(hoop.store.home, session!, { sessions, lastHook: lastStamp(hoop.store.home, session!) });
          if (out === "removed") dropStamps(hoop.store.home, session!);
          return out;
        });
        if (done === "none") return send(res, 404, { error: `no work for session ${session}` });
        if (done !== "removed") return send(res, 409, { error: KEEPS[done], reason: done });
        send(res, 200, { removed: session });
      },
    ],
    ["GET", /^\/api\/prs$/, async (_q, res) => send(res, 200, await prList(hoop, prStates))],
    // Home's "Your response times": read from what hoop keeps here, and never sent anywhere else (src/loop-time.ts).
    ["GET", /^\/api\/loop-time$/, (_q, res) => send(res, 200, loopTimes(waits(hoop.store, actions.list())))],
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
        const live = openState(hoop).live,
          running = once(sessions);
        send(
          res,
          200,
          actions.list().map((i) => actionView(hoop, i, live, running, prStates)),
        );
      },
    ],
    // Permission prompts waiting on the person, and how the latest ones were answered (src/permissions.ts).
    [
      "GET",
      /^\/api\/permissions$/,
      async (_q, res) => {
        const list = await queue.run(PERMISSIONS_KEY, () => (prunePermissions(hoop.store.home), listPermissions(hoop.store.home)));
        send(
          res,
          200,
          list.map((p) => ({ ...p, session_label: hoop.ownerLabel({ session: p.session }) })),
        );
      },
    ],
    // The person's Allow once or Deny (with an optional reason Claude reads). The first answer wins.
    [
      "POST",
      /^\/api\/permissions\/(pm_[a-z0-9]+)$/,
      async (req, res, [id]) => {
        const refused = answerRefusal(req, answerKey);
        if (refused) return send(res, 403, { error: refused });
        const body = await readJson(req);
        try {
          send(res, 200, await queue.run(PERMISSIONS_KEY, () => answerPermission(hoop.store.home, id!, body, currentUser())));
        } catch (err) {
          const state = err instanceof HoopError ? err.detail?.state : undefined;
          if (!state) throw err;
          send(res, 409, { error: err instanceof Error ? err.message : String(err), state });
        }
      },
    ],
    // The person ticks a manual item done, says Won't do with a reason, or undoes their Done.
    [
      "POST",
      /^\/api\/actions\/(ac_[a-z0-9]+)$/,
      async (req, res, [id]) => {
        const body = await readJson(req);
        const action = field(body, "action");
        let item: ActionItem;
        if (action === "done") {
          if (actions.get(id!).done_when.kind !== "manual") throw new HoopError("only a manual item is ticked done; hoop checks the others itself");
          item = await closeAction(id!, "done", currentUser());
        } else if (action === "wont_do") {
          const reason = validReason(field(body, "reason"));
          item = await closeAction(id!, "wont_do", currentUser(), reason);
        } else if (action === "reopen") {
          // Undo after Done: the item is open again, and the session that added it is told.
          item = await queue.run(ACTIONS_KEY, async () => {
            const open = actions.reopen(id!);
            const delivery = await deliverAction(hoop.store.home, open, { sessions, ...(opts.send ? { send: opts.send } : {}) });
            return delivery ? actions.delivered(id!, delivery) : open;
          });
        } else throw new HoopError('expected { action: "done" }, { action: "wont_do", reason } or { action: "reopen" }');
        send(res, 201, actionView(hoop, item, openState(hoop).live, sessions));
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
          // Whether a session on this machine has recorded todos or subagents, which shows the Work link.
          work: hasWork(hoop.store.home),
          // Diagrams off in hoop's off list: pages show a diagram's source and load no library.
          ...(isOff(hoop.store.home, "mermaid") ? { diagrams_off: true } : {}),
          ...updateInfo(opts.updates, install, started.release),
        }),
    ],
    ["GET", reviewApi(), (_q, res, [id]) => send(res, 200, reviewView(hoop, id!, sessions))],
    // The page asks for this every few seconds, to show whether the agent waits for the review.
    ["GET", reviewApi("/agent"), (_q, res, [id]) => send(res, 200, { agent: agentState(hoop.store, hoop.store.meta(id!), sessions) ?? null })],
    // The build page asks for this every few seconds, to show Claude's changes.
    ["GET", reviewApi("/build"), (_q, res, [id]) => send(res, 200, buildView(hoop, id!))],
    [
      "POST",
      reviewApi("/build"),
      async (req, res, [id]) => {
        const body = await readJson(req);
        if (!isRecord(body)) throw new HoopError("expected a JSON object");
        await queue.run(id!, () => changeBuild(hoop, id!, body, { sessions, ...(opts.send ? { send: opts.send } : {}) }));
        send(res, 201, buildView(hoop, id!));
      },
    ],
    [
      "POST",
      reviewApi("/finish"),
      async (req, res, [id]) => {
        // Once the person chose to finish without Claude's drafts, the page sends the ones it showed them.
        const body = await readJson(req);
        send(res, 201, await queue.run(id!, () => hoop.finishBuild(id!, draftsShown(body))));
      },
    ],
    // The page asks for these every few seconds, to show when the agent read each submitted review.
    [
      "GET",
      reviewApi("/receipts"),
      (_q, res, [id]) => {
        const meta = hoop.store.meta(id!);
        // What Claude did after each read, so a receipt that turns read shows "No response yet" at once.
        send(res, 200, { receipts: hoop.store.receipts(meta.id), ...(meta.ask ? {} : { responses: responses(hoop, meta) }) });
      },
    ],
    [
      "POST",
      reviewApi("/feedback"),
      async (req, res, [id]) => {
        const body = await readJson(req);
        if (!isRecord(body)) throw new HoopError("expected a JSON object");
        const out = await queue.run(id!, async () => {
          const stored = hoop.review(id!, body, true);
          // The person's review wakes the session that asked for it; the page says whether it did.
          const delivery = await deliverReview(hoop.store, stored, { sessions, ...(opts.send ? { send: opts.send } : {}) });
          // The review page shows the review as it is now from this answer, without asking again.
          return { ...stored, ...(delivery ? { delivery } : {}), view: reviewView(hoop, id!, sessions) };
        });
        send(res, 201, out);
      },
    ],
    // A person's answer to a quick question: saved and sent at once, with no review to submit.
    [
      "POST",
      reviewApi("/answer"),
      async (req, res, [id]) => {
        const body = await readJson(req);
        if (!isRecord(body)) throw new HoopError("expected a JSON object");
        const delivery = await queue.run(id!, async () => {
          const { feedback, quiet } = hoop.answer(id!, body);
          // A change to an answer Claude hasn't read yet replaces it quietly; any other answer wakes the session.
          return quiet ? undefined : await deliverReview(hoop.store, feedback, { sessions, ...(opts.send ? { send: opts.send } : {}) });
        });
        send(res, 201, { ...reviewView(hoop, id!, sessions), ...(delivery ? { delivery } : {}) });
      },
    ],
    // A person closes a review they no longer need, without approving it, or reopens it, which brings
    // back the status it had; either way the owner's session hears of it.
    [
      "POST",
      reviewApi("/(close|reopen)"),
      async (req, res, [id, action]) => {
        const body: unknown = await readJson(req);
        const raw = body && typeof body === "object" && "reason" in body ? body.reason : undefined;
        const reason = raw === undefined || raw === "" ? undefined : validReason(raw);
        const delivery = await queue.run(id!, () =>
          deliverClose(hoop.store, action === "close" ? hoop.close(id!, reason) : hoop.reopen(id!), { sessions, ...(opts.send ? { send: opts.send } : {}) }),
        );
        send(res, 201, { ...reviewView(hoop, id!, sessions), ...(delivery ? { delivery } : {}) });
      },
    ],
    // A diagram the page couldn't draw, which Claude reads in its next feedback.
    [
      "POST",
      reviewApi("/diagram-error"),
      async (req, res, [id]) => {
        const body = await readJson(req);
        if (!isRecord(body)) throw new HoopError("expected a JSON object");
        send(res, 201, { recorded: await queue.run(id!, () => hoop.reportDiagram(id!, body)) });
      },
    ],
    [
      "POST",
      reviewApi(`/edits/(${childPattern("ed")})`),
      async (req, res, [id, edit]) => {
        const action = field(await readJson(req), "action");
        if (action !== "accept" && action !== "reject") throw new HoopError('expected { action: "accept" | "reject" }');
        send(res, 201, await queue.run(id!, () => hoop.decideEdit(id!, edit!, action)));
      },
    ],
    [
      "POST",
      /^\/api\/sessions\/([A-Za-z0-9_-]{1,128})\/name$/,
      async (req, res, [session]) => {
        const name = field(await readJson(req), "name");
        // Only a session that owns a review here can be renamed from the pages, also under the ID its process runs now.
        let running: ReturnType<SessionReader> = [];
        try {
          running = sessions();
        } catch {
          /* only recorded IDs count */
        }
        const owns = (o: Owner) => o.session === session || (o.claude !== false && ownerSession(o, running)?.session === session);
        const owners = hoop.store.list().flatMap((m) => (m.owner && owns(m.owner) ? [m.owner] : []));
        if (!owners.length) return send(res, 404, { error: `no session ${session}` });
        // Only a Claude Code session has a transcript to write the name to.
        const claude = owners.every((o) => o.claude !== false);
        const renamed = await queue.run("names", () => renameSession(hoop.store.home, session!, name, claude));
        send(res, 201, { session, ...renamed, label: sessionLabel({ session: session!, name: renamed.name }) });
      },
    ],
    // Home's Open a sample review: the sample still open, or a new one (src/sample.ts).
    [
      "POST",
      /^\/api\/sample$/,
      async (req, res) => {
        await readJson(req);
        send(res, 201, await queue.run("sample", () => hoop.openSample()));
      },
    ],
    [
      "POST",
      reviewApi("/apply"),
      async (req, res, [id]) => {
        const thread = field(await readJson(req), "thread");
        if (typeof thread !== "string") throw new HoopError("expected { thread }");
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
        if (!isRecord(body)) throw new HoopError("expected a JSON object");
        const b = body;
        // A hook that gave up waiting closed its request: the done gate then records no refusal.
        let gone = false;
        res.on("close", () => {
          gone ||= !res.writableEnded;
        });
        const out = (await queue.run(write.key(b), () => write.run(hoop.store, b, { done: () => doneLook(() => gone) }))) ?? null;
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
    const refused = req.method === "GET" ? undefined : writeRefusal(req, allowed);
    if (refused) return send(res, ...refused);
    try {
      await route(req, res, url.pathname, files, table);
    } catch (err) {
      send(res, ...errorReply(err));
    }
  });
}

/** Serves a request from the page files, or the first route that matches it. */
async function route(req: IncomingMessage, res: ServerResponse, path: string, files: Map<string, string>, table: [string, RegExp, Handler][]) {
  const file = STATIC[path];
  if (req.method === "GET" && file) return send(res, 200, files.get(file[0])!, file[1]);
  for (const [method, pattern, handler] of table) {
    const m = path.match(pattern);
    if (m && req.method === method) return await handler(req, res, m.slice(1));
  }
  send(res, 404, { error: `no route for ${req.method} ${path}` });
}

/** The cookie that carries the pages process's answer key to the permission answers. */
const ANSWER_COOKIE = "hoop_answer";

/**
 * Why an answer to a permission prompt is refused: only a page this process served answers, from
 * the browser. It needs the page's own Origin (the host it asked, already one of the allowed ones),
 * the browser's word that the request is same-origin, and the page's answer key cookie. A program of
 * the person's own that forges all three can still answer: hoop can't stop the person's processes.
 */
function answerRefusal(req: IncomingMessage, key: string): string | undefined {
  if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`) return "answers come only from hoop's pages";
  if (req.headers["sec-fetch-site"] !== "same-origin") return "answers come only from hoop's pages, in a browser";
  const sent = /(?:^|;\s*)hoop_answer=([0-9a-f]{64})(?:;|$)/.exec(String(req.headers.cookie ?? ""))?.[1];
  if (!sent || !timingSafeEqual(Buffer.from(sent), Buffer.from(key))) return "answers come only from a page these pages served: reload it";
  return undefined;
}

/** Why a request that writes is refused: another site's Origin, or a body that isn't JSON. */
function writeRefusal(req: IncomingMessage, allowed: string[]): [number, { error: string }] | undefined {
  const origin = req.headers.origin;
  if (origin && !allowed.some((h) => origin === `http://${h}`)) return [403, { error: "cross-origin request refused" }];
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return [415, { error: "send JSON with content-type: application/json" }];
  return undefined;
}

/**
 * A handler's error as a reply: a refusal with its fields, a missing review, or a failure. A
 * failure's message and stack go to the pages log, not to the page; only an `Error`'s message is
 * ever sent, so a thrown value that isn't one (whose text may hold anything) is a failure.
 */
function errorReply(err: unknown): [number, Record<string, unknown>] {
  if (err instanceof HoopError) return [400, { error: err.message, errors: err.errors, ...(err.detail ? { detail: err.detail } : {}) }];
  if (err instanceof Error && /^(no review|invalid review id) /.test(err.message)) return [404, { error: err.message }];
  // The stack is read here, not through `field`: a stack read inside a shared getter taints every
  // value that getter returns, which CodeQL then follows into replies (alert 63).
  const message = err instanceof Error ? err.message : String(err);
  logFailure(message, err instanceof Error ? err.stack : undefined);
  return [500, { error: `hoop failed on this request; ${join(hoopHome(), "pages.jsonl")} has the details` }];
}

const REPEAT_LOG_MS = 60_000;
const FAILURES_KEPT = 100;
/** Each failure's message, with how often it repeated since it was last logged and when that was. */
const failures = new Map<string, { at: number; repeats: number }>();

/**
 * Logs a failed request: its first time with its stack, then how often it repeated, at most once a
 * minute, so a failure that repeats on every poll doesn't grow the log without limit.
 */
function logFailure(message: string, stack: unknown): void {
  const seen = failures.get(message);
  if (!seen) {
    if (failures.size >= FAILURES_KEPT) failures.clear();
    failures.set(message, { at: Date.now(), repeats: 0 });
    logPages("request_failed", { error: message, stack });
    return;
  }
  seen.repeats++;
  if (Date.now() - seen.at < REPEAT_LOG_MS) return;
  logPages("request_failed", { error: message, repeats: seen.repeats });
  Object.assign(seen, { at: Date.now(), repeats: 0 });
}

/** A newer hoop than these pages run, with the command Home shows for it, or nothing. */
function updateInfo(updates: UpdateCheck | undefined, install: string, current: string | undefined) {
  const latest = updates?.available(current);
  return latest ? { update: { latest, command: updateCommand(install) } } : {};
}

/**
 * Serves the review pages on localhost, or resolves undefined when the port is taken. It checks for a
 * newer hoop at most once a day, unless HOOP_NO_UPDATE_CHECK is set.
 */
export function startWeb(hoop = new Hoop(), port = PORT, opts: PagesOptions = {}): Promise<Server | undefined> {
  const updates = opts.updates ?? (process.env.HOOP_NO_UPDATE_CHECK ? undefined : new UpdateCheck(hoop.store.home, opts.npm));
  return new Promise((resolve, reject) => {
    const server = createWebServer(hoop, [], { ...opts, ...(updates ? { updates } : {}) });
    server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(undefined) : reject(err)));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
