// Unsent text, kept in this browser on every page (docs/DESIGN-LANGUAGE.md, Drafts): a reviewer's
// drafts per review, carried to each new revision, and what the build page, a quick question and
// Work keep (`readKept`, `keep`), with the quiet "Draft saved" beside a box (`draftSaved`). Storage
// that can't be read or written keeps nothing, and the page works as before.

const key = (id) => `hoop:${id}:drafts`;

// Each kept draft has a name of its own (a block, a form, an ask's field), so two tabs never write
// over each other's. A tab removes a draft only when the stored value is the one it wrote itself, so
// closing a box another tab typed in leaves that tab's draft alone. Each value carries when it was
// kept (`at`); past KEPT_MAX drafts, the review page's among them, the least recently kept go, as
// fold.js caps its keys. The names come from the storage keys themselves, so none is ever orphaned.
const KEPT = "hoop:kept:";
const KEPT_MAX = 500;

/** The storage keys that hold drafts: the pages' kept names and the review page's drafts; none when storage can't be read. */
function draftKeys() {
  try {
    return Object.keys(localStorage).filter((k) => k.startsWith(KEPT) || /^hoop:rv_[a-z0-9]+:drafts$/.test(k));
  } catch {
    return [];
  }
}

/** The kept names, as pages name them. */
const names = () => draftKeys().flatMap((k) => (k.startsWith(KEPT) ? [k.slice(KEPT.length)] : []));

/** What a page kept under `name` in this browser, or undefined. */
export function readKept(name) {
  try {
    return JSON.parse(localStorage.getItem(KEPT + name) || "null") ?? undefined;
  } catch {
    return undefined;
  }
}

/** The kept names that start with `prefix`. */
export const keptNames = (prefix) => names().filter((n) => n.startsWith(prefix));

/** What this tab wrote under each name, as stored, so it removes only its own. */
const mine = new Map();

/** Past KEPT_MAX drafts, drops the least recently kept; a draft with no time counts as oldest. */
function cap() {
  const keys = draftKeys();
  if (keys.length <= KEPT_MAX) return;
  // A draft with no time sorts last, so it isn't the first to go for lacking one.
  const at = (k) => {
    try {
      return JSON.parse(localStorage.getItem(k) || "{}").at ?? "\uffff";
    } catch {
      return "\uffff";
    }
  };
  // What the open page holds, or wrote, is never dropped from under it.
  const out = keys.filter((k) => !inUse.has(k));
  for (const k of out
    .map((k) => [k, at(k)])
    .sort((x, y) => x[1].localeCompare(y[1]))
    .slice(0, keys.length - KEPT_MAX)
    .map(([k]) => k))
    localStorage.removeItem(k);
}

/** The storage keys this page reads or writes drafts under, which the cap leaves alone. */
const inUse = new Set();

