// hoop review page. Renders a review from /api/reviews/:id; review.js adds commenting through `hooks`.
import { esc } from "/esc.js";
import { statusBadge } from "/status.js";
import { frame } from "/frame.js";
import { renderLine } from "/inline.js";
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");

export const state = { view: null, tab: "proposal", viewed: {}, canReview: false, raw: {}, repo: undefined };
// Tracker tables render as trees; tree.js imports this module, so it loads after it.
let treeMod = null;
import("/tree.js").then((m) => { treeMod = m; m.onTreeChange(() => state.view && render()); if (state.view) render(); });
export const hooks = { item: [], line: [], top: [], after: [], rendered: [] }; // extension points for review features

function storageKey() { return `hoop:${state.view.meta.id}:${state.view.meta.revisions}`; }
export function saveDraft(extra = {}) {
  try { localStorage.setItem(storageKey(), JSON.stringify({ ...loadDraft(), viewed: state.viewed, ...extra })); } catch {}
}
export function loadDraft() {
  try { return JSON.parse(localStorage.getItem(storageKey()) || "{}"); } catch { return {}; }
}

async function api(path, init) {
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

/** A commentable piece of text: selection anchors, highlight hooks, and the + button before it. */
function commentable(item, idx, text, tag = "span") {
  const gutter = hooks.line.map((h) => h(item, idx, "gutter")).join("");
  return `${gutter ? `<span class="inline-gutter">${gutter}</span>` : ""}<${tag} class="anchor" data-sel-item="${esc(item.id)}" data-sel-line="${idx}">${renderLine(text ?? "", decorations(item, idx))}</${tag}>`;
}
const below = (item, idx) => hooks.line.map((h) => h(item, idx, "below") || "").join("");

function changedIds(view) {
  if (!view.previous) return new Set();
  const before = new Map(view.previous.items.map((i) => [i.id, JSON.stringify(i.lines) + i.title]));
  return new Set(view.doc.items.filter((i) => before.get(i.id) !== JSON.stringify(i.lines) + i.title).map((i) => i.id));
}

/** The title and TL;DR as a pseudo item for comment hooks. */
const docItem = () => ({ id: "DOC", title: "Document", lines: [state.view.doc.title, state.view.doc.tldr] });

export function render() {
  const { meta, doc } = state.view;
  const changed = changedIds(state.view);
  const items = state.tab === "changes" ? doc.items.filter((i) => changed.has(i.id)) : doc.items;
  const viewedCount = doc.items.filter((i) => state.viewed[i.id]).length;
  app.innerHTML = frame("", `
    <header class="top">
      <div class="title-row"><h1 class="commentable">${commentable(docItem(), 0, doc.title)}</h1><div class="actions">${hooks.top.map((h) => h()).join("")}</div></div>
      <div class="sub">
        <span class="rev">rev ${meta.revisions}</span>${statusBadge(state.view.status_key, state.view.status_note)}
        <span>${doc.context?.repo ? `<span class="mono">${esc(doc.context.repo)}</span>` : ""} ${doc.context?.branch ? `· <span class="mono">${esc(doc.context.branch)}</span>` : ""}</span>
      </div>
      ${meta.revisions > 1 ? `<div class="tabs" role="tablist">
        <button class="tab" role="tab" id="tab-proposal" aria-selected="${state.tab === "proposal"}">Proposal</button>
        <button class="tab" role="tab" id="tab-changes" aria-selected="${state.tab === "changes"}">Changes since rev ${meta.revisions - 1} (${changed.size})</button>
      </div>` : ""}
    </header>
    <div class="layout">
      <nav class="outline" aria-label="Items">
        <div class="progress">${viewedCount} of ${doc.items.length} viewed</div>
        ${doc.items.map((i) => `<a href="#item-${esc(i.id)}"><span class="dot ${state.viewed[i.id] ? "viewed" : ""}"></span><span>${esc(i.id)} ${esc(i.title)}</span><span class="badge">${hooks.item.map((h) => h(i, "badge")).join("")}</span></a>`).join("")}
      </nav>
      <main>
        <div class="tldr commentable"><b>TL;DR</b>${commentable(docItem(), 1, doc.tldr)}</div>
        ${below(docItem(), 0)}${below(docItem(), 1)}
        <div class="items">${items.map((i) => renderItem(i, changed.has(i.id))).join("") || '<p class="empty">No changes in this revision.</p>'}</div>
        ${hooks.after.map((h) => h()).join("")}
      </main>
    </div>`, state.repo);
  hooks.rendered.forEach((h) => h());
}

/** Highlights and tracked changes on a line, as source ranges from the review hooks. */
const decorations = (item, i) => hooks.line.flatMap((h) => h(item, i, "decorations") || []);

/** A line as the line view renders it: formatted text, its comment button and its threads. */
function plainLine(item, i) {
  return `<div class="line"><div class="gutter">${hooks.line.map((h) => h(item, i, "gutter")).join("")}${i + 1}</div><div class="text" data-sel-item="${esc(item.id)}" data-sel-line="${i}">${renderLine(item.lines[i], decorations(item, i), item.blocks?.[i])}</div></div>${below(item, i)}`;
}

/** Whether a line has anything on it (threads, pending comments, edits, highlights) that must stay visible. */
function busy(item, i) {
  return Boolean(below(item, i)) || decorations(item, i).length > 0;
}

/**
 * An item with tracker tables: each table as a tree, each row still a commentable line (FR-10).
 * A row with comments or edits on it also shows its full line under the row, with highlights and
 * tracked changes, and stays visible through collapses and filters.
 */
function trackerBody(item) {
  let html = `<button class="btn link" data-raw="${esc(item.id)}">Show as lines</button><div class="lines">`, i = 0;
  for (const t of item.tables) {
    for (; i < t.start; i++) html += plainLine(item, i);
    // The header, separator and rows without an ID aren't tree rows; show them as lines when busy.
    const loose = [t.start, t.start + 1, ...t.rows.filter((r) => !r.cells.ID).map((r) => r.line)];
    html += loose.filter((n) => busy(item, n)).map((n) => plainLine(item, n)).join("");
    const rows = t.rows.filter((r) => r.cells.ID).map(({ line: n, cells }) => {
      const pinned = busy(item, n);
      const lead = `<span class="tgut">${hooks.line.map((h) => h(item, n, "gutter")).join("")}<span class="ln">${n + 1}</span></span>`;
      return { id: cells.ID, parent: cells.Parent, cells, lead, pinned, after: pinned ? `<div class="lines">${plainLine(item, n)}</div>` : "" };
    });
    html += `</div>${treeMod.renderTree(`${state.view.meta.id}:${item.id}:${t.start}`, t.columns, rows)}<div class="lines">`;
    i = t.end;
  }
  for (; i < item.lines.length; i++) html += plainLine(item, i);
  return html + "</div>";
}

function renderItem(item, changed) {
  const prev = state.view.previous?.items.find((p) => p.id === item.id);
  const diff = state.tab === "changes" && changed;
  let body;
  if (item.type === "question") {
    body = `<div class="qopts" role="radiogroup" aria-label="${esc(item.title)}">${(item.choices || []).map((c) =>
      `<label><input type="radio" name="q-${esc(item.id)}" id="q-${esc(item.id)}-${esc(c.id)}" value="${esc(c.id)}" data-q="${esc(item.id)}" ${state.canReview && state.view.meta.status !== "approved" ? "" : "disabled"}> <span>${esc(c.id)}) ${esc(c.label)}</span> ${c.recommended ? '<span class="rec">recommended</span>' : ""}</label>`).join("")}</div>`;
  } else if (!diff && !state.raw[item.id] && treeMod && item.tables) {
    body = trackerBody(item);
  } else {
    const removed = diff && prev ? prev.lines.filter((l) => !item.lines.includes(l)) : [];
    const prevBlock = (t) => prev?.blocks?.[prev.lines.indexOf(t)];
    body = `${!diff && treeMod && item.tables ? `<button class="btn link" data-raw="${esc(item.id)}">Show as tree</button>` : ""}<div class="lines">${removed.map((t) => `<div class="line del"><div class="gutter">−</div><div class="text">${renderLine(t, [], prevBlock(t))}</div></div>`).join("")}${item.lines.map((t, i) => {
      const cls = diff && !(prev?.lines.includes(t)) ? "add" : "";
      return `<div class="line ${cls}"><div class="gutter">${hooks.line.map((h) => h(item, i, "gutter")).join("")}${i + 1}</div><div class="text" data-sel-item="${esc(item.id)}" data-sel-line="${i}">${renderLine(t, decorations(item, i), item.blocks?.[i])}</div></div>${hooks.line.map((h) => h(item, i, "below") || "").join("")}`;
    }).join("")}</div>`;
  }
  return `<article class="item ${state.viewed[item.id] ? "collapsed" : ""}" id="item-${esc(item.id)}">
    <div class="item-head commentable"><span class="id">${esc(item.id)}</span><span class="t">${commentable(item, -1, item.title)}</span>
      ${item.risk ? `<span class="risk ${item.risk}">risk: ${item.risk}</span>` : ""}${changed ? '<span class="chg">changed</span>' : ""}
      <label><input type="checkbox" id="viewed-${esc(item.id)}" data-viewed="${esc(item.id)}" ${state.viewed[item.id] ? "checked" : ""}> Viewed</label></div>${below(item, -1)}${body}</article>`;
}

