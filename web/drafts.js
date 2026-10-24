// A reviewer's unsent drafts, kept per review in localStorage and carried to each new revision.

const key = (id) => `hoop:${id}:drafts`;

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
 * An open composer is stored only while it holds the reviewer's words, so it always counts.
 *
 * `now` gives the current revision and, for an anchor (line -1 is a heading), its text, the
 * section's lines, and a question's option label.
 */
export function rebase(drafts, now) {
  const d = { pending: [], answers: {}, labels: {}, resolved: [], summary: "", composer: null, stale: [], ...drafts };
  const from = d.revision ?? now.revision;
  // Drafts from before texts were kept are on this revision, so they take its text.
  const withText = (p) => (p.text === undefined && from === now.revision ? { ...p, text: now.lineAt(p.item, p.line) } : p);
  d.pending = d.pending.map(withText);
  if (d.composer) d.composer = withText(d.composer);
  if (from === now.revision) return { ...d, revision: from };

  const stale = [...d.stale];
  const place = (p) => {
    const text = now.lineAt(p.item, p.line);
    if (p.thread) return text === undefined ? null : p;
    if (p.text !== undefined && text === p.text) return p;
    if (p.text === undefined || p.line < 0 || p.item === "DOC") return null;
    const at = (now.linesOf(p.item) ?? []).flatMap((t, i) => (t === p.text ? [i] : []));
    return at.length === 1 ? { ...p, line: at[0] } : null;
  };
  const pending = [];
  for (const p of d.pending) {
    const placed = place(p);
    if (placed) pending.push(placed);
    else stale.push({ ...p, revision: from });
  }
  const composer = d.composer && place(d.composer);
  if (d.composer && !composer) stale.push({ key: `c${from}-${d.composer.item}-${d.composer.line}`, ...d.composer, revision: from });
  const answers = {};
  for (const [item, choice] of Object.entries(d.answers)) {
    const label = now.choiceLabel(item, choice);
    if (label !== undefined && (d.labels[item] === undefined || d.labels[item].label === label)) answers[item] = choice;
    else stale.push({ key: `a${from}-${item}`, revision: from, item, answer: { choice, ...d.labels[item] } });
  }
  return { ...d, revision: now.revision, pending, composer: composer ?? null, answers, stale };
}
