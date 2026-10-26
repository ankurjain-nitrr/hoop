// Quick questions: each question's options as buttons, answered with one click and sent at once,
// with no review to submit. 1 to 4 answer the focused question; Enter in Other sends it. The same
// questions show on the ask's own page (`renderAsk`) and as a card beside a review line
// (`askBlockHtml`, which review.js places); answering a card touches only the ask, never the review.
import { $, agentHtml, byline, esc, frame, post, readAt, receiptHtml, receiptText, render, state } from "/app.js";
import { statusBadge } from "/status.js";

const app = $("#app");
/** Each ask's open Other box and last message, by ask ID. */
const ui = new Map();
const uiOf = (id) => ui.get(id) ?? ui.set(id, { other: null, message: "" }).get(id);
/** Notes typed under questions, by their box's ID, so any redraw of the page keeps them. */
const notes = {};

/** The ask with this ID: the page's own, or one of the cards on a review page. */
const askOf = (id) => (!id ? undefined : state.view?.ask?.id === id ? state.view.ask : state.view?.asks?.find((a) => a.id === id));
/** A card sits on a review page, among other cards and the review's own controls, so its element IDs carry the ask's ID. */
const card = (ask) => state.view?.ask?.id !== ask.id;
const pre = (ask) => (card(ask) ? `${ask.id}-` : "");
const open = (ask) => ask.state !== "withdrawn";
const latest = (q) => q.answers.at(-1);

/** An answer as people read it: the option's letter and label, or the person's own words. */
function said(q, a) {
  if (a.choice === "other") return `Other: “${a.text ?? ""}”`;
  const o = q.options.find((c) => c.id === a.choice);
  return `${a.choice}. ${o?.label ?? ""}`;
}

/** Whether Claude read an answer. The ask page keeps its receipts current; a card shows them as the review page loaded them. */
const receipt = (ask, key) => (card(ask) ? `<span class="receipt">${esc(receiptText(key, ask))}</span>` : receiptHtml(key));

/** The answer a question has: what, who and when, how it was taken, and whether Claude read it. */
function answerHtml(ask, q) {
  const a = latest(q);
  if (!a) return `<p class="ask-answer none">Not answered yet.</p>`;
  const prev = a.corrects ? ` (changed from ${esc(said(q, a.corrects))})` : "";
  const how = a.recommended ? " · taken with Go with your recommendation" : "";
  return `<p class="ask-answer"><b>Answer:</b> ${esc(said(q, a))}${prev} · ${esc(a.by)}, ${esc(readAt(a.at))}${how} · ${receipt(ask, a.key)}</p>${a.note ? `<p class="ask-note-shown">Note: ${esc(a.note)}</p>` : ""}`;
}

/** Every earlier answer to a question, folded. */
function historyHtml(q) {
  const earlier = q.answers.slice(0, -1);
  if (!earlier.length) return "";
  const rows = earlier.map((a) => `<li>${esc(said(q, a))} · ${esc(a.by)}, ${esc(readAt(a.at))}</li>`).join("");
  return `<details class="ask-history"><summary>Earlier answers (${earlier.length})</summary><ul>${rows}</ul></details>`;
}

/** The box Other opens, drawn right after the Other button so it reads and shows as Other's own. */
function otherFormHtml(ask, q) {
  const a = latest(q);
  const id = esc(q.id);
  const key = `${esc(pre(ask))}${id}`;
  return `<form class="ask-other" data-q="${id}"><label for="other-${key}">Your answer</label><input id="other-${key}" name="text" autocomplete="off" value="${a?.choice === "other" ? esc(a.text ?? "") : ""}" required><button type="submit" class="btn small primary">Send</button><button type="button" class="btn small" data-other-cancel>Cancel</button></form>`;
}

