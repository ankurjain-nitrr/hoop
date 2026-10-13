// Reviewing: line comments, suggestions, answers, threads with replies, and Finish your review.
import { $, api, esc, hooks, loadDraft, load, render, saveDraft, state } from "/app.js";

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
    for (const id of fb.resolved_threads) all.get(id) && (all.get(id).resolved = true);
  }
  for (const r of state.view.replies) all.get(r.thread)?.entries.push({ who: r.author, role: "author", body: r.body, at: r.at });
  for (const t of all.values()) t.entries.sort((a, b) => a.at.localeCompare(b.at));
  return [...all.values()];
}

/** Text ranges with comments on a line (0-based), pending and earlier, for highlighting. */
export function rangesOn(itemId, line) {
  const earlier = state.view.feedback.flatMap((f) => f.comments).filter((c) => c.item === itemId && c.line === line + 1 && c.range).map((c) => c.range);
  return [...earlier, ...review.pending.filter((p) => p.item === itemId && p.line === line && p.range).map((p) => p.range)];
}

function lineText(itemId, line) {
  return state.view.doc.items.find((i) => i.id === itemId)?.lines[line] ?? "";
}

function suggestionHtml(original, suggestion) {
  return `<div class="suggestion"><div class="lab">Suggested change</div><div class="o">${esc(original)}</div><div class="n">${esc(suggestion)}</div></div>`;
}

function threadHtml(t) {
  const resolvedNow = t.resolved || review.resolved.includes(t.id);
  return `<div class="thread ${resolvedNow ? "resolved" : ""}"><div class="thread-head"><span>Conversation on line ${t.line}</span><span>${resolvedNow ? "Resolved" : "Open"}</span></div>
    ${t.entries.map((e) => `<div class="comment"><div class="who">${esc(e.who)} <span class="role">${esc(e.role)}</span></div>
      ${e.range ? `<div class="quote">${esc(e.range.quote)}</div>` : ""}${e.body ? `<div>${esc(e.body)}</div>` : ""}
      ${e.suggestion !== undefined ? suggestionHtml(e.range?.quote ?? lineText(t.item, t.line - 1), e.suggestion) : ""}</div>`).join("")}
    ${frozen() ? "" : `<div class="thread-actions"><button class="btn small" data-reply="${esc(t.id)}" data-item="${esc(t.item)}" data-line="${t.line - 1}">Reply</button>
      ${resolvedNow && !t.resolved ? `<button class="btn small" data-unresolve="${esc(t.id)}">Unresolve</button>` : t.resolved ? "" : `<button class="btn small" data-resolve="${esc(t.id)}">Resolve conversation</button>`}</div>`}</div>`;
}

function pendingHtml(p) {
  const original = p.range?.quote ?? lineText(p.item, p.line);
  return `<div class="thread"><div class="comment"><div class="who">You <span class="pending">Pending</span>${p.thread ? '<span class="role">reply</span>' : ""}${p.range ? '<span class="role">on selected text</span>' : ""}</div>
    ${p.range ? `<div class="quote">${esc(p.range.quote)}</div>` : ""}${p.body ? `<div>${esc(p.body)}</div>` : ""}
    ${p.suggestion !== undefined ? suggestionHtml(original, p.suggestion) : ""}</div>
    <div class="thread-actions"><button class="btn small" data-drop="${p.key}">Delete</button></div></div>`;
}

function composerHtml(c) {
  const original = c.range?.quote ?? lineText(c.item, c.line);
  return `<div class="composer"><label class="mono lab" for="cbody">${c.thread ? "Reply" : `Comment on ${esc(c.item)} line ${c.line + 1}${c.range ? ", selected text" : ""}`}</label>
    ${c.range ? `<div class="quote">${esc(c.range.quote)}</div>` : ""}
    ${c.thread || c.range ? "" : `<label class="mono lab" for="cpart">Only about this text (optional)</label><input id="cpart" class="part" autocomplete="off" placeholder="Type the words you mean"><span class="mono lab" id="cpartHint" aria-live="polite"></span>`}
    <textarea id="cbody" placeholder="Leave a comment">${esc(c.body || "")}</textarea>
    ${c.suggest ? `<label class="mono lab" for="csugg">${c.range ? "Replace the selected text with" : "Suggested text"}</label><textarea id="csugg">${esc(c.suggestion ?? original)}</textarea>` : ""}
    <div class="row"><div>${c.thread ? "" : `<button class="btn small" id="toggleSuggest">${c.suggest ? "Remove suggestion" : "Suggest a change"}</button>`}</div>
    <div><button class="btn small" id="cancelComment">Cancel</button><button class="btn small primary" id="addComment">${review.pending.length ? "Add review comment" : "Start a review"}</button></div></div></div>`;
}

hooks.top.push(() => frozen()
  ? `<span class="pill approved">Approved: Claude can start work</span>`
  : `<div class="finish-wrap"><button class="btn primary" id="finishBtn" aria-expanded="${review.finishing}" aria-controls="finishPop">Finish your review<span class="n">${pendingCount()}</span></button>
    <div class="popover" id="finishPop" ${review.finishing ? "" : "hidden"}><h2>Finish your review</h2>
      <textarea id="summary" placeholder="Leave an overall comment (optional)"></textarea>
      <div class="verdicts" role="radiogroup" aria-label="Verdict">
        <label><input type="radio" name="verdict" id="v-comment" value="comment" checked> Comment <small>Feedback without a verdict. Claude replies but doesn't proceed.</small></label>
        <label><input type="radio" name="verdict" id="v-approve" value="approved"> Approve <small>Freeze this revision. Claude starts work.</small></label>
        <label><input type="radio" name="verdict" id="v-changes" value="changes_requested"> Request changes <small>Claude revises and submits a new revision.</small></label>
      </div>
      <p class="error" id="finishError" hidden></p>
      <div class="row end"><button class="btn" id="cancelFinish">Cancel</button><button class="btn primary" id="submitReview">Submit review</button></div></div></div>`);

