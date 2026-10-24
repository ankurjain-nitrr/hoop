// hoop review page. Renders a review from /api/reviews/:id; review.js adds commenting through `hooks`.
import { esc } from "/esc.js";
import { PR, READ, REVIEW, statusBadge } from "/status.js";
import { foldAllHtml, foldBody, foldButton, foldClick, foldSummary, tally } from "/fold.js";
import { frame } from "/frame.js";
import { notifyHtml, watchPending } from "/pending.js";
import { icons } from "/icons.js";
import { renderLine, renderTableRow } from "/inline.js";
import { rowCells, TABLE_DELIM } from "/blocks.js";
import { depthOf, onOutlineChange, outlineHtml } from "/outline.js";
import { diagramHtml, isDiagram, mountDiagrams } from "/diagram.js";
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");

export const state = {
  view: null,
  tab: "proposal",
  viewed: {},
  canReview: false,
  info: undefined,
  open: {},
  openThreads: {},
  commentsHidden: false,
};
export const hooks = { item: [], line: [], top: [], after: [], before: [], rendered: [], loaded: [] }; // extension points for review features
onOutlineChange(() => state.view && render());
hooks.rendered.push(() => mountDiagrams(app));

function storageKey() {
  return `hoop:${state.view.meta.id}:${state.view.meta.revisions}`;
}
export function saveDraft() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({ ...loadDraft(), viewed: state.viewed }));
  } catch {}
}
export function loadDraft() {
  try {
    return JSON.parse(localStorage.getItem(storageKey()) || "{}");
  } catch {
    return {};
  }
}

/** Calls the local API and returns the parsed reply; errors carry the reply's body. */
async function api(path, init = {}) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body });
  return body;
}
/** Sends a JSON POST to the local API and returns the parsed reply; errors carry the reply's body. */
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export { api, esc, frame, post, $ };

/**
 * Text at a page anchor (0-based index; line = index + 1): index -1 is an item's heading, and item
 * "DOC" index 0 is the title, 1 the TL;DR. `rev` reads an earlier revision from history.
 */
export function textAt(itemId, idx, rev) {
  const v = state.view;
  if (rev && rev !== v.meta.revisions) {
    const h = v.history?.[rev];
    return itemId === "DOC" ? h?.DOC?.[idx] : idx === -1 ? h?.[`#${itemId}`] : h?.[itemId]?.[idx];
  }
  if (itemId === "DOC") return [v.doc.title, v.doc.tldr][idx];
  const item = v.doc.items.find((i) => i.id === itemId);
  return idx === -1 ? item?.title : item?.lines[idx];
}

/** Titles, headings and the TL;DR format their inline text as prose. */
export const PROSE = { kind: "paragraph", indent: 0 };

/** A commentable piece of text: selection anchors, highlight hooks, and the + button before it. */
function commentable(item, idx, text, tag = "span") {
  const gutter = hooks.line.map((h) => h(item, idx, "gutter")).join("");
  return `${gutter ? `<span class="inline-gutter">${gutter}</span>` : ""}<${tag} class="anchor" data-sel-item="${esc(item.id)}" data-sel-line="${idx}">${renderLine(text ?? "", decorations(item, idx), PROSE)}</${tag}>`;
}
const below = (item, idx) => hooks.line.map((h) => h(item, idx, "below") || "").join("");

function changedIds(view) {
  if (!view.previous) return new Set();
  const before = new Map(view.previous.items.map((i) => [i.id, JSON.stringify(i.lines) + i.title]));
  return new Set(view.doc.items.filter((i) => before.get(i.id) !== JSON.stringify(i.lines) + i.title).map((i) => i.id));
}

/** The review that replaced this one, when there is one. */
function decidedNote(meta) {
  if (!meta.superseded_by) return "";
  return `<section class="decided" role="status"><p>A newer review replaced this one: <a href="/r/${encodeURIComponent(meta.superseded_by)}">${esc(meta.superseded_by)}</a>.</p></section>`;
}

/** Where a review was written, as people read it: the folder's name, and its git repository's when that differs. */
const placeText = (place) => (place?.folder ? (place.repo ? `${place.folder} in ${place.repo}` : place.folder) : "");

/** The review page's small "by <session> · <place>" line, or "Opened by <person> · <place>" for a file a person opened. */
export function byline(view) {
  const who = view.session?.label ?? view.meta.owner;
  const by = who ? `by ${esc(who)}` : view.meta.opened_by ? `Opened by ${esc(view.meta.opened_by)}` : "";
  const where = placeText(view.place);
  if (!by && !where) return "";
  const title = who ? "The Claude Code session that submitted this review, and the folder it worked in" : "Who opened this file for review, and its folder";
  return `<span class="owner" title="${title}">${by}${by && where ? " · " : ""}${where ? `<span class="mono">${esc(where)}</span>` : ""}</span>`;
}