function questionHtml(ask, q, n) {
  const a = latest(q);
  const off = open(ask) ? "" : "disabled";
  const id = esc(q.id);
  const key = `${esc(pre(ask))}${id}`;
  const options = q.options
    .map(
      (o, i) =>
        `<button type="button" class="btn ask-opt" data-q="${id}" data-choice="${esc(o.id)}" aria-pressed="${a?.choice === o.id}" aria-keyshortcuts="${i + 1}" ${off}><span class="key mono" aria-hidden="true">${i + 1}</span> ${esc(o.id)}. ${esc(o.label)}${o.recommended ? ' <span class="rec">recommended</span>' : ""}</button>`,
    )
    .join("");
  const other = `<button type="button" class="btn ask-opt" data-q="${id}" data-other aria-pressed="${a?.choice === "other"}" aria-expanded="${uiOf(ask.id).other === q.id}" ${off}>Other</button>`;
  const otherForm = uiOf(ask.id).other === q.id && open(ask) ? otherFormHtml(ask, q) : "";
  const note = open(ask)
    ? `<div class="ask-note"><label for="note-${key}">Note (optional, sent with your answer)</label><textarea id="note-${key}" rows="2">${esc(notes[`note-${pre(ask)}${q.id}`] ?? "")}</textarea></div>`
    : "";
  return `<section class="ask-q" data-q="${id}" aria-labelledby="qt-${key}">
    <h2 id="qt-${key}">${ask.questions.length > 1 ? `<span class="qn">${n + 1}.</span> ` : ""}${esc(q.question)}</h2>
    ${q.context ? `<p class="ask-context">${esc(q.context)}</p>` : ""}
    <div class="ask-opts" role="group" aria-labelledby="qt-${key}">${options}${other}${otherForm}</div>
    ${note}${answerHtml(ask, q)}${historyHtml(q)}
  </section>`;
}

/** An ask's questions, its withdrawal and Go with your recommendation, wherever it shows. */
export function askBlockHtml(ask) {
  const n = ask.questions.length;
  const unanswered = ask.questions.filter((q) => !q.answers.length).length;
  const withdrawn = ask.withdrawn
    ? `<section class="decided" role="status"><p>Claude withdrew ${n > 1 ? "these questions" : "this question"}: ${esc(ask.withdrawn.reason)}</p></section>`
    : "";
  const goId = card(ask) ? `goRec-${esc(ask.id)}` : "goRec";
  const go =
    open(ask) && unanswered
      ? `<div class="ask-actions"><button type="button" class="btn go-rec" id="${goId}" aria-describedby="${goId}-hint">Go with your recommendation</button><span class="ask-hint" id="${goId}-hint">Answers ${unanswered === n ? (n > 1 ? "every question" : "the question") : `the ${unanswered} unanswered`} with Claude's recommended option.</span></div>`
      : "";
  return `<div class="ask-block" data-ask="${esc(ask.id)}">${withdrawn}${ask.questions.map((q, i) => questionHtml(ask, q, i)).join("")}${go}<p class="ask-status" role="status" aria-live="polite">${esc(uiOf(ask.id).message)}</p></div>`;
}

/** Where an ask points, as its page says it: the line's words, linking to its card on the review. */
function aboutHtml(ask) {
  const at = ask.anchor;
  if (!at) return "";
  const words = at.range?.quote ?? at.text;
  return `<p class="ask-about">About ${words ? `“${esc(words)}” in ` : "a line in "}<a href="/r/${esc(at.review_id)}#ask-${esc(ask.id)}">${esc(at.title ?? at.review_id)}</a></p>`;
}

/** Draws the ask's own page from `state.view`, keeping focus on the control that had it. */
export function renderAsk(focus) {
  const v = state.view;
  const { ask } = v;
  const n = ask.questions.length;
  document.title = `${v.meta.title} · hoop`;
  app.innerHTML = frame(
    "",
    `<header class="top">
      <div class="title-row"><h1>${n > 1 ? `${n} quick questions` : "A quick question"} from Claude</h1></div>
      <div class="sub">${statusBadge(v.status_key)}${byline(v)}</div>
      ${aboutHtml(ask)}
      ${agentHtml(v.agent)}
    </header>
    <main class="ask">${askBlockHtml(ask)}</main>`,
    state.info,
  );
  if (focus) $(focus)?.focus();
}

/** What a sent answer did, from how it reached Claude's session. */
const DELIVERED = {
  sent: "Sent to Claude's session.",
  waiting: "Claude is waiting and has it.",
  no_session: "Saved. No live Claude session took it; it reads it when it resumes.",
  failed: "Saved, but Claude's session couldn't be reached.",
};

/**
 * Sends an answer, then draws the ask again: its own page, or its card on the review page, where
 * the review's unsent comments, answers and verdict stay as they were.
 */