hooks.item.push((item, where) => {
  if (where !== "badge") return "";
  const n = review.pending.filter((p) => p.item === item.id).length + (review.answers[item.id] ? 1 : 0);
  return n ? String(n) : "";
});

hooks.line.push((item, line, where) => {
  if (where === "gutter") return frozen() ? "" : `<button class="add-btn" aria-label="Comment on ${esc(item.id)} line ${line + 1}" data-item="${esc(item.id)}" data-line="${line}">+</button>`;
  if (where !== "below") return undefined;
  let html = threads().filter((t) => t.item === item.id && t.line === line + 1).map(threadHtml).join("");
  html += review.pending.filter((p) => p.item === item.id && p.line === line).map(pendingHtml).join("");
  const c = review.composer;
  if (c && c.item === item.id && c.line === line) html += composerHtml(c);
  return html;
});

hooks.after.push(() => review.toast ? `<div class="toast" role="status">${esc(review.toast)}</div>` : "");

/** Answers submitted on this revision, overridden by unsent ones. */
function shownAnswers() {
  const rev = state.view.meta.revisions, sent = {};
  for (const fb of state.view.feedback) if (fb.revision === rev) for (const a of fb.answers) sent[a.item] = a.choice;
  return { ...sent, ...review.answers };
}

function rerender() {
  render();
  for (const [q, choice] of Object.entries(shownAnswers())) {
    const el = document.getElementById(`q-${q}-${choice}`);
    if (el) el.checked = true;
  }
}

export function openComposer(c) {
  review.composer = { body: "", suggest: false, ...c };
  rerender();
  $("#cbody")?.focus();
}

async function submit() {
  const verdict = document.querySelector('input[name="verdict"]:checked').value;
  const body = {
    verdict,
    summary: $("#summary").value.trim() || undefined,
    comments: review.pending.map(({ key, line, ...p }) => ({ ...p, line: line + 1 })),
    answers: Object.entries(review.answers).map(([item, choice]) => ({ item, choice })),
    resolved_threads: review.resolved,
    viewed: Object.keys(state.viewed).filter((k) => state.viewed[k]),
  };
  try {
    await api(`/api/reviews/${state.view.meta.id}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) {
    const box = $("#finishError");
    box.textContent = `${err.message}${err.body?.errors ? `: ${err.body.errors.map((e) => `${e.path} ${e.message}`).join("; ")}` : ""}`;
    box.hidden = false;
    return;
  }
  const words = { comment: "Comment", approved: "Approved", changes_requested: "Changes requested" };
  Object.assign(review, { pending: [], answers: {}, resolved: [], finishing: false, composer: null });
  persist();
  review.toast = `Review submitted: ${words[verdict]}. Claude picks it up through hoop wait or hoop_feedback.`;
  await load(state.view.meta.id);
  rerender();
  setTimeout(() => { review.toast = ""; document.querySelector(".toast")?.remove(); }, 6000);
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (d.reply) openComposer({ item: d.item, line: +d.line, thread: d.reply });
  else if (d.item && t.classList.contains("add-btn")) openComposer({ item: d.item, line: +d.line });
  else if (d.resolve) { review.resolved.push(d.resolve); persist(); rerender(); }
  else if (d.unresolve) { review.resolved = review.resolved.filter((x) => x !== d.unresolve); persist(); rerender(); }
  else if (d.drop) { review.pending = review.pending.filter((p) => p.key !== d.drop); persist(); rerender(); }
  else if (t.id === "toggleSuggest") {
    review.composer.body = $("#cbody").value;
    review.composer.suggest = !review.composer.suggest;
    if (!review.composer.suggest) delete review.composer.suggestion;
    rerender();
  } else if (t.id === "cancelComment") { review.composer = null; rerender(); }
  else if (t.id === "addComment") {
    const c = review.composer, body = $("#cbody").value.trim(), suggestion = c.suggest ? $("#csugg").value : undefined;
    if (!body && suggestion === undefined) return $("#cbody").focus();
    review.pending.push({ key: `p${Date.now()}${seq++}`, item: c.item, line: c.line, thread: c.thread, range: c.range, body: body || undefined, suggestion });
    review.composer = null;
    persist();
    rerender();
  } else if (t.id === "finishBtn") { review.finishing = !review.finishing; rerender(); }
  else if (t.id === "cancelFinish") { review.finishing = false; rerender(); }
  else if (t.id === "submitReview") submit();
});

document.addEventListener("change", (e) => {
  const q = e.target.dataset?.q;
  if (q) { review.answers[q] = e.target.value; persist(); rerender(); }
});

document.addEventListener("input", (e) => {
  if (!review.composer) return;
  if (e.target.id === "cbody") review.composer.body = e.target.value;
  if (e.target.id === "csugg") review.composer.suggestion = e.target.value;
});

/** Restore an unsent review after reload. */
export function restoreDraft() {
  const draft = loadDraft();
  Object.assign(review, { pending: draft.pending || [], answers: draft.answers || {}, resolved: draft.resolved || [] });
  rerender();
}