/** The title and TL;DR as a pseudo item for comment hooks. */
/** Markdown documents hide their section IDs; structured reviews keep them. */
export const isDoc = () => state.view?.doc.kind === "doc";

/** The latest submitted review's receipt key, `<revision>.<index>`, or undefined before any review. */
function latestReview() {
  const all = state.view.feedback ?? [];
  const last = all.at(-1);
  return last && `${last.revision}.${all.filter((f) => f.revision === last.revision).length - 1}`;
}

/** Local time of a receipt: the time alone today, else the date and time. */
export const readAt = (iso) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};

/** Why a review from the page isn't read yet, from how it reached the session: after "Not read yet". */
const DELIVERY = {
  sent: (d) => `; sent to Claude's session at ${readAt(d.at)}`,
  no_session: () => "; no live Claude session took it",
  failed: () => "; couldn't reach Claude's session",
};

/**
 * Whether and when the agent read a submitted review: "Claude read this at 21:04", or "Not read yet",
 * with how the review reached the session when the page sent it there.
 */
export function receiptText(key) {
  const r = state.view?.receipts?.[key];
  if (r) return `${r.by === "agent" ? "Claude" : r.by} read this at ${readAt(r.at)}`;
  const d = state.view?.deliveries?.[key];
  return `Not read yet${d && DELIVERY[d.outcome] ? DELIVERY[d.outcome](d) : ""}`;
}

/** The command that resumes a Claude Code session. */
const resumeCommand = (session) => `claude --resume ${session}`;

/** What the agent that owns the review is doing, in words for the reviewer. */
export function agentText(a) {
  // A quick question is answered, not reviewed, and each answer is sent at once.
  const ask = Boolean(state.view?.ask);
  const told = ask ? "after you answer, ask it in the session to read your answers" : "after you submit, ask it in the session to read your review";
  switch (a?.state) {
    case "waiting":
      return ask ? "Claude is waiting for your answer" : "Claude is waiting for your review";
    case "idle":
      return a.wakes ? `Claude's session is idle; ${ask ? "answering" : "submitting"} wakes it` : `Claude's session is idle and takes no messages; ${told}`;
    case "busy":
      return a.wakes
        ? `Claude is working on something else; ${ask ? "answering sends it your answer" : "submitting sends it your review"}`
        : `Claude is working and takes no messages; ${told}`;
    case "ended":
      return "Claude's session has ended. Resume it with";
    default:
      return "";
  }
}

/** The inside of the header's agent line: its words, and for an ended session the command to resume it with a Copy button. */
function agentInner(a) {
  if (!a) return "";
  const cmd = a.state === "ended" ? resumeCommand(a.session) : "";
  return `<span>${esc(agentText(a))}</span>${cmd ? ` <code class="resume">${esc(cmd)}</code><button type="button" class="btn small" data-copy="${esc(cmd)}" aria-label="Copy the command ${esc(cmd)}">Copy</button>` : ""}`;
}

/** The header's line on the agent's state. It stays in the page, so a change is read out. */
export const agentHtml = (a) => `<div class="agent-state" data-agent="${esc(a?.state ?? "")}" aria-live="polite" ${a ? "" : "hidden"}>${agentInner(a)}</div>`;

/** A receipt that the receipts poll keeps current without rendering the page again. */
export const receiptHtml = (key) => `<span class="receipt" data-receipt="${esc(key)}">${esc(receiptText(key))}</span>`;

/** The header's notice that Claude submitted a newer revision. It stays in the page, so its arrival is read out. */
function newRevisionInner() {
  const n = state.newRevision;
  return n ? `<span>Revision ${n} is ready</span><button type="button" class="btn small primary" id="showRevision">Show it</button>` : "";
}
const newRevisionHtml = () => `<div class="new-revision" role="status" ${state.newRevision ? "" : "hidden"}>${newRevisionInner()}</div>`;

/** Shows that a newer revision is ready, in place, so nothing the reviewer is writing moves. */
function noticeRevision(n) {
  if (!n || n <= state.view.meta.revisions || n === state.newRevision) return;
  state.newRevision = n;
  const el = $(".new-revision");
  if (!el) return;
  el.innerHTML = newRevisionInner();
  el.hidden = false;
}

const docItem = () => ({ id: "DOC", title: "Document", lines: [state.view.doc.title, state.view.doc.tldr] });

