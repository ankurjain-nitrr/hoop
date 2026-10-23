// Reviewing: line comments, suggestions, answers, threads with replies, and Finish your review.
import { statusBadge } from "/status.js";
import { pieceMarker } from "/blocks.js";
import { renderLine } from "/inline.js";
import { icons } from "/icons.js";
import { updatePanel } from "/signin.js";
import { $, esc, hooks, isDoc, loadDraft, load, post, render, saveDraft, state, textAt } from "/app.js";

state.canReview = true;
const review = { pending: [], answers: {}, resolved: [], composer: null, finishing: false, toast: "" };
state.composerRef = () => review.composer;
let seq = 0;

const frozen = () => state.view?.meta.status === "approved";
const persist = () => saveDraft({ pending: review.pending, answers: review.answers, resolved: review.resolved });
const pendingCount = () => review.pending.length + Object.keys(review.answers).length + review.resolved.length;

/** Comment threads from earlier reviews, keyed by item and line, with replies in time order. */
function threads() {
  const all = new Map();
  for (const fb of state.view.feedback) {
    for (const c of fb.comments) {
      const t = all.get(c.thread) ?? { id: c.thread, item: c.item, line: c.line, revision: fb.revision, entries: [], resolved: false };
      t.entries.push({ who: fb.reviewer, role: `reviewer · rev ${fb.revision}`, body: c.body, suggestion: c.suggestion, range: c.range, at: fb.at });
      all.set(c.thread, t);
    }
    for (const id of fb.resolved_threads) {
      const t = all.get(id);
      if (t) Object.assign(t, { resolved: true, resolvedAt: t.resolvedAt && t.resolvedAt > fb.at ? t.resolvedAt : fb.at });
    }
  }
  for (const r of state.view.replies) all.get(r.thread)?.entries.push({ who: r.author, role: "author", body: r.body, at: r.at });
  for (const t of all.values()) t.entries.sort((a, b) => a.at.localeCompare(b.at));
  return [...all.values()];
}

/** Text ranges with comments on a line (0-based), pending and earlier, for highlighting. */
export function rangesOn(itemId, line) {
  const earlier = state.view.feedback
    .flatMap((f) => f.comments)
    .filter((c) => c.item === itemId && c.line === line + 1 && c.range)
    .map((c) => c.range);
  return [...earlier, ...review.pending.filter((p) => p.item === itemId && p.line === line && p.range).map((p) => p.range)];
}

const lineText = (itemId, idx) => textAt(itemId, idx) ?? "";

/** Claude's undecided edits on an anchor (0-based idx), with their position in the current text. */
export function proposalsOn(itemId, idx) {
  return (state.view.edits ?? []).filter((e) => e.status === "proposed" && e.item === itemId && e.line === idx + 1);
}

function editCardHtml(e) {
  const w = e.words;
  return `<div class="edit-card ${e.position ? "" : "stale"}" id="card-${esc(e.id)}" data-comment="hide"><div class="who">Claude's edit <span class="role">for ${esc(e.thread)}</span>
      <span class="role">−${w.removed} +${w.added} words</span>${w.large ? '<span class="tag-large">Large rewrite</span>' : ""}${e.position ? "" : '<span class="tag-large">Text changed; can only be rejected</span>'}</div>
    ${e.note ? `<div>${esc(e.note)}</div>` : ""}
    ${
      frozen()
        ? ""
        : `<div class="thread-actions">${e.position ? `<button class="btn small primary" data-accept="${esc(e.id)}">Accept</button>` : ""}<button class="btn small" data-reject="${esc(e.id)}">Reject</button>
      ${(state.view.edits ?? []).filter((x) => x.thread === e.thread && x.status === "proposed" && x.position).length > 1 && e.position ? `<button class="btn small" data-accept-all="${esc(e.thread)}">Accept all for this comment</button>` : ""}</div>`
    }</div>`;
}