/** Keeps `value` (an object) under `name` in this browser, stamped with when; whether the browser stored it. */
export function keep(name, value) {
  try {
    const raw = JSON.stringify({ ...value, at: new Date().toISOString() });
    localStorage.setItem(KEPT + name, raw);
    mine.set(name, raw);
    inUse.add(KEPT + name);
    cap();
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes the draft under `name` into this tab, as a page does when it puts the draft back in its box:
 * from then on it is this tab's, so sending or cancelling it here removes it. Returns what was kept.
 */
export function holdKept(name) {
  try {
    const raw = localStorage.getItem(KEPT + name);
    if (raw === null) return undefined;
    mine.set(name, raw);
    inUse.add(KEPT + name);
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Removes the draft under `name` if what is stored is the one this tab wrote, as when it was sent or cancelled here. */
export function release(name) {
  try {
    if (mine.has(name) && localStorage.getItem(KEPT + name) === mine.get(name)) localStorage.removeItem(KEPT + name);
  } catch {}
  mine.delete(name);
}

/**
 * A kept draft whose box now starts from other text, offered back above the box (Drafts): it says
 * so, shows the kept words, and offers Use it and Discard, which carry `name` for the page to act on.
 */
export const staleDraftHtml = (name, text, what) =>
  `<div class="stale-draft" data-stale-draft="${escAttr(name)}"><p>You had unsent text from before this changed</p><blockquote class="kept-text">${escText(text)}</blockquote><div class="row"><button type="button" class="btn small" data-stale-use="${escAttr(name)}" aria-label="${escAttr(`Use your unsent text in ${what}`)}">Use it</button><button type="button" class="btn small" data-stale-discard="${escAttr(name)}" aria-label="${escAttr(`Discard your unsent text for ${what}`)}">Discard</button></div></div>`;

/** Where a draft from before its text changed waits while it is offered back, apart from the box's own draft. */
export const staleName = (name) => `${name}:stale`;

/**
 * Moves the draft under `name` aside to `staleName(name)` when `isStale` says its text has changed
 * since, so typing in the box keeps a draft of its own and never writes over the words on offer.
 * Returns the words waiting there, if any.
 */
export function parkStale(name, isStale) {
  const kept = readKept(name);
  if (kept && isStale(kept)) {
    const { at: _at, ...value } = kept;
    if (keep(staleName(name), value)) forget(name);
  }
  return readKept(staleName(name));
}
const escText = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const escAttr = (s) => escText(s).replace(/"/g, "&quot;");

/** Removes the draft under `name` whoever wrote it, as when what it is for has ended. */
const forget = (name) => {
  try {
    localStorage.removeItem(KEPT + name);
  } catch {}
  mine.delete(name);
};

/**
 * Drops every draft kept for review, build or ask `id`, once it has ended: closed, replaced,
 * withdrawn, or a build turned into a review. Whichever page learns of it drops them.
 */
export function dropKept(id, { build = true, ask = true, review = false } = {}) {
  const prefixes = [build && `build:${id}:`, ask && `ask:${id}:`].filter(Boolean);
  for (const n of names().filter((x) => prefixes.some((p) => x.startsWith(p)))) forget(n);
  if (review)
    try {
      localStorage.removeItem(key(id));
    } catch {}
}

/** Drops the draft under `name`, whoever wrote it, as for a question answered, a todo gone or a draft discarded. */
export function dropNames(name) {
  cancelSoon(name);
  forget(name);
}

/**
 * Drops what this browser kept for each review in `list` (Home's list, which every page asks for)
 * that has ended: a review closed or replaced, a quick question withdrawn or closed, a build turned
 * into a review. Whichever page learns of it first drops it, not only the tab that acted.
 */
export function sweepKept(list) {
  const kept = new Set(names().map((n) => n.split(":")[1]));
  for (const m of list) {
    if (m.closed || m.superseded_by) dropKept(m.id, { review: true, build: kept.has(m.id), ask: kept.has(m.id) });
    else if (!kept.has(m.id)) continue;
    else if (m.status_key === "withdrawn" || m.status_key === "closed") dropKept(m.id, { build: false });
    else if (m.build !== "open" && !m.ask) dropKept(m.id, { ask: false });
  }
}

/** How long typing stops before what was typed is kept, and "Draft saved" shows. */
const QUIET_MS = 800;
/** The writes waiting for typing to stop, by name, so a closing tab still makes them. */
const waiting = new Map();

/** The "Draft saved" note right after `box`, if it has one. */
const noteOf = (box) => (box?.nextElementSibling?.classList.contains("draft-saved") ? box.nextElementSibling : null);

/**
 * Once typing in `box` stops, makes the write `name` names, and shows a quiet grey "Draft saved"
 * right after the box only when `write` says it stored a draft (not when it released one, or the
 * browser refused it); typing again hides it.
 * Screen readers aren't told: it is a reassurance beside the box, not news.
 */
export function keepSoon(name, write, box) {
  const shown = noteOf(box);
  if (shown) shown.hidden = true;
  clearTimeout(waiting.get(name)?.timer);
  const run = () => {
    waiting.delete(name);
    if (!write() || !box?.isConnected || !box.value.trim()) return;
    const el = noteOf(box) ?? Object.assign(document.createElement("span"), { className: "draft-saved", textContent: "Draft saved" });
    el.hidden = false;
    if (!el.isConnected) box.after(el);
  };
  waiting.set(name, { timer: setTimeout(run, globalThis.HOOP_DRAFT_MS ?? QUIET_MS), run });
}

/** Drops a write still waiting for typing to stop, as when its box was sent or cancelled. */
export function cancelSoon(name) {
  clearTimeout(waiting.get(name)?.timer);
  waiting.delete(name);
}

// A tab that closes or goes away makes the writes still waiting.
globalThis.addEventListener?.("pagehide", () => {
  for (const w of [...waiting.values()]) {
    clearTimeout(w.timer);
    w.run();
  }
});

/** The stored drafts of a review, or undefined when there are none or storage is unavailable. */
export function readDrafts(id) {
  try {
    return JSON.parse(localStorage.getItem(key(id)) || "null") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Stores a review's drafts; whether the browser stored them. */
export function writeDrafts(id, drafts) {
  try {
    localStorage.setItem(key(id), JSON.stringify(drafts));
    inUse.add(key(id));
    cap();
    return true;
  } catch {
    return false;
  }
}

/**
 * Carries drafts written on an earlier revision to the revision `now` describes. A draft stays on
 * its anchor `{item, line}` while that line reads as it did, and follows the line when it moved
 * within its section; a reply stays while its line exists. Anything else, and an answer whose
 * option reads differently, goes to `stale` with the revision it was written on, so nothing is lost.
 *
 * An open composer is stored only while it holds the reviewer's words, so it always counts; so are
 * the words Escape put away from it (`kept`).
 *
 * `now` gives the current revision and, for an anchor (line -1 is a heading), its text, the
 * section's lines, and a question's option label.
 */
export function rebase(drafts, now) {
  const d = { pending: [], answers: {}, labels: {}, resolved: [], summary: "", composer: null, stale: [], kept: [], ...drafts };
  const from = d.revision ?? now.revision;
  // Drafts from before texts were kept are on this revision, so they take its text.
  const withText = (p) => (p.text === undefined && from === now.revision ? { ...p, text: now.lineAt(p.item, p.line) } : p);
  d.pending = d.pending.map(withText);
  if (d.composer) d.composer = withText(d.composer);
  if (from === now.revision) return { ...d, revision: from };

  const stale = [...d.stale];
  const pending = [];
  for (const p of d.pending) {
    const placed = place(p, now);
    if (placed) pending.push(placed);
    else stale.push({ ...p, revision: from });
  }
  const composer = d.composer && place(d.composer, now);
  if (d.composer && !composer) stale.push({ key: `c${from}-${d.composer.item}-${d.composer.line}`, ...asStale(d.composer), revision: from });
  // Words Escape put away follow their line like an open composer's.
  const kept = [];
  for (const [i, k] of d.kept.entries()) {
    const placed = place(k, now);
    if (placed) kept.push(placed);
    else stale.push({ key: `k${from}-${k.item}-${k.line}-${i}`, ...asStale(k), revision: from });
  }
  const answers = keptAnswers(d, now, from, stale);
  return { ...d, revision: now.revision, pending, composer: composer ?? null, kept, answers, stale };
}

/**
 * An open or kept composer's words as a stale draft. Its `answer` flag (the comment was the Other
 * answer to a question) goes, so it shows and is placed again as a comment with its words: a stale
 * `answer` is a picked option.
 */
export function asStale(c) {
  const s = { ...c };
  if (typeof s.answer !== "object") delete s.answer;
  return s;
}

/** Where a draft goes on the revision `now` describes: its anchor, the line it moved to, or null when it can't follow. */
function place(p, now) {
  const text = now.lineAt(p.item, p.line);
  if (p.thread) return text === undefined ? null : p;
  if (p.text !== undefined && text === p.text) return p;
  if (p.text === undefined || p.line < 0 || p.item === "DOC") return null;
  const at = (now.linesOf(p.item) ?? []).flatMap((t, i) => (t === p.text ? [i] : []));
  return at.length === 1 ? { ...p, line: at[0] } : null;
}

/** The answers whose option still reads as it did; each other one goes to `stale`. */
function keptAnswers(d, now, from, stale) {
  const answers = {};
  for (const [item, choice] of Object.entries(d.answers)) {
    const label = now.choiceLabel(item, choice);
    if (label !== undefined && (d.labels[item] === undefined || d.labels[item].label === label)) answers[item] = choice;
    else stale.push({ key: `a${from}-${item}`, revision: from, item, answer: { choice, ...d.labels[item] } });
  }
  return answers;
}