// The review list's groups, in the order a reviewer acts on them.
const GROUPS = [
  ["changes_requested", "Changes requested"], ["awaiting_review", "Awaiting review"], ["commented", "Commented"],
  ["approved", "Approved"], ["closed", "Closed"],
];
const CHANNELS = { local: "Local", github: "GitHub" };
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

async function renderList() {
  const list = await api("/api/reviews");
  const known = new Set(GROUPS.map(([k]) => k));
  // A key from a newer server still gets a group, after the known ones.
  const groups = [...GROUPS, ...[...new Set(list.map((m) => m.status_key))].filter((k) => !known.has(k)).map((k) => [k, k])];
  const row = (m) => `<a href="/r/${esc(m.id)}"><span class="t">${esc(m.title)}</span><span class="rev">rev ${m.revisions}</span>${statusBadge(m.status_key, m.status_note)}<span class="m">${esc(CHANNELS[m.channel] ?? m.channel)} · updated ${esc(when(m.updated))}</span></a>`;
  const body = list.length ? groups.map(([key, label]) => {
    const rows = list.filter((m) => m.status_key === key);
    return rows.length ? `<section class="group" aria-labelledby="g-${esc(key)}"><h2 id="g-${esc(key)}">${esc(label)} <span class="count">${rows.length}</span></h2>${rows.map(row).join("")}</section>` : "";
  }).join("") : '<p class="empty">No reviews yet. Reviews appear here when Claude submits one with hoop_submit.</p>';
  app.innerHTML = frame("reviews", `<div class="list"><h1>Reviews</h1>${body}</div>`, state.repo);
}