export function render() {
  const { meta, doc } = state.view;
  const changed = changedIds(state.view);
  const items = state.tab === "changes" ? doc.items.filter((i) => changed.has(i.id)) : doc.items;
  const viewedCount = doc.items.filter((i) => state.viewed[i.id]).length;
  app.innerHTML = frame(
    "",
    `
    <header class="top">
      <div class="title-row"><h1 class="commentable">${commentable(docItem(), 0, doc.title)}</h1><div class="actions">${hooks.top.map((h) => h()).join("")}</div></div>
      <div class="sub">
        <span class="rev">rev ${meta.revisions}</span>${statusBadge(state.view.status_key)}${byline(state.view)}${latestReview() ? `<span class="latest-receipt">Latest review: ${receiptHtml(latestReview())}</span>` : ""}
        <span>${doc.context?.repo ? `<span class="mono">${esc(doc.context.repo)}</span>` : ""} ${doc.context?.branch ? `· <span class="mono">${esc(doc.context.branch)}</span>` : ""}</span>
      </div>
      ${agentHtml(state.view.agent)}
      ${newRevisionHtml()}
      ${
        meta.revisions > 1
          ? `<div class="tabs" role="tablist">
        <button class="tab" role="tab" id="tab-proposal" aria-selected="${state.tab === "proposal"}">Proposal</button>
        <button class="tab" role="tab" id="tab-changes" aria-selected="${state.tab === "changes"}">Changes since rev ${meta.revisions - 1} (${changed.size})</button>
      </div>`
          : ""
      }
    </header>
    <div class="layout">
      <nav class="outline" aria-label="Items">
        <div class="progress">${viewedCount} of ${doc.items.length} viewed</div>
        ${outlineHtml(
          doc.items,
          (i) =>
            `<a href="#item-${esc(i.id)}"><span class="dot ${state.viewed[i.id] ? "viewed" : ""}"></span><span>${isDoc() ? "" : `${esc(i.id)} `}${esc(i.title)}</span><span class="badge">${hooks.item.map((h) => h(i, "badge")).join("")}</span></a>`,
        )}
      </nav>
      <main>
        ${/* An automatic TL;DR repeats the first paragraph, so it shows only where that may be filtered out. */ ""}
        ${decidedNote(meta)}
        ${hooks.before.map((h) => h()).join("")}
        ${doc.tldr_auto && state.tab !== "changes" ? "" : `<div class="tldr commentable"><b>TL;DR</b>${commentable(docItem(), 1, doc.tldr)}</div>`}
        ${below(docItem(), 0)}${below(docItem(), 1)}
        <div class="items">${items.map((i) => renderItem(i, changed.has(i.id))).join("") || '<p class="empty">No changes in this revision.</p>'}</div>
        ${hooks.after.map((h) => h()).join("")}
      </main>
    </div>`,
    state.info,
  );
  // The hidden mode lives in the view state, so every render keeps it.
  app.classList.toggle("comments-hidden", Boolean(state.commentsHidden));
  hooks.rendered.forEach((h) => h());
}

/** Highlights and tracked changes on a line, as source ranges from the review hooks. */
const decorations = (item, i) => hooks.line.flatMap((h) => h(item, i, "decorations") || []);

/**
 * Lines `from` to `end` of an item as one table. Each row is still its own commentable line, with
 * its gutter and number; the first row is the header and the delimiter row shows as a thin row.
 */
function tableHtml(item, from, end) {
  const delim = item.lines.findIndex((t, n) => n > from && n < end && TABLE_DELIM.test(t));
  const align =
    delim < 0 ? [] : rowCells(item.lines[delim]).map((c) => (c.text.startsWith(":") && c.text.endsWith(":") ? "center" : c.text.endsWith(":") ? "right" : ""));
  const width = Math.max(...item.lines.slice(from, end).map((t) => rowCells(t).length));
  let rows = "";
  for (let n = from; n < end; n++) {
    const t = item.lines[n];
    const gutter = `<td class="gutter">${hooks.line.map((h) => h(item, n, "gutter")).join("")}${n + 1}</td>`;
    const endHook = `<td class="tend">${hooks.line.map((h) => h(item, n, "end") || "").join("")}</td>`;
    const after = hooks.line.map((h) => h(item, n, "below") || "").join("");
    const cells = n === delim ? null : renderTableRow(t, decorations(item, n));
    const tag = n < delim || delim < 0 ? (n === from ? "th" : "td") : "td";
    let inner;
    if (n === delim)
      inner = `<td class="tdelim" colspan="${width}"><span data-sel-item="${esc(item.id)}" data-sel-line="${n}" class="text">${renderLine(t, decorations(item, n))}</span></td>`;
    else if (!cells) inner = `<td colspan="${width}">${renderLine(t, decorations(item, n))}</td>`;
    else
      inner = Array.from({ length: width }, (_, k) =>
        k < cells.length ? `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${cells[k]}</${tag}>` : `<${tag}></${tag}>`,
      ).join("");
    const host = n === delim ? "" : ` data-sel-item="${esc(item.id)}" data-sel-line="${n}"`;
    rows += `<tr class="tline${n === delim ? " tdelim-row" : ""}"${host}>${gutter}${inner}${endHook}</tr>`;
    if (after) rows += `<tr class="tafter"><td colspan="${width + 2}">${after}</td></tr>`;
  }
  return `<div class="md-table-wrap"><table class="md-table"><tbody>${rows}</tbody></table></div>`;
}