/** A document section's name for labels: its title, with its position when another section shares it. */
function sectionName(itemId) {
  const items = state.view.doc.items,
    item = items.find((i) => i.id === itemId);
  if (!item) return itemId;
  const same = items.filter((i) => i.title === item.title);
  return same.length > 1 ? `"${item.title}" (section ${items.indexOf(item) + 1})` : `"${item.title}"`;
}

/** What a comment at this anchor applies to: headings cover their section, title and TL;DR the document. */
function scopeLabel(itemId, idx) {
  if (itemId === "DOC") return `the ${idx === 0 ? "title" : "TL;DR"} (applies to the whole document)`;
  // A document's sections are named by their titles, since its IDs are hidden.
  const name = isDoc() ? sectionName(itemId) : itemId;
  if (idx === -1) return `${name} heading (applies to the whole section)`;
  return `${name} line ${idx + 1}`;
}

/**
 * A comment's quote, formatted as its line is. A document's quote shows as code in a code block,
 * as a quote in a quote line and as prose elsewhere; a structured review's shows as written.
 */
function quoteHtml(itemId, idx, quote) {
  if (!isDoc()) return `<div class="quote">${renderLine(quote, [])}</div>`;
  const kind = idx >= 0 ? state.view.doc.items.find((i) => i.id === itemId)?.blocks?.[idx]?.kind : undefined;
  return `<div class="quote">${renderLine(quote, [], { kind: kind === "code" || kind === "quote" ? kind : "paragraph", indent: 0 })}</div>`;
}

/**
 * Why a suggestion can't be stored, or "". It mirrors the edit engine's refusals: no line breaks,
 * no edit to an automatic TL;DR, no emptied line, and in a document no change to a line's
 * structure markers, which covers the title and TL;DR but not headings.
 */
function suggestionProblem(c, suggestion) {
  if (suggestion === undefined) return "";
  if (/[\r\n]/.test(suggestion)) return "A suggestion can't add or remove lines. Keep line breaks out of it.";
  if (c.inPlace && suggestion === lineText(c.item, c.line)) return "Change the text first.";
  if (c.item === "DOC" && c.line === 1 && state.view.doc.tldr_auto) return "The TL;DR repeats the first paragraph. Suggest a change to that paragraph instead.";
  const line = lineText(c.item, c.line);
  const changed = c.range ? line.slice(0, c.range.start) + suggestion + line.slice(c.range.end) : suggestion;
  if (c.item !== "DOC" && c.line >= 0 && !changed.trim()) return "A suggestion can't remove a whole line. Replace its text instead.";
  if (isDoc() && c.line >= 0 && pieceMarker(changed).join() !== pieceMarker(line).join())
    return "A suggestion can't change the line's markdown structure, such as its list, quote, table or code markers. Change only the words.";
  return "";
}

function suggestionHtml(original, suggestion) {
  return `<div class="suggestion"><div class="lab">Suggested change</div><div class="o">${esc(original)}</div><div class="n">${esc(suggestion)}</div></div>`;
}

/** A thread is outdated when its line's text changed (or went away) after the revision it was left on. */
function isOutdated(t) {
  if (t.revision === state.view.meta.revisions) return false;
  const then = textAt(t.item, t.line - 1, t.revision);
  return then === undefined || then !== lineText(t.item, t.line - 1);
}

/** Where a thread sits. A thread on an automatic TL;DR, which has no box, shows the TL;DR's text. */
function threadPlace(t) {
  if (t.item !== "DOC") return `Conversation on line ${t.line}`;
  if (t.line === 1) return "Conversation on the title";
  const shown = !state.view.doc.tldr_auto || state.tab === "changes";
  return `Conversation on the TL;DR${shown ? "" : `: <span class="quote-inline">${esc(state.view.doc.tldr)}</span>`}`;
}

/**
 * Whether a conversation shows as resolved now. It reopens when a reply comes after its resolution.
 */
