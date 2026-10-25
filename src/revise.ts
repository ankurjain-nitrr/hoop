// Changes to one block of a build rather than a whole section: Generate again on a block Claude
// wrote. Claude answers with a rewrite of the block, which waits as a change the person accepts or
// undoes. These functions change a build in place; `Builds` saves each as a step.
import { parentOf } from "../web/blocks.js";
import { type Build, type BuildBlock, type GenRequest, levelOf, nextRequestId, splitBlocks } from "./build.js";
import { HoopError } from "./util.js";

/** The block with ID `block`, by index, or the refusal. */
function indexOf(build: Build, block: string): number {
  const i = build.blocks.findIndex((b) => b.id === block);
  if (i < 0) throw new HoopError(`the build has no block ${block}`);
  return i;
}

const open = (r: GenRequest) => r.kind === "rewrite" && r.status !== "written";

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
 * The rewrite request Claude's write of `block` answers: the one it took on the block, unchanged
 * since. Else the refusal, saying why: the person changed the block, Claude already rewrote it, or
 * nobody asked.
 */
function answered(build: Build, block: string, text: string | undefined): GenRequest {
  const requests = build.requests ?? [];
  const taken = requests.find((r) => r.kind === "rewrite" && r.status === "taken" && r.block === block);
  if (taken && taken.given === text) return taken;
  const late = taken ?? requests.find((r) => r.kind === "rewrite" && r.overtaken && (r.block === block || r.given_block === block));
  if (late)
    throw new HoopError(
      `the person changed block ${block} after you took request ${late.id}, so their text stays and the request is closed; call hoop_build_wait again`,
    );
  const moved = requests.find((r) => r.kind === "rewrite" && r.given_block === block && r.block !== block);
  if (moved) throw new HoopError(`block ${block} was already rewritten as ${moved.block}; call hoop_build_wait for the newer request`);
  throw new HoopError(`block ${block} has no rewrite request open; write a block only for a "rewrite" request from hoop_build_wait`);
}

/**
 * Claude's new text for one block, in its place, answering the rewrite request Claude took on it:
 * it may be several blocks, but no heading, since the person owns the outline. It waits as a change
 * to accept or undo, which keeps the block as it was before Claude first changed it. Other requests
 * on the block follow it to its new text, and one Claude took but hasn't answered is queued again,
 * so Claude gets it with the new text.
 */
export function writeBlock(build: Build, block: string, markdown: string): string {
  const i = build.blocks.findIndex((b) => b.id === block);
  const old = build.blocks[i];
  if (old && levelOf(old)) throw new HoopError(`block ${block} is a heading: write everything under it with section`);
  const request = answered(build, block, old?.text);
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
  build.changes = build.changes!.filter((x) => x !== c);
  return "undid Claude's change";
}

/** What Claude's session gets for a block request: the block, its text, and the heading it sits under. */
export function blockTask(build: Build, block: string) {
  const i = build.blocks.findIndex((b) => b.id === block);
  if (i < 0) return undefined;
  const p = parentOf(build.blocks, i);
  const heading = p >= 0 ? build.blocks[p]! : undefined;
  return { block, block_markdown: build.blocks[i]!.text, section: heading?.id ?? "", heading: heading?.text ?? "" };
}