// A markdown question's options are its top-level list items, in order, as the parser reads them.
const OPTION = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/;

/** A radio button for one answer to a question. */
function radioHtml(item, value, label) {
  const off = state.canReview && state.view.meta.status !== "approved" ? "" : "disabled";
  const id = esc(item.id);
  return `<input type="radio" name="q-${id}" id="q-${id}-${esc(value)}" value="${esc(value)}" data-q="${id}" aria-label="${esc(label)}" ${off}>`;
}

/** Each option line's choice in a markdown question, by line index. */
function optionLines(item) {
  const at = new Map();
  let k = 0;
  item.lines.forEach((t, i) => {
    if (item.choices?.[k] && OPTION.test(t)) at.set(i, item.choices[k++]);
  });
  return at;
}

/**
 * A question's answers. A structured question lists its options here; a markdown question's options
 * carry their own radio buttons on their lines, so only Other follows them. Other is answered in a
 * comment on the question.
 */
function answerHtml(item, withOptions) {
  const radio = (value, label, shown) => `<label>${radioHtml(item, value, label)} ${shown}</label>`;
  const options = withOptions
    ? (item.choices || [])
        .map((c) =>
          radio(c.id, `${c.id}) ${c.label}`, `<span>${esc(c.id)}) ${esc(c.label)}</span> ${c.recommended ? '<span class="rec">recommended</span>' : ""}`),
        )
        .join("")
    : "";
  return `<div class="qopts">${options}${radio("other", "Other: answer in a comment", "<span>Other: answer in a comment</span>")}</div>${takenNote(item)}`;
}

/** Says when an approval took this question's recommended option because nobody picked one. */
function takenNote(item) {
  const rev = state.view.meta.revisions;
  const taken = (state.view.feedback ?? []).some((fb) => fb.revision === rev && fb.answers.some((a) => a.item === item.id && a.recommended));
  return taken ? '<p class="taken">Approved without an answer here, so the recommended option was taken.</p>' : "";
}

function renderItem(item, changed) {
  const prev = state.view.previous?.items.find((p) => p.id === item.id);
  const diff = state.tab === "changes" && changed;
  let body;
  if (item.type === "question") {
    body = `<div class="qbox" role="radiogroup" aria-label="${esc(item.title)}">${answerHtml(item, true)}</div>`;
  } else {
    const options = !diff && item.choices?.length ? optionLines(item) : new Map();
    const removed = diff && prev ? prev.lines.filter((l) => !item.lines.includes(l)) : [];
    // The Changes tab shows lines as written, so a change to markup alone stays visible.
    const prevBlock = (t) => prev?.blocks?.[prev.lines.indexOf(t)];
    const line = (t, i) => {
      const cls = diff && !prev?.lines.includes(t) ? "add" : "";
      const choice = options.get(i);
      const pick = choice ? `<span class="qpick">${radioHtml(item, choice.id, `${choice.id}) ${choice.label}`)}</span>` : "";
      return `<div class="line ${cls}${choice ? " option" : ""}"><div class="gutter">${hooks.line.map((h) => h(item, i, "gutter")).join("")}${i + 1}</div><div class="text" data-sel-item="${esc(item.id)}" data-sel-line="${i}">${pick}${!diff && isDiagram(t) ? diagramHtml(t) : renderLine(t, decorations(item, i), diff ? undefined : item.blocks?.[i])}</div>${diff ? "" : hooks.line.map((h) => h(item, i, "end") || "").join("")}</div>${hooks.line.map((h) => h(item, i, "below") || "").join("")}`;
    };
    let lines = "";
    for (let i = 0; i < item.lines.length; ) {
      // A run of table lines shows as one table; the Changes tab shows lines as written.
      let end = i;
      while (!diff && item.blocks?.[end]?.kind === "table") end++;
      if (end - i >= 2) {
        lines += tableHtml(item, i, end);
        i = end;
      } else lines += line(item.lines[i], i++);
    }
    const lineHtml = `<div class="lines">${removed.map((t) => `<div class="line del"><div class="gutter">−</div><div class="text">${renderLine(t, [], diff ? undefined : prevBlock(t))}</div></div>`).join("")}${lines}</div>`;
    body = options.size ? `<div class="qbox" role="radiogroup" aria-label="${esc(item.title)}">${lineHtml}${answerHtml(item, false)}</div>` : lineHtml;
  }
  // A viewed item stays collapsed unless the reviewer jumped to one of its lines.
  // A nested section sits inside its parent, indented by its depth under the title.
  const renamed = state.view.renamed?.[item.id];
  return `<article class="item ${state.viewed[item.id] && !state.open[item.id] ? "collapsed" : ""}" id="item-${esc(item.id)}" style="--depth:${depthOf(item) - 1}">
    <div class="item-head commentable">${isDoc() ? "" : `<span class="id">${esc(item.id)}</span>`}<span class="t">${commentable(item, -1, item.title)}</span>${renamed ? `<span class="renamed">renamed from “${esc(renamed)}”</span>` : ""}
      ${item.risk ? `<span class="risk ${item.risk}">risk: ${item.risk}</span>` : ""}${changed ? '<span class="chg">changed</span>' : ""}
      <label><input type="checkbox" id="viewed-${esc(item.id)}" data-viewed="${esc(item.id)}" ${state.viewed[item.id] ? "checked" : ""}> Viewed</label></div>${below(item, -1)}${body}</article>`;
}