function isResolved(t) {
  if (review.resolved.includes(t.id)) return true;
  if (!t.resolved) return false;
  return !t.entries.some((e) => e.at > t.resolvedAt);
}

function threadHtml(t) {
  const resolvedNow = isResolved(t);
  const outdated = isOutdated(t);
  const applied = state.view.applied?.find((a) => a.thread === t.id);
  const place = outdated ? `<span class="tag-outdated">Outdated</span> Rev ${t.revision}, line ${t.line}` : threadPlace(t);
  const stateLabel = applied ? `<span class="tag-applied">Applied in rev ${applied.revision}</span>` : resolvedNow ? "Resolved" : "Open";
  const body = threadBody(t, resolvedNow, outdated, applied);
  // A resolved conversation collapses to one summary row until the reviewer opens it.
  if (resolvedNow) {
    const n = t.entries.length;
    return `<details class="thread resolved ${outdated ? "outdated" : ""}" data-comment="hide" data-thread="${esc(t.id)}" ${state.openThreads[t.id] ? "open" : ""}><summary class="thread-head"><span>${place}</span><span>${stateLabel} · ${n} ${n === 1 ? "comment" : "comments"}</span></summary>${body}</details>`;
  }
  return `<div class="thread ${outdated ? "outdated" : ""}" data-comment="hide"><div class="thread-head"><span>${place}</span><span>${stateLabel}</span></div>${body}</div>`;
}

function threadBody(t, resolvedNow, outdated, applied) {
  const canApply = !frozen() && !applied && !outdated && t.entries.some((e) => e.suggestion !== undefined);
  const pendingResolve = review.resolved.includes(t.id);
  return `
    ${t.entries
      .map(
        (e) => `<div class="comment"><div class="who">${esc(e.who)} <span class="role">${esc(e.role)}</span></div>
      ${e.range ? quoteHtml(t.item, t.line - 1, e.range.quote) : ""}${e.body ? `<div>${esc(e.body)}</div>` : ""}
      ${e.suggestion !== undefined ? suggestionHtml(e.range?.quote ?? lineText(t.item, t.line - 1), e.suggestion) : ""}</div>`,
      )
      .join("")}
    ${
      frozen()
        ? ""
        : `<div class="thread-actions">${canApply ? `<button class="btn small primary" data-apply="${esc(t.id)}">Apply suggestion</button>` : ""}<button class="btn small" data-reply="${esc(t.id)}" data-item="${esc(t.item)}" data-line="${t.line - 1}">Reply</button>
      ${pendingResolve ? `<button class="btn small" data-unresolve="${esc(t.id)}">Unresolve</button>` : resolvedNow ? "" : `<button class="btn small" data-resolve="${esc(t.id)}">Resolve conversation</button>`}</div>`
    }`;
}

function pendingHtml(p) {
  const original = p.range?.quote ?? lineText(p.item, p.line);
  return `<div class="thread" data-comment="hide"><div class="comment"><div class="who">You <span class="pending">Pending</span>${p.thread ? '<span class="role">reply</span>' : ""}${p.range ? '<span class="role">on selected text</span>' : ""}</div>
    ${p.range ? quoteHtml(p.item, p.line, p.range.quote) : ""}${p.body ? `<div>${esc(p.body)}</div>` : ""}
    ${p.suggestion !== undefined ? suggestionHtml(original, p.suggestion) : ""}</div>
    <div class="thread-actions"><button class="btn small" data-drop="${p.key}">Delete</button></div></div>`;
}