async function send(id, body, focus) {
  const page = uiOf(id);
  try {
    const v = await post(`/api/reviews/${id}/answer`, body);
    page.message = v.delivery ? DELIVERED[v.delivery.outcome] : "Saved.";
    page.other = null;
    if (body.question) delete notes[`note-${pre(askOf(id))}${body.question}`];
    if (state.view.ask?.id === id) state.view = v;
    else state.view.asks = state.view.asks.map((a) => (a.id === id ? { ...v.ask, receipts: v.receipts, deliveries: v.deliveries } : a));
  } catch (err) {
    page.message = err.message;
  }
  redraw(id, focus);
}

/** An ask's element on the page: the ask page's block, or its card on a review. */
const blockOf = (ask) => $(`[data-ask="${CSS.escape(ask.id)}"]`);

/**
 * Opens the Other box right below the Other button `b`, in place, so nothing else on the page
 * redraws or moves, and focuses it without scrolling. A box open on another question closes.
 */
function openOther(ask, b) {
  closeOther(ask, false);
  const q = askOf(ask.id).questions.find((x) => x.id === b.dataset.q);
  uiOf(ask.id).other = q.id;
  b.setAttribute("aria-expanded", "true");
  b.insertAdjacentHTML("afterend", otherFormHtml(ask, q));
  b.nextElementSibling.querySelector("input").focus({ preventScroll: true });
}

/** Closes the ask's open Other box in place, and puts focus back on its Other button unless `refocus` is false. */
function closeOther(ask, refocus = true) {
  const q = uiOf(ask.id).other;
  if (!q) return;
  uiOf(ask.id).other = null;
  const b = blockOf(ask)?.querySelector(`[data-q="${CSS.escape(q)}"][data-other]`);
  if (b?.nextElementSibling?.matches(".ask-other")) b.nextElementSibling.remove();
  b?.setAttribute("aria-expanded", "false");
  if (refocus) b?.focus({ preventScroll: true });
}

/** Draws the page an ask is on, and puts focus on `focus` inside that ask. */
function redraw(id, focus) {
  if (state.view.ask?.id === id) return renderAsk(focus && `[data-ask="${CSS.escape(id)}"] ${focus}`);
  render();
  if (focus) $(`[data-ask="${CSS.escape(id)}"] ${focus}`)?.focus();
}

/** The note typed under a question, sent with its answer. */
const noteOf = (ask, q) => notes[`note-${pre(ask)}${q}`]?.trim() || undefined;

app.addEventListener("input", (e) => {
  if (e.target.closest?.(".ask-note")) notes[e.target.id] = e.target.value;
});

app.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  const ask = askOf(b?.closest("[data-ask]")?.dataset.ask);
  if (!b || !ask) return;
  if (b.hasAttribute("data-other-cancel")) return closeOther(ask);
  if (b.classList.contains("go-rec")) return send(ask.id, { recommended: true }, ".ask-q .ask-opt");
  const q = b.dataset.q;
  if (!q) return;
  const page = uiOf(ask.id);
  if (b.hasAttribute("data-other")) return page.other === q ? closeOther(ask) : openOther(ask, b);
  if (b.dataset.choice)
    send(ask.id, { question: q, choice: b.dataset.choice, note: noteOf(ask, q) }, `[data-q="${CSS.escape(q)}"][data-choice="${CSS.escape(b.dataset.choice)}"]`);
});

app.addEventListener("submit", (e) => {
  const form = e.target.closest(".ask-other");
  const ask = askOf(form?.closest("[data-ask]")?.dataset.ask);
  if (!form || !ask) return;
  e.preventDefault();
  const q = form.dataset.q;
  const text = form.querySelector("input").value.trim();
  if (text) send(ask.id, { question: q, choice: "other", text, note: noteOf(ask, q) }, `[data-q="${CSS.escape(q)}"][data-other]`);
});

// 1 to 4 pick the focused question's option, unless focus is in a text box.
app.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || !/^[1-4]$/.test(e.key)) return;
  if (e.target.closest("input, textarea") || !e.target.closest("[data-ask]")) return;
  const q = e.target.closest(".ask-q");
  const b = q?.querySelectorAll(".ask-opt[data-choice]")[Number(e.key) - 1];
  if (!b || b.disabled) return;
  e.preventDefault();
  b.click();
});

// Escape closes the Other box.
app.addEventListener("keydown", (e) => {
  const form = e.key === "Escape" && e.target.closest?.(".ask-other");
  const ask = form && askOf(form.closest("[data-ask]")?.dataset.ask);
  if (ask) closeOther(ask);
});
