// Unsent text, kept in this browser on every page (docs/DESIGN-LANGUAGE.md, Drafts): a reviewer's
// drafts per review, carried to each new revision, and what the build page, a quick question and
// Work keep (`readKept`, `keep`), with the quiet "Draft saved" beside a box (`draftSaved`). Storage
// that can't be read or written keeps nothing, and the page works as before.

const key = (id) => `hoop:${id}:drafts`;

/** What a page kept under `name` in this browser, or undefined. */
export function readKept(name) {
  try {
    return JSON.parse(localStorage.getItem(`hoop:kept:${name}`) || "null") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Keeps `value` under `name` in this browser; nothing, or an empty object, removes it. */
export function keep(name, value) {
  try {
    const empty = value == null || (typeof value === "object" && !Object.keys(value).length);
    if (empty) localStorage.removeItem(`hoop:kept:${name}`);
    else localStorage.setItem(`hoop:kept:${name}`, JSON.stringify(value));
  } catch {}
}

/** How long typing stops before "Draft saved" shows. */
const QUIET_MS = 800;
let savedTimer;

/**
 * Shows a quiet grey "Draft saved" right after `box` once typing in it stops, and hides it while
 * typing goes on. Screen readers aren't told: it is a reassurance beside the box, not news.
 */
export function draftSaved(box) {
  clearTimeout(savedTimer);
  const note = (el) => el?.nextElementSibling?.classList.contains("draft-saved") && el.nextElementSibling;
  const shown = note(box);
  if (shown) shown.hidden = true;
  if (!box.value.trim()) return;
  savedTimer = setTimeout(() => {
    if (!box.isConnected || !box.value.trim()) return;
    const el = note(box) || Object.assign(document.createElement("span"), { className: "draft-saved", textContent: "Draft saved" });
    el.hidden = false;
    if (!el.isConnected) box.after(el);
  }, window.HOOP_DRAFT_MS ?? QUIET_MS);
}

/** The stored drafts of a review, or undefined when there are none or storage is unavailable. */
export function readDrafts(id) {
  try {
    return JSON.parse(localStorage.getItem(key(id)) || "null") ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeDrafts(id, drafts) {
  try {
    localStorage.setItem(key(id), JSON.stringify(drafts));
  } catch {}
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