// Home's sections: every review that isn't approved is pending; approved and superseded ones are completed.
const SECTIONS = [
  ["pending", "Pending"],
  ["completed", "Completed"],
];
const sectionOf = (m) =>
  m.status_key === "approved" || m.status_key === "answered" || m.status_key === "withdrawn" || m.superseded_by ? "completed" : "pending";
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** A pull request's state badges: merged or closed, else its checks, conflicts, a review asked of you and readiness. */
function prBadges(p) {
  if (p.state !== "open") return [p.state === "merged" || p.state === "closed" ? p.state : "unknown"];
  return [
    p.checks && p.checks !== "none" ? `checks_${p.checks}` : "",
    p.conflicts ? "conflicts" : "",
    p.review_requested ? "review_requested" : "",
    p.ready ? "ready" : "",
  ].filter(Boolean);
}
const prBadgesHtml = (p) =>
  prBadges(p)
    .map((k) => statusBadge(k, PR))
    .join("");
const prSection = (p) => (p.state === "merged" || p.state === "closed" ? "completed" : "pending");

/** A Home group's key: the owning session's ID, `opened:<person>` for files a person opened, or "" for neither. */
const groupKey = (m) => m.session?.id ?? (m.opened_by ? `opened:${m.opened_by}` : "");

/**
 * Reviews grouped by the Claude Code session that owns them, or the person who opened them from a
 * file, in the order of each group's newest review. Reviews without either come last, in a group of their own.
 */
function bySession(rows) {
  const groups = new Map();
  for (const m of rows) {
    const key = groupKey(m);
    if (!groups.has(key)) groups.set(key, { key, session: m.session, opened_by: m.session ? undefined : m.opened_by, rows: [] });
    groups.get(key).rows.push(m);
  }
  const none = groups.get("");
  groups.delete("");
  return [...groups.values(), ...(none ? [none] : [])];
}

/** Home's state: the reviews and tracked pull requests it shows, and the session being renamed (`section:session`). */
const home = { shown: false, list: [], prs: [], renaming: null, error: "", focus: null };

/** What a folded session's reviews are, as "2 awaiting review · 1 approved". */
const reviewTally = (rows) => [...tally(rows, REVIEW, (m) => !m.superseded_by && m.status_key), [rows.filter((m) => m.superseded_by).length, "replaced"]];

/**
 * A session's heading on Home: a disclosure button with its name, a pencil to rename it, short ID,
 * the folder it worked in, and whether it runs. `fold` is the key and body ID its button folds.
 */
function sessionHead(section, s, place, n, fold, summary, openedBy) {
  const id = `s-${section}-${n}`;
  const toggle = (name) => foldButton(fold.key, fold.body, esc(name), "session");
  if (!s) return `<div class="session-head"><h3 id="${id}">${toggle(openedBy ? `Opened by ${openedBy}` : "No session")}</h3>${summary}</div>`;
  const key = `${section}:${s.id}`;
  const name = s.name ?? "Unnamed session";
  const where = placeText(place);
  const details = `<span class="sid mono" title="Session ID">${esc(s.id.slice(0, 8))}</span>${where ? `<span class="place mono" title="The folder the session worked in">${esc(where)}</span>` : ""}${s.live ? '<span class="live" title="This session is running">live</span>' : ""}`;
  if (home.renaming !== key)
    return `<div class="session-head"><h3 id="${id}">${toggle(name)}</h3><button type="button" class="rename-btn" data-rename="${esc(key)}" aria-label="Rename ${esc(name)}" title="Rename">${icons.edit}</button>${summary}${details}</div>`;
  return `<div class="session-head"><h3 id="${id}" class="visually-hidden">${esc(name)}</h3><form class="rename" data-rename-form="${esc(key)}"><label for="${id}-name">Session name</label><input id="${id}-name" name="name" maxlength="100" autocomplete="off" value="${esc(s.name ?? "")}" aria-describedby="${id}-err"><button type="submit" class="btn small primary">Save</button><button type="button" class="btn small" data-rename-cancel>Cancel</button><p id="${id}-err" class="rename-error" role="alert">${esc(home.error)}</p></form>${details}</div>`;
}

