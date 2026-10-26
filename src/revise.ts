// Changes to one block of a build rather than a whole section: Generate again on a block Claude
// wrote, and comments the person leaves on a block in Preview. Claude answers with a rewrite of the
// block, which waits as a change the person accepts or undoes, or (for a comment) with a reply in
// its thread. These functions change a build in place; `Builds` saves each as a step.
import { parentOf } from "../web/blocks.js";
import type { Build, BuildBlock, BuildThread, GenRequest } from "./build.js";
import { levelOf, splitBlocks } from "./build-blocks.js";
import { HoopError } from "./util.js";

/** The block with ID `block`, by index, or the refusal. */
function indexOf(build: Build, block: string): number {
  const i = build.blocks.findIndex((b) => b.id === block);
  if (i < 0) throw new HoopError(`the build has no block ${block}`);
  return i;
}

/** A new request's ID: one more than the highest so far, so a replaced request's ID is never reused. */
export const nextRequestId = (requests: GenRequest[]) => `g${Math.max(0, ...requests.map((r) => Number(r.id.slice(1)) || 0)) + 1}`;

/** A request about one block: Generate again, or a comment. */
const onBlock = (r: GenRequest) => r.kind === "rewrite" || r.kind === "revise";
const open = (r: GenRequest) => onBlock(r) && r.status !== "written";

/** Generate again on a block Claude wrote, with an optional note on what should change. A newer one replaces one Claude hasn't taken. */
export function askRewrite(build: Build, block: string, note?: string): string {
  const b = build.blocks[indexOf(build, block)]!;
  if (levelOf(b)) throw new HoopError("a heading is written with Generate on it; press Generate again on a block under it");
  if (b.by !== "claude") throw new HoopError("only a block Claude wrote can be written again; edit it instead");
  const requests = (build.requests ??= []);
  const id = nextRequestId(requests);
  build.requests = requests.filter((r) => !(r.block === block && r.kind === "rewrite" && r.status === "queued"));
  const line = note?.trim();
  build.requests.push({ id, kind: "rewrite", block, ...(line ? { note: line } : {}), at: new Date().toISOString(), status: "queued" });
  return "asked Claude to write a block again";
}

/**
 * The person took over blocks `ids` (edited or removed them, or Claude wrote their section): open
 * rewrites on them close as overtaken, so a late write from Claude can't replace the person's text.
 */
export function overtake(build: Build, ids: string[]): void {
  const at = new Date().toISOString();
  for (const r of build.requests ?? []) if (open(r) && ids.includes(r.block)) Object.assign(r, { status: "written", written_at: at, overtaken: true });
}

/** Drops the waiting changes whose blocks are all gone. */
export function prune(build: Build): void {
  if (!build.changes) return;
  const here = new Set(build.blocks.map((b) => b.id));
  build.changes = build.changes.filter((c) => c.blocks.some((id) => here.has(id)));
}

/** A person's edit split block `old` into `ids` (the first keeps its ID): a waiting change on it covers them all, so Undo puts back all of it. */
export function splitInChange(build: Build, old: string, ids: string[]): void {
  const c = (build.changes ?? []).find((x) => x.blocks.includes(old));
  if (c && ids.length > 1) c.blocks.splice(c.blocks.indexOf(old) + 1, 0, ...ids.slice(1));
}

/**
 * The request Claude's write of `block` answers: the one it took on the block (`request`, which is
 * needed when it took more than one there), unchanged since. Else the refusal, saying why: the
 * person resolved the comment or changed the block, Claude already rewrote it, or nobody asked.
 */
function answered(build: Build, block: string, text: string | undefined, request?: string): GenRequest {
  const requests = build.requests ?? [];
  const takens = requests.filter((r) => onBlock(r) && r.status === "taken" && r.block === block);
  if (request === undefined && takens.length > 1)
    throw new HoopError(`requests ${takens.map((r) => r.id).join(" and ")} are both taken on block ${block}: pass request to say which this answers`);
  const named = request === undefined ? undefined : requests.find((r) => r.id === request);
  if (request !== undefined && (!named || !onBlock(named) || (named.block !== block && named.given_block !== block)))
    throw new HoopError(`request ${request} isn't a rewrite or comment on block ${block}`);
  const taken = named ?? takens[0];
  if (taken && taken.status === "taken" && taken.block === block && taken.given === text) return taken;
  if (taken?.resolved) throw new HoopError(`the person resolved this comment (request ${taken.id}), so it is closed; call hoop_build_wait again`);
  const late =
    (taken?.status === "taken" || taken?.overtaken ? taken : undefined) ??
    requests.find((r) => onBlock(r) && r.overtaken && (r.block === block || r.given_block === block));
  if (late?.resolved) throw new HoopError(`the person resolved this comment (request ${late.id}), so it is closed; call hoop_build_wait again`);
  if (late)
    throw new HoopError(
      `the person changed block ${block} after you took request ${late.id}, so their text stays and the request is closed; call hoop_build_wait again`,
    );
  const moved = requests.find((r) => onBlock(r) && r.given_block === block && r.block !== block);
  if (moved) throw new HoopError(`block ${block} was already rewritten as ${moved.block}; call hoop_build_wait for the newer request`);
  throw new HoopError(`block ${block} has no rewrite request open; write a block only for a "rewrite" or "revise" request from hoop_build_wait`);
}