document.addEventListener("change", (e) => {
  const id = e.target.dataset?.viewed;
  if (id) { state.viewed[id] = e.target.checked; saveDraft(); render(); }
});
document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (t?.dataset.raw) { state.raw[t.dataset.raw] = !state.raw[t.dataset.raw]; render(); return; }
  if (t?.id === "tab-proposal" || t?.id === "tab-changes") { state.tab = t.id === "tab-changes" ? "changes" : "proposal"; render(); }
});

export async function load(id) {
  state.view = await api(`/api/reviews/${id}`);
  state.viewed = loadDraft().viewed || {};
  render();
}

export async function start() {
  // The frame shows no repository name when the info request fails or takes longer than a second.
  const late = new Promise((r) => setTimeout(() => r({}), 1000));
  state.repo = (await Promise.race([api("/api/info").catch(() => ({})), late])).repo;
  const m = location.pathname.match(/^\/r\/(rv_[a-z0-9]+)$/);
  if (location.pathname === "/tracker") return import("/tracker.js").then((t) => t.renderTracker()).then(() => false).catch((err) => { app.innerHTML = `<p class="empty">${esc(err.message)}</p>`; return false; });
  return (m ? load(m[1]) : renderList()).then(() => Boolean(m)).catch((err) => { app.innerHTML = `<p class="empty">${esc(err.message)}</p>`; return false; });
}