function listHtml() {
  const { list, prs } = home;
  // A quick question shows how many of its questions wait for an answer in place of its revision.
  const count = (m) =>
    m.ask
      ? m.ask.unanswered
        ? `<span class="rev">${m.ask.unanswered} of ${m.ask.questions} unanswered</span>`
        : ""
      : `<span class="rev">rev ${m.revisions}</span>`;
  const row = (m) =>
    `<a class="row" href="/r/${esc(m.id)}"><span class="t">${esc(m.title)}</span>${count(m)}${statusBadge(m.status_key)}${m.unread ? statusBadge("unread", READ) : ""}${m.summary && m.summary !== m.title ? `<span class="s" title="${esc(m.summary)}">${esc(m.summary)}</span>` : ""}<span class="m">updated ${esc(when(m.updated))}</span></a>`;
  const prRow = (p) =>
    `<a class="row pr" href="${esc(p.url)}"><span class="t">${esc(p.title || `${p.repo}#${p.number}`)}</span><span class="rev">${esc(p.repo)}#${p.number}</span>${prBadgesHtml(p)}${p.summary ? `<span class="s" title="${esc(p.summary)}">${esc(p.summary)}</span>` : ""}<span class="m">pull request opened by ${esc(p.owner)}</span></a>`;
  if (!list.length && !prs.length)
    return '<p class="empty">No reviews yet. Reviews appear here when Claude submits one with hoop_submit, or when you run hoop open on a markdown file.</p>';
  // The server lists reviews newest first, so each section and each session keeps that order;
  // pull requests follow the sessions, newest first.
  return SECTIONS.map(([key, label]) => {
    const rows = list.filter((m) => sectionOf(m) === key);
    const prRows = prs.filter((p) => prSection(p) === key).map(prRow);
    if (!rows.length && !prRows.length) return "";
    // Each section, session and pull request group folds; the folded state is kept by section and session ID.
    const pf = `home:${key}:prs`;
    const pulls = prRows.length
      ? `<section class="session" aria-labelledby="p-${esc(key)}"><div class="session-head"><h3 id="p-${esc(key)}">${foldButton(pf, `p-${key}-body`, "Pull requests", "session")}</h3>${foldSummary(pf, [[prRows.length, "pull request", "pull requests"]])}</div><div ${foldBody(pf, `p-${key}-body`)}>${prRows.join("")}</div></section>`
      : "";
    const sessions = bySession(rows)
      .map((g, n) => {
        const fold = { key: `home:${key}:${g.key || "none"}`, body: `s-${key}-${n}-body` };
        const head = sessionHead(key, g.session, g.rows[0].place, n, fold, foldSummary(fold.key, reviewTally(g.rows)), g.opened_by);
        return `<section class="session" aria-labelledby="s-${esc(key)}-${n}">${head}<div ${foldBody(fold.key, fold.body)}>${g.rows.map(row).join("")}</div></section>`;
      })
      .join("");
    const gf = `home:${key}`;
    return `<section class="group" aria-labelledby="g-${esc(key)}"><h2 id="g-${esc(key)}">${foldButton(gf, `g-${key}-body`, `${esc(label)} <span class="count">${rows.length + prRows.length}</span>`)}</h2><div ${foldBody(gf, `g-${key}-body`)}>${sessions}${pulls}</div></section>`;
  }).join("");
}

function paintList() {
  document.title = "Home · hoop";
  app.innerHTML = frame(
    "home",
    `<div class="list"><header class="list-head"><h1>Home</h1>${notifyHtml()}${home.list.length || home.prs.length ? foldAllHtml() : ""}</header>${listHtml()}</div>`,
    state.info,
  );
  const focus = home.focus;
  home.focus = null;
  if (focus === "input") $(".rename input")?.focus();
  else if (focus?.startsWith("sel:")) $(focus.slice(4))?.focus();
  else if (focus?.startsWith("href:")) [...document.querySelectorAll(".list a")].find((a) => a.getAttribute("href") === focus.slice(5))?.focus();
  else if (focus) $(`[data-rename="${CSS.escape(focus)}"]`)?.focus();
}