/**
 * Claude's new text for one block, in its place, answering the rewrite request Claude took on it:
 * it may be several blocks, but no heading, since the person owns the outline. It waits as a change
 * to accept or undo, which keeps the block as it was before Claude first changed it. Other requests
 * on the block follow it to its new text, and one Claude took but hasn't answered is queued again,
 * so Claude gets it with the new text.
 */
export function writeBlock(build: Build, block: string, markdown: string, which?: string): string {
  const i = build.blocks.findIndex((b) => b.id === block);
  const old = build.blocks[i];
  if (old && levelOf(old)) throw new HoopError(`block ${block} is a heading: write everything under it with section`);
  const request = answered(build, block, old?.text, which);
  if (!old) throw new HoopError(`the build has no block ${block}`);
  const parts = splitBlocks(markdown.replace(/\r\n?/g, "\n")).blocks;
  if (!parts.length) throw new HoopError("the block needs text");
  const heading = parts.find((p) => levelOf(p));
  if (heading) throw new HoopError(`a block's text can't hold a heading ("${heading.text}"); the person owns the outline`);
  const written: BuildBlock[] = parts.map((p, k) => {
    const sep = k + 1 < parts.length ? p.sep : old.sep;
    return { id: `b${build.next++}`, kind: p.kind, text: p.text, ...(sep === undefined ? {} : { sep }), by: "claude", generated: true };
  });
  build.blocks.splice(i, 1, ...written);
  const ids = written.map((b) => b.id);
  const changes = (build.changes ??= []);
  const change = changes.find((c) => c.blocks.includes(block));
  if (change) change.blocks.splice(change.blocks.indexOf(block), 1, ...ids);
  else changes.push({ id: `c${Math.max(0, ...changes.map((c) => Number(c.id.slice(1)) || 0)) + 1}`, request: request.id, blocks: ids, before: [old] });
  Object.assign(request, { status: "written", written_at: new Date().toISOString(), block: ids[0]! });
  for (const r of build.requests ?? []) {
    if (r === request || !open(r) || r.block !== block) continue;
    r.block = ids[0]!;
    if (r.status === "taken") r.status = "queued";
  }
  const shown = plain(written.map((b) => b.text).join(" "));
  for (const t of build.threads ?? []) {
    if (t.block !== block) continue;
    t.block = ids[0]!;
    // A comment on words the rewrite no longer has is outdated, as on the review page.
    if (t.selection && !shown.includes(plain(t.selection))) t.outdated = true;
  }
  return "rewrote a block";
}

/** The waiting change Claude made that holds `block`, or the refusal. */
function changeOf(build: Build, block: string) {
  const c = (build.changes ?? []).find((x) => x.blocks.includes(block));
  if (!c) throw new HoopError(`block ${block} has no change of Claude's waiting`);
  return c;
}

/** Keeps Claude's rewrite: the change stops waiting, and its blocks stay as Claude wrote them. */
export function acceptChange(build: Build, block: string): string {
  const c = changeOf(build, block);
  build.changes = build.changes!.filter((x) => x !== c);
  return "accepted Claude's change";
}

/** Undoes Claude's rewrite: the block as it was comes back in place of what Claude wrote. */
export function undoChange(build: Build, block: string): string {
  const c = changeOf(build, block);
  const at = build.blocks.findIndex((b) => c.blocks.includes(b.id));
  if (at < 0) throw new HoopError("what Claude wrote there is gone, so there is nothing to undo");
  overtake(build, c.blocks);
  build.blocks = build.blocks.filter((b) => !c.blocks.includes(b.id));
  build.blocks.splice(at, 0, ...c.before);
  for (const t of build.threads ?? []) if (c.blocks.includes(t.block)) t.block = c.before[0]!.id;
  build.changes = build.changes!.filter((x) => x !== c);
  return "undid Claude's change";
}

