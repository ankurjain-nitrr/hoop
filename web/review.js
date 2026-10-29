// Reviewing: line comments, suggestions, answers, threads with replies, and the verdict.
import { pieceMarker } from "/blocks.js";
import { VERDICT, verdictNow } from "/status.js";
import { renderLine } from "/inline.js";
import { icons } from "/icons.js";
import { $, esc, hooks, isDoc, loadDraft, load, render, show, state, textAt } from "/app.js";
import { post } from "/api.js";
import { readDrafts, rebase, writeDrafts } from "/drafts.js";
import { askBlockHtml } from "/ask.js";
import { isOutdated as changedSince, showsBelow } from "/place.js";

state.canReview = true;
// Everything unsent: comments, answers, resolutions, the overall comment, the open composer, and
// `stale` drafts whose lines changed in a newer revision. `revision` is the one they were written on.
const review = { revision: 0, pending: [], answers: {}, resolved: [], summary: "", composer: null, stale: [], placing: null, finishing: false, toast: "" };
state.composerRef = () => review.composer;
let seq = 0;

// An approved or closed revision's text is frozen: no Apply, no decisions on Claude's edits. It still
// takes comments, and a request for changes reopens it. A review another replaced takes nothing.
const frozen = () => state.view?.meta.status === "approved" || Boolean(state.view?.meta.closed);
const replaced = () => Boolean(state.view?.meta.superseded_by);
const question = (id) => state.view.doc.items.find((i) => i.id === id && i.choices?.length);
/** An option's label as the current revision words it, or undefined when the question or option is gone. */
const choiceLabel = (id, choice) => {
  const q = question(id);
  return !q ? undefined : choice === "other" ? "Other" : q.choices.find((c) => c.id === choice)?.label;
};
/** Whether an open composer holds words the reviewer wrote, which a reload or a new revision keeps. */
const written = (c) => Boolean(c && (c.body?.trim() || c.remove || (c.suggestion !== undefined && c.suggestion !== c.text)));
const drafts = () => ({
  revision: review.revision,
  pending: review.pending,
  answers: review.answers,
  labels: Object.fromEntries(Object.entries(review.answers).map(([id, c]) => [id, { title: question(id)?.title, label: choiceLabel(id, c) }])),
  resolved: review.resolved,
  summary: review.summary,
  composer: written(review.composer) ? review.composer : null,
  stale: review.stale,
});
const persist = () => writeDrafts(state.view.meta.id, drafts());
const pendingCount = () => review.pending.length + Object.keys(review.answers).length + review.resolved.length;

// A link to a question's card (`#ask-<id>`, from the ask's page) opens the card's section and goes to the card once.
let jump = /^#ask-rv_[a-z0-9]+$/.test(location.hash) ? location.hash.slice(5) : undefined;
hooks.loaded.push(() => {
  const a = jump && asks().find((x) => x.id === jump);
  if (a) Object.assign(state, { tab: "proposal", open: { ...state.open, [a.item]: true } });
});
hooks.rendered.push(() => {
  const el = jump && document.getElementById(`ask-${jump}`);
  if (!el) return;
  jump = undefined;
  el.setAttribute("tabindex", "-1");
  el.scrollIntoView({ block: "center" });
  el.focus({ preventScroll: true });
});

let restored = false;
// Each load carries the drafts to the revision shown: the first from storage, later ones from memory.
hooks.loaded.push(() => {
  const v = state.view;
  const legacy = () => ({ revision: v.meta.revisions, ...loadDraft() }); // kept per revision before drafts.js
  const saved = restored ? drafts() : (readDrafts(v.meta.id) ?? legacy());
  restored = true;
  const d = rebase(saved, {
    revision: v.meta.revisions,
    lineAt: (item, line) => textAt(item, line),
    linesOf: (item) => v.doc.items.find((i) => i.id === item)?.lines,
    choiceLabel,
  });
  const { revision, pending, answers, resolved, summary, composer, stale } = d;
  Object.assign(review, { revision, pending, answers, resolved, summary, composer, stale });
  if (!stale.some((x) => x.key === review.placing)) review.placing = null;
  persist();
});

