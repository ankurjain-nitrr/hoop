// A quick question's page: each question's options as buttons, answered with one click and sent at
// once, with no review to submit. 1 to 4 answer the focused question; Enter in Other sends it.
import { $, agentHtml, byline, esc, frame, post, readAt, receiptHtml, state } from "/app.js";
import { statusBadge } from "/status.js";

const app = $("#app");
const page = { other: null, message: "" };

const open = () => state.view.ask.state !== "withdrawn";
const latest = (q) => q.answers.at(-1);

/** An answer as people read it: the option's letter and label, or the person's own words. */
function said(q, a) {
  if (a.choice === "other") return `Other: “${a.text ?? ""}”`;
  const o = q.options.find((c) => c.id === a.choice);
  return `${a.choice}. ${o?.label ?? ""}`;
}

/** The answer a question has: what, who and when, how it was taken, and whether Claude read it. */
function answerHtml(q) {
  const a = latest(q);
  if (!a) return `<p class="ask-answer none">Not answered yet.</p>`;
  const prev = a.corrects ? ` (changed from ${esc(said(q, a.corrects))})` : "";
  const how = a.recommended ? " · taken with Go with your recommendation" : "";
  return `<p class="ask-answer"><b>Answer:</b> ${esc(said(q, a))}${prev} · ${esc(a.by)}, ${esc(readAt(a.at))}${how} · ${receiptHtml(a.key)}</p>${a.note ? `<p class="ask-note-shown">Note: ${esc(a.note)}</p>` : ""}`;
}

/** Every earlier answer to a question, folded. */
function historyHtml(q) {
  const earlier = q.answers.slice(0, -1);
  if (!earlier.length) return "";
  const rows = earlier.map((a) => `<li>${esc(said(q, a))} · ${esc(a.by)}, ${esc(readAt(a.at))}</li>`).join("");
  return `<details class="ask-history"><summary>Earlier answers (${earlier.length})</summary><ul>${rows}</ul></details>`;
}

function questionHtml(q, n) {
  const a = latest(q);
  const off = open() ? "" : "disabled";
  const id = esc(q.id);
  const options = q.options
    .map(
      (o, i) =>
        `<button type="button" class="btn ask-opt" data-q="${id}" data-choice="${esc(o.id)}" aria-pressed="${a?.choice === o.id}" aria-keyshortcuts="${i + 1}" ${off}><span class="key mono" aria-hidden="true">${i + 1}</span> ${esc(o.id)}. ${esc(o.label)}${o.recommended ? ' <span class="rec">recommended</span>' : ""}</button>`,
    )
    .join("");
  const other = `<button type="button" class="btn ask-opt" data-q="${id}" data-other aria-pressed="${a?.choice === "other"}" aria-expanded="${page.other === q.id}" ${off}>Other</button>`;
  const otherForm =
    page.other === q.id && open()
      ? `<form class="ask-other" data-q="${id}"><label for="other-${id}">Your answer</label><input id="other-${id}" name="text" autocomplete="off" value="${a?.choice === "other" ? esc(a.text ?? "") : ""}" required><button type="submit" class="btn small primary">Send</button></form>`
      : "";
  const note = open()
    ? `<div class="ask-note"><label for="note-${id}">Note (optional, sent with your answer)</label><textarea id="note-${id}" rows="2"></textarea></div>`
    : "";
  return `<section class="ask-q" data-q="${id}" aria-labelledby="qt-${id}">
    <h2 id="qt-${id}">${state.view.ask.questions.length > 1 ? `<span class="qn">${n + 1}.</span> ` : ""}${esc(q.question)}</h2>
    ${q.context ? `<p class="ask-context">${esc(q.context)}</p>` : ""}
    <div class="ask-opts" role="group" aria-labelledby="qt-${id}">${options}${other}</div>
    ${otherForm}${note}${answerHtml(q)}${historyHtml(q)}
  </section>`;
}