/**
 * The person's comment on a block in Preview, about the words they selected or the whole block: a
 * thread beside the block, and a "revise" request that Claude answers with a rewrite or a reply.
 */
export function addComment(build: Build, reviewId: string, block: string, comment: string, selection?: string, occurrence?: number): string {
  const i = indexOf(build, block);
  if (levelOf(build.blocks[i]!)) throw new HoopError("a heading takes Generate; comment on a block under it");
  const body = comment.trim();
  if (!body) throw new HoopError("a comment needs text");
  if (body.length > COMMENT_MAX) throw new HoopError(`a comment is at most ${COMMENT_MAX} characters`);
  const words = selection?.replace(/\s+/g, " ").trim();
  if (words && words.length > SELECTION_MAX) throw new HoopError(`select at most ${SELECTION_MAX} characters to comment on`);
  if (occurrence !== undefined && !(Number.isInteger(occurrence) && occurrence >= 0)) throw new HoopError("occurrence is a whole number from 0");
  const threads = (build.threads ??= []);
  const id = `bt_${reviewId.slice(3)}_${Math.max(0, ...threads.map((t) => Number(t.id.split("_").at(-1)) || 0)) + 1}`;
  const requests = (build.requests ??= []);
  const request = nextRequestId(requests);
  const at = new Date().toISOString();
  requests.push({ id: request, kind: "revise", block, thread: id, at, status: "queued" });
  const which = words && occurrence !== undefined ? { occurrence } : {};
  threads.push({ id, block, ...(words ? { selection: words, ...which } : {}), comment: body, at, request, status: "open", replies: [] });
  return "commented on a block";
}

function findThread(build: Build, thread: string): BuildThread {
  const t = (build.threads ?? []).find((x) => x.id === thread);
  if (!t) throw new HoopError(`the build has no comment ${thread}`);
  return t;
}

/** Resolves a comment thread: it leaves the page, and Claude no longer acts on it. Resolving it again changes nothing (undefined). */
export function resolveThread(build: Build, thread: string): string | undefined {
  const t = findThread(build, thread);
  if (t.status === "resolved") return undefined;
  t.status = "resolved";
  for (const r of build.requests ?? [])
    if (r.id === t.request && r.status !== "written") Object.assign(r, { status: "written", overtaken: true, resolved: true });
  return "resolved a comment";
}

/**
 * Claude's reply in a comment's thread, on any open comment on a block still there. A reply never
 * changes the document, so it needs no request taken; it answers the comment's request if open.
 */
export function replyInThread(build: Build, thread: string, body: string): string {
  const t = findThread(build, thread);
  if (!body.trim()) throw new HoopError("a reply needs text");
  if (body.trim().length > COMMENT_MAX) throw new HoopError(`a reply is at most ${COMMENT_MAX} characters`);
  if (t.status !== "open") throw new HoopError(`the person resolved comment ${thread}; call hoop_build_wait again`);
  if (!build.blocks.some((b) => b.id === t.block)) throw new HoopError(`the block comment ${thread} was on is gone; the person can resolve it`);
  const at = new Date().toISOString();
  t.replies.push({ by: "claude", body: body.trim(), at });
  for (const r of build.requests ?? []) if (r.id === t.request && r.status !== "written") Object.assign(r, { status: "written", written_at: at });
  return "replied to a comment";
}

/** The longest comment or reply, and the longest selection a comment is on. */
const COMMENT_MAX = 2000;
const SELECTION_MAX = 500;

/** Text without markdown's marks and extra spaces, to tell whether quoted words are still there. */
const plain = (text: string) =>
  text
    .replace(/[*_`#>[\]()|~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** What Claude's session gets with a comment's request: the comment, the selected words (and which of them) and the thread. */
export function threadTask(build: Build, thread: string | undefined) {
  const t = thread ? build.threads?.find((x) => x.id === thread) : undefined;
  if (!t) return {};
  return {
    comment: t.comment,
    thread: t.id,
    ...(t.selection ? { selection: t.selection } : {}),
    ...(t.occurrence !== undefined ? { occurrence: t.occurrence } : {}),
  };
}

/** What Claude's session gets for a block request: the block, its text, and the heading it sits under. */
export function blockTask(build: Build, block: string) {
  const i = build.blocks.findIndex((b) => b.id === block);
  if (i < 0) return undefined;
  const p = parentOf(build.blocks, i);
  const heading = p >= 0 ? build.blocks[p]! : undefined;
  return { block, block_markdown: build.blocks[i]!.text, section: heading?.id ?? "", heading: heading?.text ?? "" };
}