function composerHtml(c) {
  const original = c.range?.quote ?? lineText(c.item, c.line);
  if (c.inPlace) return inPlaceHtml(c);
  const label = c.thread
    ? "Reply"
    : c.answer
      ? `Your answer to ${esc(scopeLabel(c.item, c.line))}`
      : `Comment on ${esc(scopeLabel(c.item, c.line))}${c.range ? ", selected text" : ""}`;
  return `<div class="composer"><label class="mono lab" for="cbody">${label}</label>
    ${c.range ? quoteHtml(c.item, c.line, c.range.quote) : ""}
    ${c.thread || c.range || c.answer ? "" : `<label class="mono lab" for="cpart">Only about this text (optional)</label><input id="cpart" class="part" autocomplete="off" placeholder="Type the words you mean"><span class="mono lab" id="cpartHint" aria-live="polite"></span>`}
    <textarea id="cbody" placeholder="${c.answer ? "Write your own answer" : "Leave a comment"}">${esc(c.body || "")}</textarea>
    ${c.suggest ? `<label class="mono lab" for="csugg">${c.range ? "Replace the selected text with" : "Suggested text"}</label><textarea id="csugg" aria-describedby="csuggHint">${esc(c.suggestion ?? original)}</textarea><span class="mono lab warn" id="csuggHint" role="alert">${esc(c.problem ?? "")}</span>` : ""}
    <div class="row"><div>${c.thread ? "" : `<button class="btn small" id="toggleSuggest">${c.suggest ? "Remove suggestion" : "Suggest a change"}</button>`}</div>
    <div><button class="btn small" id="cancelComment">Cancel</button><button class="btn small primary" id="addComment">${review.pending.length ? "Add review comment" : "Start a review"}</button></div></div></div>`;
}

/** The in-place editor: the line's text to change, and an optional note. */
function inPlaceHtml(c) {
  return `<div class="composer in-place"><label class="mono lab" for="csugg">Edit ${esc(scopeLabel(c.item, c.line))}</label>
    <textarea id="csugg" aria-describedby="csuggHint">${esc(c.suggestion ?? lineText(c.item, c.line))}</textarea><span class="mono lab warn" id="csuggHint" role="alert">${esc(c.problem ?? "")}</span>
    <label class="mono lab" for="cbody">Why (optional)</label><textarea id="cbody" placeholder="Say why, if it helps">${esc(c.body || "")}</textarea>
    <div class="row"><div></div><div><button class="btn small" id="cancelComment">Cancel</button><button class="btn small primary" id="addComment">${review.pending.length ? "Add review comment" : "Start a review"}</button></div></div></div>`;
}

/** How many conversations and pending comments the hide control hides. */
const hiddenCount = () => threads().length + review.pending.length;
const hideLabel = () => (state.commentsHidden ? `Show comments (${hiddenCount()})` : "Hide comments");

/** Turns the page's hidden mode on or off in place, so focus and the reader's place stay. */
function toggleHidden(button) {
  if (review.composer || review.finishing) return;
  state.commentsHidden = !state.commentsHidden;
  $("#app").classList.toggle("comments-hidden", state.commentsHidden);
  button.setAttribute("aria-pressed", String(state.commentsHidden));
  button.textContent = hideLabel();
}

// The control isn't offered while the reviewer writes a comment or a verdict, so neither can
// happen with comments hidden.
hooks.top.push(() =>
  hiddenCount() && !review.composer && !review.finishing
    ? `<button class="btn" id="hideComments" aria-pressed="${state.commentsHidden}">${hideLabel()}</button>`
    : "",
);

// Remembers which resolved conversations the reviewer opened, for this page only. `toggle`
// doesn't bubble, so the listener captures it.
document.addEventListener(
  "toggle",
  (e) => {
    const d = e.target;
    if (d instanceof HTMLDetailsElement && d.dataset.thread) state.openThreads[d.dataset.thread] = d.open;
  },
  true,
);