async function renderList() {
  home.list = await api("/api/reviews");
  home.shown = true;
  paintList();
  // Pull request states come from gh, which may be slow, so they follow the reviews; Home asks again each minute while open.
  loadPrs();
  setInterval(loadPrs, window.HOOP_PRS_MS ?? 60_000);
}

async function loadPrs() {
  const list = await api("/api/prs").catch(() => undefined);
  if (!list) return;
  home.prs = list;
  repaintList();
}

/** Shows a newer list of reviews on Home, when it changed, and on a review's page a newer revision of it. */
function showReviews(list) {
  if (state.view && !state.view.build) noticeRevision(list.find((m) => m.id === state.view.meta.id)?.revisions);
  if (!home.shown || JSON.stringify(list) === JSON.stringify(home.list)) return;
  home.list = list;
  repaintList();
}

function repaintList() {
  // A refresh while a session is being renamed waits for the form to close, so it doesn't drop the typed name.
  if (home.renaming) return;
  // A refresh keeps focus on the same link or disclosure button.
  const active = document.activeElement;
  const href = active?.closest?.(".list a")?.getAttribute("href");
  if (href) home.focus = `href:${href}`;
  else if (active?.dataset?.collapse) home.focus = `sel:[data-collapse="${CSS.escape(active.dataset.collapse)}"]`;
  else if (active?.dataset?.collapseAll) home.focus = `sel:[data-collapse-all="${active.dataset.collapseAll}"]`;
  else if (active?.id === "notifyMe") home.focus = "sel:#notifyMe";
  else if (active?.dataset?.rename) home.focus = active.dataset.rename;
  paintList();
}

/** Closes the rename form and puts focus back on its Rename button. */
function closeRename() {
  home.focus = home.renaming;
  home.renaming = null;
  home.error = "";
  paintList();
}

async function saveRename(form) {
  const key = form.dataset.renameForm;
  const session = key.slice(key.indexOf(":") + 1);
  const input = form.querySelector("input");
  try {
    await post(`/api/sessions/${encodeURIComponent(session)}/name`, { name: input.value });
  } catch (err) {
    home.error = err.message;
    form.querySelector(".rename-error").textContent = err.message;
    input.setAttribute("aria-invalid", "true");
    input.focus();
    return;
  }
  home.list = await api("/api/reviews").catch(() => home.list);
  closeRename();
}

document.addEventListener("submit", (e) => {
  const form = e.target.closest?.("[data-rename-form]");
  if (!form) return;
  e.preventDefault();
  saveRename(form);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.closest?.("[data-rename-form]")) {
    e.preventDefault();
    closeRename();
  }
});

document.addEventListener("change", (e) => {
  const id = e.target.dataset?.viewed;
  // Toggling Viewed ends a jump's hold on the item, so it collapses again.
  if (id) {
    state.viewed[id] = e.target.checked;
    delete state.open[id];
    saveDraft();
    render();
  }
});
document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (t?.id === "tab-proposal" || t?.id === "tab-changes") {
    state.tab = t.id === "tab-changes" ? "changes" : "proposal";
    render();
  }
  if (t?.dataset.gotoItem) goToLine(t.dataset.gotoItem, Number(t.dataset.gotoLine));
  if (t?.dataset.rename) {
    home.renaming = t.dataset.rename;
    home.error = "";
    home.focus = "input";
    paintList();
  }
  if (t?.hasAttribute("data-rename-cancel")) closeRename();
  const fold = t && home.shown && foldClick(t, app);
  if (fold) {
    home.focus = `sel:${fold}`;
    paintList();
  }
  if (t?.dataset.copy) copy(t);
  if (t?.id === "showRevision") showRevision();
});

/** Moves to the newest revision; review.js carries the unsent drafts over as it loads. */
async function showRevision() {
  await load(state.view.meta.id);
  const lead = $(".stale-drafts h2") ?? $(".top h1");
  lead?.setAttribute("tabindex", "-1");
  lead?.focus();
}

/** Copies a button's command, and says so on the button for a moment. */
async function copy(button) {
  const done = await navigator.clipboard?.writeText(button.dataset.copy).then(
    () => true,
    () => false,
  );
  button.textContent = done ? "Copied" : "Select and copy it";
  setTimeout(() => (button.textContent = "Copy"), 2000);
}

/** Opens the item if it is collapsed, then scrolls to the line and marks it for a moment. */
function goToLine(itemId, line) {
  state.tab = "proposal";
  state.open[itemId] = true;
  const find = () => document.querySelector(`[data-sel-item="${CSS.escape(itemId)}"][data-sel-line="${line}"]`);
  render();
  const el = find();
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  const row = el.closest(".line") ?? el;
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1500);
}