/** Comment threads from earlier reviews, keyed by item and line, with replies in time order. */
function threads() {
  const all = new Map();
  for (const fb of state.view.feedback) {
    for (const c of fb.comments) {
      const t = all.get(c.thread) ?? { id: c.thread, item: c.item, line: c.line, revision: fb.revision, entries: [], resolved: false };
      t.entries.push({
        who: fb.reviewer,
        role: `reviewer · rev ${fb.revision}`,
        body: c.body,
        suggestion: c.suggestion,
        remove: c.remove,
        range: c.range,
        at: fb.at,
      });
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

/** The DOC anchors' names, by page index: the title, the TL;DR and the subtitle. */
const DOC_LINES = ["title", "TL;DR", "subtitle"];

/** What a comment at this anchor applies to: headings cover their section, the title, TL;DR and subtitle the document. */
function scopeLabel(itemId, idx) {
  if (itemId === "DOC") return `the ${DOC_LINES[idx]} (applies to the whole document)`;
  // A document's sections are named by their titles, since its IDs are hidden.
  const name = isDoc() ? sectionName(itemId) : itemId;
  if (idx === -1) return `${name} heading (applies to everything under it)`;
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

/** The words of Remove on a heading, as the builder's Remove reads. */
const REMOVE = "Remove this heading and everything under it";

/** The section a heading starts: its item and every later one with a deeper level, as `sectionItems` in src/contract.ts. */
function sectionOf(itemId) {
  const items = state.view.doc.items,
    at = items.findIndex((i) => i.id === itemId);
  if (at < 0) return [];
  const end = items.findIndex((i, k) => k > at && (!i.level || i.level <= items[at].level));
  return items.slice(at, end < 0 ? undefined : end).map((i) => i.id);
}

/** Whether a heading's section can be removed: a document's section with a heading, while something else would remain (`removalProblem`). */
function removable(itemId) {
  const item = state.view.doc.items.find((i) => i.id === itemId);
  if (!isDoc() || !item?.level) return false;
  const gone = sectionOf(itemId);
  return state.view.doc.items.some((i) => !gone.includes(i.id));
}

/**
 * The sections a removal is suggested on, unsent or in an open conversation, with the sections
 * nested in them. Each render works it out once, on its first use.
 */
let removingNow;
function removing() {
  if (removingNow) return removingNow;
  const open = threads().filter((t) => !isResolved(t) && !state.view.applied?.some((a) => a.thread === t.id) && t.entries.some((e) => e.remove));
  removingNow = new Set([...review.pending.filter((p) => p.remove), ...open].flatMap((x) => sectionOf(x.item)));
  return removingNow;
}
hooks.rendered.push(() => {
  removingNow = undefined;
});

/** Why a suggested removal can't be applied now, as the server's Apply decides it, or "". */
const removalRefused = (t) => (state.view.removals?.[t.id] ?? "").replace(/^\w+: /, "");

const removalHtml = () => `<div class="suggestion removal"><div class="lab">Suggested change</div><div class="o">${REMOVE}</div></div>`;

function suggestionHtml(original, suggestion) {
  return `<div class="suggestion"><div class="lab">Suggested change</div><div class="o">${esc(original)}</div><div class="n">${esc(suggestion)}</div></div>`;
}

/** A thread or question card is outdated when its line's text changed (or went away) after the revision it was left on. */
const isOutdated = (t) => changedSince(t, state.view.meta.revisions, textAt(t.item, t.line - 1, t.revision), lineText(t.item, t.line - 1));

/** Where a thread sits. A thread on an automatic TL;DR, which has no box, shows the TL;DR's text. */
function threadPlace(t) {
  if (t.item !== "DOC") return `Conversation on line ${t.line}`;
  if (t.line !== 2) return `Conversation on the ${DOC_LINES[t.line - 1]}`;
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

/** A conversation; on a removed section (`removed`) it has no line to reply on, so it offers only Resolve. */
function threadHtml(t, { removed = false } = {}) {
  const resolvedNow = isResolved(t);
  const outdated = isOutdated(t);
  const applied = state.view.applied?.find((a) => a.thread === t.id);
  const place = outdated ? `<span class="tag-outdated">Outdated</span> Rev ${t.revision}, line ${t.line}` : threadPlace(t);
  const stateLabel = applied ? `<span class="tag-applied">Applied in rev ${applied.revision}</span>` : resolvedNow ? "Resolved" : "Open";
  const body = threadBody(t, resolvedNow, outdated, applied, removed);
  // A resolved conversation collapses to one summary row until the reviewer opens it.
  if (resolvedNow) {
    const n = t.entries.length;
    return `<details class="thread resolved ${outdated ? "outdated" : ""}" data-comment="hide" data-thread="${esc(t.id)}" ${state.openThreads[t.id] ? "open" : ""}><summary class="thread-head"><span>${place}</span><span>${stateLabel} · ${n} ${n === 1 ? "comment" : "comments"}</span></summary>${body}</details>`;
  }
  return `<div class="thread ${outdated ? "outdated" : ""}" data-comment="hide"><div class="thread-head"><span>${place}</span><span>${stateLabel}</span></div>${body}</div>`;
}

function threadBody(t, resolvedNow, outdated, applied, removed = false) {
  // Apply takes the thread's latest suggestion; a removal applies only while the server's check passes.
  const latest = t.entries.filter((e) => e.suggestion !== undefined || e.remove).at(-1);
  const refused = latest?.remove && !applied && !frozen() ? removalRefused(t) : "";
  const canApply = !frozen() && !applied && !outdated && Boolean(latest) && !refused;
  const pendingResolve = review.resolved.includes(t.id);
  return `${refused ? `<p class="hint removal-refused">Can't apply: ${esc(refused)}.</p>` : ""}
    ${t.entries
      .map(
        (e) => `<div class="comment"><div class="who">${esc(e.who)} <span class="role">${esc(e.role)}</span></div>
      ${e.range ? quoteHtml(t.item, t.line - 1, e.range.quote) : ""}${e.body ? `<div>${esc(e.body)}</div>` : ""}
      ${e.suggestion !== undefined ? suggestionHtml(e.range?.quote ?? lineText(t.item, t.line - 1), e.suggestion) : ""}${e.remove ? removalHtml() : ""}</div>`,
      )
      .join("")}
    ${
      replaced()
        ? ""
        : `<div class="thread-actions">${canApply ? `<button class="btn small primary" data-apply="${esc(t.id)}">Apply suggestion</button>` : ""}${removed ? "" : `<button class="btn small" data-reply="${esc(t.id)}" data-item="${esc(t.item)}" data-line="${t.line - 1}">Reply</button>`}
      ${pendingResolve ? `<button class="btn small" data-unresolve="${esc(t.id)}">Unresolve</button>` : resolvedNow || frozen() ? "" : `<button class="btn small" data-resolve="${esc(t.id)}">Resolve conversation</button>`}</div>`
    }`;
}

/** The quick questions Claude asked about lines in this review, each placed as a thread on its line. */
const asks = () => (state.view.asks ?? []).map((a) => ({ ...a, item: a.anchor.item, line: a.anchor.line, revision: a.anchor.revision }));

const ASK_STATE = { open: "Waiting for your answer", answered: "Answered", closed: "Answered", withdrawn: "Withdrawn" };

/**
 * A quick question's card beside its line: the questions with the ask page's buttons, then its
 * answers. It moves with the line across revisions the way a thread does, and answering it sends
 * only the answer, never the review.
 */
function askCardHtml(a) {
  const outdated = isOutdated(a);
  const where = a.item === "DOC" ? `the ${DOC_LINES[a.line - 1]}` : a.line === 0 ? "the heading" : `line ${a.line}`;
  const place = outdated ? `<span class="tag-outdated">Outdated</span> Rev ${a.revision}, ${where}` : `Question from Claude on ${where}`;
  const quote = a.anchor.range ? quoteHtml(a.item, a.line - 1, a.anchor.range.quote) : "";
  return `<div class="thread ask-card ${outdated ? "outdated" : ""}" id="ask-${esc(a.id)}" data-comment="hide"><div class="thread-head"><span>${place}</span><span>${ASK_STATE[a.state]}</span></div>${quote ? `<div class="comment">${quote}</div>` : ""}${askBlockHtml(a)}</div>`;
}

function pendingHtml(p) {
  const original = p.range?.quote ?? lineText(p.item, p.line);
  return `<div class="thread" data-comment="hide"><div class="comment"><div class="who">You <span class="pending">Pending</span>${p.thread ? '<span class="role">reply</span>' : ""}${p.range ? '<span class="role">on selected text</span>' : ""}</div>
    ${p.range ? quoteHtml(p.item, p.line, p.range.quote) : ""}${p.body ? `<div>${esc(p.body)}</div>` : ""}
    ${p.suggestion !== undefined ? suggestionHtml(original, p.suggestion) : ""}${p.remove ? removalHtml() : ""}</div>
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
    ${c.remove ? removalHtml() : ""}
    <div class="row"><div>${c.thread || c.remove ? "" : `<button class="btn small" id="toggleSuggest">${c.suggest ? "Remove suggestion" : "Suggest a change"}</button>`}${
      !c.thread && !c.answer && !c.suggest && c.line === -1 && removable(c.item)
        ? `<button class="btn small" id="toggleRemove" aria-pressed="${Boolean(c.remove)}">${REMOVE}</button>`
        : ""
    }</div>
    <div><button class="btn small" id="cancelComment">Cancel</button><button class="btn small primary" id="addComment">${review.pending.length ? "Add review comment" : "Start a review"}</button></div></div></div>`;
}

/** The in-place editor: the line's text to change, and an optional note. */
function inPlaceHtml(c) {
  return `<div class="composer in-place"><label class="mono lab" for="csugg">Edit ${esc(scopeLabel(c.item, c.line))}</label>
    <textarea id="csugg" aria-describedby="csuggHint">${esc(c.suggestion ?? lineText(c.item, c.line))}</textarea><span class="mono lab warn" id="csuggHint" role="alert">${esc(c.problem ?? "")}</span>
    <label class="mono lab" for="cbody">Why (optional)</label><textarea id="cbody" placeholder="Say why, if it helps">${esc(c.body || "")}</textarea>
    <div class="row"><div></div><div><button class="btn small" id="cancelComment">Cancel</button><button class="btn small primary" id="addComment">${review.pending.length ? "Add review comment" : "Start a review"}</button></div></div></div>`;
}

/** How many conversations, question cards and pending comments the hide control hides. */
const hiddenCount = () => threads().length + asks().length + review.pending.length;
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

/** Why reopening an approved review needs something written; the API refuses it in the same words. */
const REOPEN_NEEDS = "Request changes needs something to change: comment on a line or section, or write an overall comment";

/** The answers the reviewer picked and hasn't sent; Other counts once its comment is written. */
const givenAnswers = () => Object.entries(review.answers).filter(([id, choice]) => choice !== "other" || otherText(id));

/**
 * The one verdict the reviewer's review takes now, and why (`verdictNow`, which the API checks
 * too). The server says what holds an approval up (`approval_holds`, from `approvalHolds` in
 * src/rules.ts); the page adds what the reviewer hasn't sent: new comments and answers, and the
 * conversations they resolve in this review.
 */
function currentVerdict() {
  const holds = state.view.approval_holds ?? { threads: [], questions_in_text: [] };
  return verdictNow({
    comments: review.pending.length,
    answers: givenAnswers().length,
    threads: holds.threads.filter((t) => !review.resolved.includes(t)).length,
    questions: holds.questions_in_text.length,
    unanswered: unanswered().length,
  });
}

// The verdict last shown, so a change is announced once, in the live region outside the page's
// redraws; and whether the verdict control had focus as a redraw began, so it keeps it.
let shownVerdict = "";
let verdictFocused = false;
const verdictLive = Object.assign(document.createElement("p"), { id: "verdictLive", className: "visually-hidden" });
verdictLive.setAttribute("aria-live", "polite");
document.body.append(verdictLive);

/**
 * The verdict control: one button, Approve or Request changes, with its reason beside it, and the
 * panel it opens for an overall comment. On an approved review it offers Request changes, which
 * reopens it.
 */
function verdictHtml(verdict, reason, note) {
  const label = VERDICT[verdict];
  const notes = verdict === "approved" ? "Notes for your approval (optional)" : "Overall comment (optional)";
  return `<span class="verdict-why" id="verdictWhy">${esc(reason)}</span><div class="finish-wrap"><button class="btn primary" id="finishBtn" data-verdict="${verdict}" aria-expanded="${review.finishing}" aria-controls="finishPop" aria-describedby="verdictWhy">${label}${pendingCount() > 0 ? `<span class="n">${pendingCount()}</span>` : ""}</button>
    <div class="popover" id="finishPop" ${review.finishing ? "" : "hidden"}><h2>${label}</h2>
      <p class="hint">${esc(note)}</p>
      <label class="mono lab" for="summary">${notes}</label>
      <textarea id="summary" placeholder="Kept with your review">${esc(review.summary)}</textarea>
      <p class="hint" id="finishHint" hidden>${REOPEN_NEEDS}.</p>
      <p class="error" id="finishError" hidden></p>
      <div class="row end"><button class="btn" id="cancelFinish">Cancel</button><button class="btn primary" id="submitReview" aria-describedby="finishHint">Submit review</button></div></div></div>`;
}

// The header shows the review's status badge itself, so a replaced review adds nothing here.
hooks.top.push(() => {
  if (replaced()) return "";
  verdictFocused = document.activeElement?.id === "finishBtn";
  if (frozen()) {
    const what = state.view.meta.closed ? "closed" : "approved";
    return verdictHtml("changes_requested", `reopens this ${what} review`, `Reopens this ${what} review. Claude revises, and you approve the new revision.`);
  }
  const now = currentVerdict();
  const q = state.view.approval_holds?.questions_in_text.length ?? 0;
  // A review a person opened from a file has no session to revise it (`questionsLeft` in src/rules.ts).
  if (q && state.view.meta.opened_by && !state.view.meta.owner) {
    const todo = `write the ${q === 1 ? "decision" : "decisions"} into the file and open it again`;
    return verdictHtml(now.verdict, `${now.reason}: ${todo}`, `No session revises a review opened from a file: ${todo}.`);
  }
  const note = now.verdict === "approved" ? "Claude continues from this revision." : "Claude revises and submits a new revision.";
  return verdictHtml(now.verdict, now.reason, note);
});

/** Keeps focus on the verdict control through a redraw, and says when its verdict changed. */
hooks.rendered.push(() => {
  const button = $("#finishBtn");
  if (verdictFocused) button?.focus({ preventScroll: true });
  const verdict = button?.dataset.verdict ?? "";
  if (shownVerdict && verdict && verdict !== shownVerdict) verdictLive.textContent = `Now ${VERDICT[verdict]}: ${$("#verdictWhy").textContent}`;
  shownVerdict = verdict;
});

/** On an approved review, turns Submit off, and says what to add, while the request would ask for nothing. */
function syncSubmit() {
  const button = $("#submitReview");
  if (!button) return;
  // A reply Claude adds after the approval reopens a thread, but asks the reviewer for nothing.
  const empty = frozen() && !review.pending.length && !givenAnswers().length && !$("#summary").value.trim();
  button.disabled = empty;
  $("#finishHint").hidden = !empty;
}
hooks.rendered.push(syncSubmit);

hooks.item.push((item, where) => {
  // A section suggested for removal shows struck through, with the sections nested in it.
  if (where === "class") return removing().has(item.id) ? " removing" : "";
  if (where === "head") return removing().has(item.id) ? '<span class="removal-tag">Suggested for removal</span>' : "";
  if (where !== "badge") return "";
  const n = review.pending.filter((p) => p.item === item.id).length + (review.answers[item.id] ? 1 : 0);
  return n ? String(n) : "";
});

hooks.line.push((item, line, where) => {
  if (where === "gutter")
    return replaced()
      ? ""
      : `<button class="add-btn" aria-label="Comment on ${esc(scopeLabel(item.id, line))}" data-item="${esc(item.id)}" data-line="${line}">+</button>`;
  // Editing a line in place opens the composer with the line's text as the suggestion.
  if (where === "end")
    return replaced()
      ? ""
      : `<button class="edit-btn" aria-label="Edit ${esc(scopeLabel(item.id, line))} in place" title="Edit in place" data-edit-item="${esc(item.id)}" data-edit-line="${line}">${icons.edit}</button>`;
  if (where !== "below") return undefined;
  const cards = proposalsOn(item.id, line).map(editCardHtml).join("");
  // Threads and question cards on lines that no longer exist collect under the item's last line.
  const here = (t) => showsBelow(t, item.id, line, item.lines.length);
  let html = cards + asks().filter(here).map(askCardHtml).join("") + threads().filter(here).map(threadHtml).join("");
  html += review.pending
    .filter((p) => p.item === item.id && p.line === line)
    .map(pendingHtml)
    .join("");
  const c = review.composer;
  if (c && c.item === item.id && c.line === line) html += composerHtml(c);
  return html;
});

// Conversations on sections a later revision removed have no line to sit under, so they collect here,
// where the reviewer can still read and resolve them.
hooks.after.push(() => {
  const ids = new Set(state.view.doc.items.map((i) => i.id));
  const gone = threads().filter((t) => t.item !== "DOC" && !ids.has(t.item));
  if (!gone.length) return "";
  return `<section class="removed-threads" aria-labelledby="removed-h"><h2 id="removed-h">On removed sections</h2>${gone
    .map((t) => {
      const heading = textAt(t.item, -1, t.revision);
      // Each conversation is a group named by the section it was on.
      return `<div class="removed-group" role="group" aria-labelledby="ra-${esc(t.id)}"><h3 class="removed-at" id="ra-${esc(t.id)}">${esc(heading ? `"${heading}"` : t.item)}, revision ${t.revision}</h3>${threadHtml(t, { removed: true })}</div>`;
    })
    .join("")}</section>`;
});

hooks.after.push(() => (review.toast ? `<div class="toast" role="status">${esc(review.toast)}</div>` : ""));

/** The answers in force: kept from earlier revisions, then submitted on this one, then unsent. */
function shownAnswers() {
  const rev = state.view.meta.revisions,
    sent = {};
  for (const a of carried()) sent[a.item] = a.choice;
  for (const fb of state.view.feedback) if (fb.revision === rev) for (const a of fb.answers) sent[a.item] = a.choice;
  return { ...sent, ...review.answers };
}

/** Earlier revisions' answers to questions this revision asks unchanged and hasn't answered yet. */
const carried = () => state.view.carried ?? [];

/** The reviewer's own answer to a question: their unsent comments on its heading. */
const otherText = (id) =>
  review.pending
    .filter((p) => p.item === id && p.line === -1 && !p.thread && p.body)
    .map((p) => p.body)
    .join("\n\n");

/**
 * The questions with no answer yet: none unsent, sent on this revision, or kept from an earlier
 * revision that asked the same question. Other counts only with a comment on the question.
 */
function unanswered() {
  const rev = state.view.meta.revisions;
  const sent = new Set([
    ...carried().map((a) => a.item),
    ...state.view.feedback.filter((fb) => fb.revision === rev).flatMap((fb) => fb.answers.map((a) => a.item)),
  ]);
  const answered = (id) => (review.answers[id] ? review.answers[id] !== "other" || Boolean(otherText(id)) : sent.has(id));
  return state.view.doc.items.filter((i) => i.choices?.length && !answered(i.id));
}

// Every render (including tree collapses and tab switches) shows the answers chosen so far.
hooks.rendered.push(() => {
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
  review.pending.push({ key: `p${Date.now()}${seq++}`, ...c, text, body: "Delete this text.", suggestion: "" });
  persist();
  rerender();
}

export function openComposer(c) {
  // A reviewer never writes with comments hidden.
  state.commentsHidden = false;
  review.composer = { body: "", suggest: false, ...c, text: lineText(c.item, c.line) };
  persist();
  rerender();
  $("#cbody")?.focus();
}

/**
 * Sends the review with the verdict it takes now (`currentVerdict`). A request for changes may leave
 * questions unanswered: feedback can make one obsolete, and Claude reads which are still open.
 * Answers kept from earlier revisions go again with this one, so its feedback carries every answer
 * in force.
 */
async function submit(verdict, summary) {
  const fail = (message) => Object.assign($("#finishError"), { textContent: message, hidden: false });
  const given = givenAnswers();
  const body = {
    verdict,
    summary,
    comments: review.pending.map(({ key, line, ...p }) => ({ ...p, line: line + 1 })),
    answers: [
      ...given.map(([item, choice]) => ({ item, choice, ...(choice === "other" ? { text: otherText(item) } : {}) })),
      ...carried().filter((a) => !given.some(([item]) => item === a.item)),
    ],
    resolved_threads: review.resolved,
    viewed: Object.keys(state.viewed).filter((k) => state.viewed[k]),
  };
  let sent;
  try {
    sent = await post(`/api/reviews/${state.view.meta.id}/feedback`, body);
  } catch (err) {
    // An approval refused over something the page didn't know yet, such as a session's comment that came
    // in since it loaded: show the review as it is now, so the new conversation shows with Resolve
    // and the control offers Request changes.
    if (verdict === "approved" && /^hoop didn.t approve/.test(err.body?.error ?? "")) {
      await load(state.view.meta.id);
      review.finishing = false;
      review.toast = `Not approved: ${err.body.errors?.[0]?.message ?? err.message}.`;
      return flash();
    }
    return fail(`${err.message}${err.body?.errors ? `: ${err.body.errors.map((e) => `${e.path} ${e.message}`).join("; ")}` : ""}`);
  }
  const words = { approved: "Approved", changes_requested: "Changes requested" };
  // The new status says what happened, so the control that follows isn't announced as a change.
  shownVerdict = "";
  Object.assign(review, { pending: [], answers: {}, resolved: [], summary: "", finishing: false, composer: null });
  persist();
  review.toast = [`Review submitted: ${words[verdict]}.`, deliveryText(sent.delivery)].filter(Boolean).join(" ");
  // The header's status and receipt come from the submit's answer, not from asking again.
  await show(sent.view);
  flash();
}

/** What the notice after a submit says about how the review reached Claude's session. */
function deliveryText(d) {
  const ask = "ask Claude in its session to read your review";
  switch (d?.outcome) {
    case "sent":
      return "Sent to Claude's session, which reads it now.";
    case "waiting":
      return "Claude was waiting and has it now.";
    case "no_session":
      return `No live Claude session took it: resume the session and ${ask}.`;
    case "failed":
      return `Couldn't reach Claude's session (${d.error ?? "no answer"}): ${ask}.`;
    default:
      return "Claude picks it up through hoop wait or hoop_feedback.";
  }
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
  else if (d.item && t.classList.contains("add-btn")) {
    const s = review.stale.find((x) => x.key === review.placing);
    openComposer(s ? placed(s, d.item, +d.line) : { item: d.item, line: +d.line });
  } else if (d.place) {
    review.placing = review.placing === d.place ? null : d.place;
    rerender();
    $(`[data-place="${CSS.escape(d.place)}"]`)?.focus();
  } else if (d.discard) {
    review.stale = review.stale.filter((x) => x.key !== d.discard);
    if (review.placing === d.discard) review.placing = null;
    persist();
    rerender();
    ($(".stale-drafts [data-discard]") ?? $(".top h1"))?.focus();
  } else if (d.editItem) editInPlace(d.editItem, +d.editLine);
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
  } else if (t.id === "toggleRemove") {
    review.composer.body = $("#cbody").value;
    review.composer.remove = !review.composer.remove;
    persist();
    rerender();
    $("#toggleRemove")?.focus();
  } else if (t.id === "cancelComment") {
    review.composer = null;
    review.placing = null;
    persist();
    rerender();
  } else if (t.id === "addComment") {
    const c = review.composer,
      body = $("#cbody").value.trim(),
      suggestion = c.suggest ? $("#csugg").value : undefined;
    if (!body && suggestion === undefined && !c.remove) return $("#cbody").focus();
    const problem = suggestionProblem(c, suggestion);
    if (problem) {
      Object.assign(c, { body: $("#cbody").value, suggestion, problem });
      rerender();
      return $("#csugg")?.focus();
    }
    review.pending.push({
      key: `p${Date.now()}${seq++}`,
      item: c.item,
      line: c.line,
      text: lineText(c.item, c.line),
      thread: c.thread,
      range: c.range,
      body: body || undefined,
      suggestion,
      ...(c.remove ? { remove: true } : {}),
    });
    if (c.from) review.stale = review.stale.filter((x) => x.key !== c.from);
    review.placing = null;
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
  } else if (t.id === "submitReview") submit($("#finishBtn").dataset.verdict, $("#summary").value.trim() || undefined);
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
  if (e.target.id === "summary") {
    review.summary = e.target.value;
    persist();
    return syncSubmit();
  }
  if (!review.composer) return;
  if (e.target.id === "cbody") review.composer.body = e.target.value;
  if (e.target.id === "csugg") review.composer.suggestion = e.target.value;
  persist();
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

/**
 * A stale draft placed on another line: its words, and its suggestion where it still fits, which
 * for a suggestion on selected text means the line holds that text.
 */
function placed(s, item, line) {
  const text = lineText(item, line);
  const at = s.range ? text.indexOf(s.range.quote) : -1;
  const range = at >= 0 ? { start: at, end: at + s.range.quote.length, quote: s.range.quote } : undefined;
  const suggest = s.suggestion !== undefined && (!s.range || Boolean(range));
  return {
    item,
    line,
    range,
    body: s.body ?? "",
    suggest,
    ...(suggest ? { suggestion: s.suggestion } : {}),
    ...(s.remove && line === -1 && removable(item) ? { remove: true } : {}),
    from: s.key,
  };
}

/** Where a stale draft was, in its own revision. */
const wasAt = (s) => (s.item === "DOC" ? `the ${DOC_LINES[s.line]}` : s.line === -1 ? "a heading" : `line ${s.line + 1}`);

function staleHtml(s) {
  const what = s.answer
    ? `<div>Your answer to ${esc(s.answer.title ? `“${s.answer.title}”` : "a question")}: ${esc(s.answer.label ?? s.answer.choice)}. Pick it again on the question.</div>`
    : `${s.text !== undefined ? `<div class="quote">${esc(s.range?.quote ?? s.text)}</div>` : ""}${s.body ? `<div>${esc(s.body)}</div>` : ""}${
        s.suggestion !== undefined ? suggestionHtml(s.range?.quote ?? s.text ?? "", s.suggestion) : ""
      }${s.remove ? removalHtml() : ""}`;
  const place =
    s.answer || frozen() ? "" : `<button class="btn small" data-place="${esc(s.key)}" aria-pressed="${review.placing === s.key}">Place again</button>`;
  return `<li class="thread"><div class="comment"><div class="who">${s.answer ? "Answer" : s.thread ? "Reply" : "Comment"} <span class="role">was on ${esc(wasAt(s))}</span></div>${what}</div>
    <div class="thread-actions">${place}<button class="btn small" data-discard="${esc(s.key)}">Discard</button></div></li>`;
}

// Drafts whose lines changed in a newer revision wait at the top until placed again or discarded.
hooks.before.push(() => {
  if (!review.stale.length) return "";
  const revs = [...new Set(review.stale.map((s) => s.revision))].sort((a, b) => a - b);
  const groups = revs
    .map(
      (r) =>
        `<h2>Drafts from revision ${r}</h2><ul>${review.stale
          .filter((s) => s.revision === r)
          .map(staleHtml)
          .join("")}</ul>`,
    )
    .join("");
  const hint = review.placing ? "Press + on the line where this draft belongs." : "";
  return `<section class="stale-drafts" aria-label="Unsent drafts"><p>Their lines changed or are gone in revision ${state.view.meta.revisions}. Place each one again, or discard it. They aren't sent until placed.</p>${groups}<p class="placing" role="status">${hint}</p></section>`;
});