hooks.top.push(() =>
  frozen()
    ? statusBadge("approved")
    : `<div class="finish-wrap"><button class="btn primary" id="finishBtn" aria-expanded="${review.finishing}" aria-controls="finishPop">Finish your review${pendingCount() > 0 ? `<span class="n">${pendingCount()}</span>` : ""}</button>
    <div class="popover" id="finishPop" ${review.finishing ? "" : "hidden"}><h2>Finish your review</h2>
      <label class="mono lab" for="summary">Overall comment, or notes for an approval (optional)</label>
      <textarea id="summary" placeholder="Notes are kept with your review"></textarea>
      <div class="verdicts" role="radiogroup" aria-label="Verdict">
        <label><input type="radio" name="verdict" id="v-comment" value="comment" checked> Comment <small>Feedback without a verdict. Claude replies but doesn't proceed.</small></label>
        <label><input type="radio" name="verdict" id="v-approve" value="approved"> Approve <small>Freeze this revision. Claude continues from it.</small></label>
        <label><input type="radio" name="verdict" id="v-changes" value="changes_requested"> Request changes <small>Claude revises and submits a new revision.</small></label>
      </div>
      <div id="signinPanel" class="signin" tabindex="-1" aria-live="polite" hidden></div>
      <p class="error" id="finishError" hidden></p>
      <div class="row end"><button class="btn" id="cancelFinish">Cancel</button><button class="btn primary" id="submitReview">Submit review</button></div></div></div>`,
);

hooks.item.push((item, where) => {
  if (where !== "badge") return "";
  const n = review.pending.filter((p) => p.item === item.id).length + (review.answers[item.id] ? 1 : 0);
  return n ? String(n) : "";
});

hooks.line.push((item, line, where) => {
  if (where === "gutter")
    return frozen()
      ? ""
      : `<button class="add-btn" aria-label="Comment on ${esc(scopeLabel(item.id, line))}" data-item="${esc(item.id)}" data-line="${line}">+</button>`;
  // Editing a line in place opens the composer with the line's text as the suggestion.
  if (where === "end")
    return frozen()
      ? ""
      : `<button class="edit-btn" aria-label="Edit ${esc(scopeLabel(item.id, line))} in place" title="Edit in place" data-edit-item="${esc(item.id)}" data-edit-line="${line}">${icons.edit}</button>`;
  if (where !== "below") return undefined;
  const lastLine = line === item.lines.length - 1;
  const cards = proposalsOn(item.id, line).map(editCardHtml).join("");
  // Outdated threads on lines that no longer exist collect under the item's last line.
  let html =
    cards +
    threads()
      .filter((t) => t.item === item.id && (t.line === line + 1 || (lastLine && t.line > item.lines.length)))
      .map(threadHtml)
      .join("");
  html += review.pending
    .filter((p) => p.item === item.id && p.line === line)
    .map(pendingHtml)
    .join("");
  const c = review.composer;
  if (c && c.item === item.id && c.line === line) html += composerHtml(c);
  return html;
});

hooks.after.push(() => (review.toast ? `<div class="toast" role="status">${esc(review.toast)}</div>` : ""));

/** Answers submitted on this revision, overridden by unsent ones. */
function shownAnswers() {
  const rev = state.view.meta.revisions,
    sent = {};
  for (const fb of state.view.feedback) if (fb.revision === rev) for (const a of fb.answers) sent[a.item] = a.choice;
  return { ...sent, ...review.answers };
}

/** The reviewer's own answer to a question: their unsent comments on its heading. */
const otherText = (id) =>
  review.pending
    .filter((p) => p.item === id && p.line === -1 && !p.thread && p.body)
    .map((p) => p.body)
    .join("\n\n");

/** The questions with no answer yet, sent on any revision or unsent, counting Other only with a comment on the question. */
function unanswered() {
  const sent = new Set(state.view.feedback.flatMap((fb) => fb.answers.map((a) => a.item)));
  const answered = (id) => (review.answers[id] ? review.answers[id] !== "other" || Boolean(otherText(id)) : sent.has(id));
  return state.view.doc.items.filter((i) => i.choices?.length && !answered(i.id));
}

// Every render (including tree collapses and tab switches) shows the answers chosen so far.
hooks.rendered.push(() => {
  updatePanel();
  for (const [q, choice] of Object.entries(shownAnswers())) {
    const el = document.getElementById(`q-${q}-${choice}`);
    if (el) el.checked = true;
  }
});
const rerender = render;