/** Draws the page from `state.view`, keeping focus on the control that had it. */
export function renderAsk(focus, sent) {
  // Notes typed under other questions survive the redraw; the one just sent is cleared.
  const notes = Object.fromEntries([...document.querySelectorAll(".ask-note textarea")].map((t) => [t.id, t.value]));
  if (sent) delete notes[`note-${sent}`];
  const v = state.view;
  const { ask } = v;
  const n = ask.questions.length;
  document.title = `${v.meta.title} · hoop`;
  const unanswered = ask.questions.filter((q) => !q.answers.length).length;
  const withdrawn = ask.withdrawn
    ? `<section class="decided" role="status"><p>Claude withdrew ${n > 1 ? "these questions" : "this question"}: ${esc(ask.withdrawn.reason)}</p></section>`
    : "";
  const go =
    open() && unanswered
      ? `<div class="ask-actions"><button type="button" class="btn" id="goRec">Go with your recommendation</button><span class="ask-hint">Answers ${unanswered === n ? (n > 1 ? "every question" : "the question") : `the ${unanswered} unanswered`} with Claude's recommended option.</span></div>`
      : "";
  app.innerHTML = frame(
    "",
    `<header class="top">
      <div class="title-row"><h1>${n > 1 ? `${n} quick questions` : "A quick question"} from Claude</h1></div>
      <div class="sub">${statusBadge(v.status_key)}${byline(v)}</div>
      ${agentHtml(v.agent)}
    </header>
    <main class="ask">${withdrawn}${ask.questions.map(questionHtml).join("")}${go}<p class="ask-status" role="status" aria-live="polite">${esc(page.message)}</p></main>`,
    state.info,
  );
  for (const [id, value] of Object.entries(notes)) {
    const t = document.getElementById(id);
    if (t) t.value = value;
  }
  if (focus) $(focus)?.focus();
}

/** What a sent answer did, from how it reached Claude's session. */
const DELIVERED = {
  sent: "Sent to Claude's session.",
  waiting: "Claude is waiting and has it.",
  no_session: "Saved. No live Claude session took it; it reads it when it resumes.",
  failed: "Saved, but Claude's session couldn't be reached.",
};

async function send(body, focus) {
  let sent;
  try {
    const v = await post(`/api/reviews/${state.view.meta.id}/answer`, body);
    page.message = v.delivery ? DELIVERED[v.delivery.outcome] : "Saved.";
    page.other = null;
    state.view = v;
    sent = body.question;
  } catch (err) {
    page.message = err.message;
  }
  renderAsk(focus, sent);
}

/** The note typed under a question, sent with its answer. */
const noteOf = (q) => $(`#note-${CSS.escape(q)}`)?.value.trim() || undefined;

app.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || !state.view?.ask) return;
  if (b.id === "goRec") return send({ recommended: true }, ".ask-q .ask-opt");
  const q = b.dataset.q;
  if (!q) return;
  if (b.hasAttribute("data-other")) {
    page.other = page.other === q ? null : q;
    renderAsk(page.other ? `#other-${CSS.escape(q)}` : `[data-q="${CSS.escape(q)}"][data-other]`);
    return;
  }
  if (b.dataset.choice)
    send({ question: q, choice: b.dataset.choice, note: noteOf(q) }, `[data-q="${CSS.escape(q)}"][data-choice="${CSS.escape(b.dataset.choice)}"]`);
});

app.addEventListener("submit", (e) => {
  const form = e.target.closest(".ask-other");
  if (!form) return;
  e.preventDefault();
  const q = form.dataset.q;
  const text = form.querySelector("input").value.trim();
  if (text) send({ question: q, choice: "other", text, note: noteOf(q) }, `[data-q="${CSS.escape(q)}"][data-other]`);
});

// 1 to 4 pick the focused question's option, unless focus is in a text box.
app.addEventListener("keydown", (e) => {
  if (!state.view?.ask || e.ctrlKey || e.metaKey || e.altKey || !/^[1-4]$/.test(e.key)) return;
  if (e.target.closest("input, textarea")) return;
  const q = e.target.closest(".ask-q");
  const b = q?.querySelectorAll(".ask-opt[data-choice]")[Number(e.key) - 1];
  if (!b || b.disabled) return;
  e.preventDefault();
  b.click();
});

// Escape closes the Other box.
app.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !e.target.closest?.(".ask-other")) return;
  const q = page.other;
  page.other = null;
  renderAsk(`[data-q="${CSS.escape(q)}"][data-other]`);
});
