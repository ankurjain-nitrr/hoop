// What Claude writes a build from: the context documents the person lists (links Claude can open,
// or paths to files on this machine) and their brief (audience, tone, length, free text). hoop keeps
// only the list and never opens a document itself; Claude reads each with its own tools. Every
// request Claude takes carries the list and the brief as they stand when it takes it. These
// functions change a build in place; `Builds` saves each as a step.
import type { Build } from "./build.js";
import { HoopError } from "./util.js";

/** A document Claude writes from. `unreadable` is Claude's reason it couldn't open it, until a write of Claude's uses it. */
export type ContextDoc = { id: string; ref: string; unreadable?: { reason: string; at: string } };

/** The person's brief for everything Claude writes in the build. */
export const BRIEF_FIELDS = ["audience", "tone", "length", "notes"] as const;
export type Brief = Partial<Record<(typeof BRIEF_FIELDS)[number], string>>;

/** The most documents a build lists, and the longest link or path, reason and brief field. */
export const CONTEXT_MAX = 20;
const REF_MAX = 2000;
const REASON_MAX = 500;
const BRIEF_MAX: Record<keyof Brief, number> = { audience: 200, tone: 200, length: 200, notes: 2000 };
/** Each brief field's label on the page, which its error names. */
const BRIEF_LABEL: Record<keyof Brief, string> = { audience: "Audience", tone: "Tone", length: "Length", notes: "Anything else" };

/** Whether a document is a link Claude opens on the web; anything else in the list is a file path. */
const isLink = (ref: string) => /^https?:\/\//i.test(ref);

/** The person's input as an error quotes it: on one line, cut short when long. */
function quoted(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return `“${line.length > 60 ? `${line.slice(0, 59)}…` : line}”`;
}

/** A link or a full file path, trimmed, or the refusal, which the page shows under the field that adds it. */
function validRef(ref: string): string {
  const r = ref.trim();
  if (!r) throw new HoopError("Type a link or a full file path first.");
  if (r.length > REF_MAX) throw new HoopError(`That link or path is over ${REF_MAX} characters. Use a shorter link.`);
  if ([...r].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new HoopError("A link or path is one line. Paste it without line breaks.");
  if (isLink(r) && URL.canParse(r)) return r;
  if (!isLink(r) && (r.startsWith("/") || r.startsWith("~/"))) return r;
  throw new HoopError(`${quoted(r)} isn't a link or a full file path. Use a link that starts with https://, or a path such as ~/notes.md.`);
}

/** Adds a document to the end of the list; one already listed is refused. */
export function addContext(build: Build, ref: string): string {
  const r = validRef(ref);
  const docs = (build.context ??= []);
  if (docs.some((d) => d.ref === r)) throw new HoopError(`${quoted(r)} is already in the list.`);
  if (docs.length >= CONTEXT_MAX) throw new HoopError(`The list holds at most ${CONTEXT_MAX} documents. Remove one first.`);
  build.next_doc = (build.next_doc ?? 0) + 1;
  docs.push({ id: `d${build.next_doc}`, ref: r });
  return "added a context document";
}

/** The listed document named by its ID, or by its exact link or path, or the refusal. */
function docOf(build: Build, doc: string): ContextDoc {
  const d = (build.context ?? []).find((x) => x.id === doc || x.ref === doc.trim());
  if (!d) throw new HoopError(`"${doc}" isn't one of the build's context documents`);
  return d;
}

/** Removes a document from the list; what Claude already wrote from it keeps saying so. */
export function removeContext(build: Build, doc: string): string {
  const d = docOf(build, doc);
  build.context = build.context!.filter((x) => x !== d);
  return "removed a context document";
}

/** Sets the brief from the fields sent; an empty field clears it. Undefined when nothing changed. */
export function setBrief(build: Build, fields: Brief): string | undefined {
  const brief: Brief = {};
  for (const k of BRIEF_FIELDS) {
    const v = fields[k]?.trim();
    if (!v) continue;
    if (v.length > BRIEF_MAX[k]) throw new HoopError(`${BRIEF_LABEL[k]} is over ${BRIEF_MAX[k]} characters. Shorten it.`);
    brief[k] = v;
  }
  const empty = !Object.keys(brief).length;
  if (JSON.stringify(brief) === JSON.stringify(build.brief ?? {})) return undefined;
  if (empty) delete build.brief;
  else build.brief = brief;
  return empty ? "cleared the brief" : "changed the brief";
}

/** Claude couldn't open a document: its reason shows beside it on the page, and later requests carry it. */
export function markUnreadable(build: Build, doc: string, reason: string): string {
  const d = docOf(build, doc);
  const why = reason.replace(/\s+/g, " ").trim();
  if (!why) throw new HoopError("say why you couldn't open it, in one line");
  if (why.length > REASON_MAX) throw new HoopError(`a reason is at most ${REASON_MAX} characters`);
  d.unreadable = { reason: why, at: new Date().toISOString() };
  return "couldn't open a context document";
}

/**
 * The documents a write says Claude drew from, as their links or paths, each named by its ID or exact
 * link or path; refuses one that isn't in the list now, saying when the person removed it. Using a
 * document clears Claude's earlier reason it couldn't open it. Undefined when it names none.
 */
export function usedSources(build: Build, used: string[] | undefined): string[] | undefined {
  if (!used?.length) return undefined;
  const refs = used.map((u) => {
    const d = (build.context ?? []).find((x) => x.id === u || x.ref === u.trim());
    if (!d) {
      const n = /^d([1-9]\d*)$/.exec(u)?.[1];
      if (n && Number(n) <= (build.next_doc ?? 0))
        throw new HoopError(`document ${u} is no longer in the build's context list: the person removed it, so write without it and leave it out of used`);
      const ids = (build.context ?? []).map((x) => x.id).join(", ");
      throw new HoopError(`"${u}" isn't in the build's context list (${ids || "none"}); name only documents from the request's context`);
    }
    delete d.unreadable;
    return d.ref;
  });
  return [...new Set(refs)];
}

/** What every request Claude takes carries: the documents in order, each a link or a file, with Claude's reason for one it couldn't open; and the brief. */
export function contextTask(build: Build) {
  const docs = (build.context ?? []).map((d) => ({
    id: d.id,
    ref: d.ref,
    kind: isLink(d.ref) ? ("link" as const) : ("file" as const),
    ...(d.unreadable ? { unreadable: d.unreadable.reason } : {}),
  }));
  return { ...(docs.length ? { context: docs } : {}), ...(build.brief ? { brief: build.brief } : {}) };
}