/** Opens the composer on a line with its source text ready to edit, as a suggestion. */
function editInPlace(item, line) {
  openComposer({ item, line, suggest: true, suggestion: lineText(item, line), inPlace: true });
  const box = $("#csugg");
  box?.focus();
  box?.setSelectionRange(box.value.length, box.value.length);
}

/**
 * Deletes the selected text in one action: a pending comment whose suggestion leaves the selection
 * out. A space next to a whole word goes with it, so no double space is left behind.
 */
export function deleteSelection({ item, line, range }) {
  const text = lineText(item, line);
  let { start, end } = range;
  const spaceBefore = start === 0 || text[start - 1] === " ";
  if (spaceBefore && text[end] === " ") end += 1;
  else if (end === text.length && text[start - 1] === " ") start -= 1;
  const c = { item, line, range: { start, end, quote: text.slice(start, end) } };
  const problem = suggestionProblem(c, "");
  if (problem) {
    openComposer({ ...c, suggest: true, suggestion: "", problem });
    return;
  }
  review.pending.push({ key: `p${Date.now()}${seq++}`, ...c, body: "Delete this text.", suggestion: "" });
  persist();
  rerender();
}

export function openComposer(c) {
  // A reviewer never writes with comments hidden.
  state.commentsHidden = false;
  review.composer = { body: "", suggest: false, ...c };
  rerender();
  $("#cbody")?.focus();
}

async function submit() {
  const box = $("#finishError");
  const missing = unanswered();
  for (const el of document.querySelectorAll(".qopts")) el.classList.remove("missing");
  if (missing.length) {
    for (const i of missing) document.querySelector(`#item-${CSS.escape(i.id)} .qopts`)?.classList.add("missing");
    box.textContent = `Answer every question before you submit. Not answered yet: ${missing.map((i) => i.title).join("; ")}. Pick an option, or choose Other and write your answer in the comment.`;
    box.hidden = false;
    return;
  }
  const verdict = document.querySelector('input[name="verdict"]:checked').value;
  const body = {
    verdict,
    summary: $("#summary").value.trim() || undefined,
    comments: review.pending.map(({ key, line, ...p }) => ({ ...p, line: line + 1 })),
    answers: Object.entries(review.answers).map(([item, choice]) => ({ item, choice, ...(choice === "other" ? { text: otherText(item) } : {}) })),
    resolved_threads: review.resolved,
    viewed: Object.keys(state.viewed).filter((k) => state.viewed[k]),
  };
  try {
    await post(`/api/reviews/${state.view.meta.id}/feedback`, body);
  } catch (err) {
    box.textContent = `${err.message}${err.body?.errors ? `: ${err.body.errors.map((e) => `${e.path} ${e.message}`).join("; ")}` : ""}`;
    box.hidden = false;
    return;
  }
  const words = { comment: "Comment", approved: "Approved", changes_requested: "Changes requested" };
  Object.assign(review, { pending: [], answers: {}, resolved: [], finishing: false, composer: null });
  persist();
  review.toast = `Review submitted: ${words[verdict]}. Claude picks it up through hoop wait or hoop_feedback.`;
  await load(state.view.meta.id);
  flash();
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (d.accept || d.reject) decide([d.accept || d.reject], d.accept ? "accept" : "reject");
  else if (d.acceptAll)
    decide(
      (state.view.edits ?? []).filter((x) => x.thread === d.acceptAll && x.status === "proposed" && x.position).map((x) => x.id),
      "accept",
    );
  else if (d.apply) applySuggestion(d.apply);
  else if (d.reply) openComposer({ item: d.item, line: +d.line, thread: d.reply });
  else if (d.item && t.classList.contains("add-btn")) openComposer({ item: d.item, line: +d.line });
  else if (d.editItem) editInPlace(d.editItem, +d.editLine);
  else if (d.resolve) {
    review.resolved.push(d.resolve);
    delete state.openThreads[d.resolve];
    persist();
    rerender();
  } else if (d.unresolve) {
    review.resolved = review.resolved.filter((x) => x !== d.unresolve);
    persist();
    rerender();
  } else if (d.drop) {
    review.pending = review.pending.filter((p) => p.key !== d.drop);
    persist();
    rerender();
  } else if (t.id === "toggleSuggest") {
    review.composer.body = $("#cbody").value;
    review.composer.suggest = !review.composer.suggest;
    if (!review.composer.suggest) delete review.composer.suggestion;
    rerender();
  } else if (t.id === "cancelComment") {
    review.composer = null;
    rerender();
  } else if (t.id === "addComment") {
    const c = review.composer,
      body = $("#cbody").value.trim(),
      suggestion = c.suggest ? $("#csugg").value : undefined;
    if (!body && suggestion === undefined) return $("#cbody").focus();
    const problem = suggestionProblem(c, suggestion);
    if (problem) {
      Object.assign(c, { body: $("#cbody").value, suggestion, problem });
      rerender();
      return $("#csugg")?.focus();
    }
    review.pending.push({ key: `p${Date.now()}${seq++}`, item: c.item, line: c.line, thread: c.thread, range: c.range, body: body || undefined, suggestion });
    review.composer = null;
    persist();
    rerender();
  } else if (t.id === "finishBtn") {
    review.finishing = !review.finishing;
    state.commentsHidden = false;
    rerender();
  } else if (t.id === "hideComments") toggleHidden(t);
  else if (t.id === "cancelFinish") {
    review.finishing = false;
    rerender();
  } else if (t.id === "submitReview") submit();
});