/** Shows a review, or a build's page; true when it is a review. */
export async function load(id) {
  state.view = await api(`/api/reviews/${id}`);
  if (state.view.ask) {
    const { renderAsk } = await import("/ask.js");
    renderAsk();
    watchReceipts();
    watchAgent();
    return false;
  }
  if (state.view.build) {
    const { renderBuild } = await import("/build.js");
    renderBuild(state.view, state.info);
    return false;
  }
  state.viewed = loadDraft().viewed || {};
  if (state.newRevision <= state.view.meta.revisions) state.newRevision = undefined;
  hooks.loaded.forEach((h) => h());
  render();
  watchReceipts();
  watchAgent();
  return true;
}

let agentTimer;
/**
 * Asks every ten seconds, while the tab is visible and at once when it becomes visible again, what
 * the agent is doing, and updates the header's agent line when that changed.
 */
function watchAgent() {
  if (agentTimer) return;
  const ask = async () => {
    const v = state.view;
    if (!v || document.visibilityState !== "visible" || v.meta.status !== "open") return;
    const { agent } = await api(`/api/reviews/${v.meta.id}/agent`).catch(() => ({ agent: v.agent }));
    if (state.view !== v || JSON.stringify(agent ?? null) === JSON.stringify(v.agent ?? null)) return;
    v.agent = agent ?? undefined;
    const el = $(".agent-state");
    if (!el) return;
    el.dataset.agent = agent?.state ?? "";
    el.hidden = !agent;
    el.innerHTML = agentInner(agent);
  };
  agentTimer = setInterval(ask, window.HOOP_AGENT_MS ?? 10_000);
  document.addEventListener("visibilitychange", ask);
}

/** Puts the current receipts into every receipt on the page, leaving the rest of the page alone. */
function showReceipts() {
  for (const el of document.querySelectorAll("[data-receipt]")) el.textContent = receiptText(el.dataset.receipt);
}

let receiptsTimer;
/**
 * While a submitted review on the page is not read yet, asks for the receipts every ten seconds
 * when the tab is visible, and at once when it becomes visible again.
 */
function watchReceipts() {
  if (receiptsTimer) return;
  const ask = async () => {
    const v = state.view;
    const keys = [...document.querySelectorAll("[data-receipt]")].map((el) => el.dataset.receipt);
    if (!v || document.visibilityState !== "visible" || keys.every((k) => v.receipts?.[k])) return;
    const { receipts } = await api(`/api/reviews/${v.meta.id}/receipts`).catch(() => ({}));
    if (!receipts || state.view !== v) return;
    v.receipts = receipts;
    showReceipts();
  };
  receiptsTimer = setInterval(ask, window.HOOP_RECEIPTS_MS ?? 10_000);
  document.addEventListener("visibilitychange", ask);
}

/** Shows whether these pages run current code, and whether they still answer. */
function showBanner(info) {
  const banner = $("#banner");
  const text = !info
    ? "The pages stopped. Any hoop command or a new session starts them again."
    : info.stale
      ? `These pages run older hoop code than is installed, and restart into it on their own. If this stays, stop process ${info.pid}, and any hoop command starts the current code.`
      : "";
  banner.textContent = text;
  banner.classList.toggle("banner", Boolean(text));
}

/**
 * Asks for the server's info every minute, so the banner stays true and an open page counts as use.
 * One failed request is tried again after five seconds, so a page waking from sleep doesn't warn.
 */
function watchInfo() {
  const every = window.HOOP_INFO_MS ?? 60_000;
  // A request that never answers counts as failed, so it can't hide a stopped server.
  const ask = (retry) =>
    api("/api/info", { signal: AbortSignal.timeout(10_000) }).then(
      (info) => {
        state.info = info;
        showBanner(info);
        const version = $(".frame-version");
        if (version && info.release) version.textContent = `v${info.release}${info.code ? ` · ${info.code.slice(0, 7)}` : ""}`;
      },
      () => (retry ? setTimeout(() => ask(false), Math.min(5000, every)) : showBanner(undefined)),
    );
  setInterval(() => ask(true), every);
}

export async function start() {
  // The frame shows no version when the info request fails or takes longer than a second.
  const late = new Promise((r) => setTimeout(() => r(undefined), 1000));
  state.info = await Promise.race([api("/api/info").catch(() => undefined), late]);
  if (state.info) showBanner(state.info);
  watchInfo();
  watchPending({ onList: showReviews });
  if (location.pathname === "/work") {
    const { renderWork } = await import("/work.js");
    return renderWork(state.info).then(() => false);
  }
  const m = location.pathname.match(/^\/r\/(rv_[a-z0-9]+)$/);
  return (m ? load(m[1]) : renderList().then(() => false)).catch((err) => {
    app.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    return false;
  });
}