document.addEventListener("change", (e) => {
  const q = e.target.dataset?.q;
  if (q) {
    review.answers[q] = e.target.value;
    persist();
    // Other is answered in a comment on the question, the way + comments on a line.
    if (e.target.value === "other" && !otherText(q) && review.composer?.item !== q) openComposer({ item: q, line: -1, answer: true });
    else rerender();
  }
});

document.addEventListener("input", (e) => {
  if (!review.composer) return;
  if (e.target.id === "cbody") review.composer.body = e.target.value;
  if (e.target.id === "csugg") review.composer.suggestion = e.target.value;
});

/** Renders the page with the current notice, then removes the notice after six seconds. */
function flash() {
  rerender();
  setTimeout(() => {
    review.toast = "";
    document.querySelector(".toast")?.remove();
  }, 6000);
}

/** Accepts or rejects Claude's edits one by one (each accept is a new revision), keeping unsent comments. */
async function decide(ids, action) {
  const done = [];
  review.toast = "";
  for (const id of ids) {
    try {
      const res = await post(`/api/reviews/${state.view.meta.id}/edits/${id}`, { action });
      done.push(res.revision);
    } catch (err) {
      review.toast = `Couldn't ${action} ${id}: ${err.message}`;
      break;
    }
  }
  if (done.length && !review.toast)
    review.toast = action === "accept" ? `Accepted ${done.length} edit${done.length > 1 ? "s" : ""}; now rev ${done.at(-1)}.` : "Edit rejected.";
  await load(state.view.meta.id);
  persist();
  flash();
}

/** Materializes a suggestion into a new revision, keeping unsent comments. */
async function applySuggestion(thread) {
  try {
    const res = await post(`/api/reviews/${state.view.meta.id}/apply`, { thread });
    review.toast = `Applied in rev ${res.revision}: −${res.words.removed} +${res.words.added} words.`;
  } catch (err) {
    review.toast = `Couldn't apply: ${err.message}`;
  }
  await load(state.view.meta.id);
  persist(); // carry unsent comments over to the new revision
  flash();
}

/** Restore an unsent review after reload. */
export function restoreDraft() {
  const draft = loadDraft();
  Object.assign(review, { pending: draft.pending || [], answers: draft.answers || {}, resolved: draft.resolved || [] });
  rerender();
}
