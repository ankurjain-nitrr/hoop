// hoop review page. Renders a review from /api/reviews/:id; review.js adds commenting through `hooks`.
import { esc } from "/esc.js";
import { REVIEW, statusBadge } from "/status.js";
import { frame } from "/frame.js";
import { renderLine, renderTableRow } from "/inline.js";
import { rowCells, TABLE_DELIM } from "/blocks.js";
import { checksPanel } from "/checks.js";
import { depthOf, onOutlineChange, outlineHtml } from "/outline.js";
import { diagramHtml, isDiagram, mountDiagrams } from "/diagram.js";
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");

export const state = {
  view: null,
  tab: "proposal",
  viewed: {},
  canReview: false,
  raw: {},
  repo: undefined,
  info: undefined,
  open: {},
  openThreads: {},
  commentsHidden: false,
};
// Tracker tables render as trees; tree.js imports this module, so it loads after it.
let treeMod = null;
import("/tree.js").then((m) => {
  treeMod = m;
  m.onTreeChange(() => state.view && render());
  if (state.view) render();
});
export const hooks = { item: [], line: [], top: [], after: [], rendered: [] }; // extension points for review features
onOutlineChange(() => state.view && render());
hooks.rendered.push(() => mountDiagrams(app));

function storageKey() {
  return `hoop:${state.view.meta.id}:${state.view.meta.revisions}`;
}
export function saveDraft(extra = {}) {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({ ...loadDraft(), viewed: state.viewed, ...extra }));
  } catch {}
}
export function loadDraft() {
  try {
    return JSON.parse(localStorage.getItem(storageKey()) || "{}");
  } catch {
    return {};
  }
}

/** Every request carries this browser's sign-in, from the page's own storage, so the server knows who it is. */
async function api(path, init = {}) {
  let signin;
  try {
    signin = localStorage.getItem("hoop:signin");
  } catch {}
  const res = await fetch(path, signin ? { ...init, headers: { ...init.headers, "x-hoop-signin": signin } } : init);
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

/** What an approval wrote, and the review that replaced this one, when there is one. */
function decidedNote(meta) {
  const parts = [];
  if (meta.superseded_by)
    parts.push(`<p>A newer review replaced this one: <a href="/r/${encodeURIComponent(meta.superseded_by)}">${esc(meta.superseded_by)}</a>.</p>`);
  if (meta.status === "approved" && meta.decision_files?.length)
    parts.push(
      meta.github
        ? `<p>Approved. The merged pull request holds ${meta.decision_files.map((f) => `<code>${esc(f)}</code>`).join(" and ")}.</p>`
        : `<p>Approved. hoop wrote ${meta.decision_files.map((f) => `<code>${esc(f)}</code>`).join(" and ")} for the agent to commit.</p>`,
    );
  return parts.length ? `<section class="decided" role="status">${parts.join("")}</section>` : "";
}

/** The title and TL;DR as a pseudo item for comment hooks. */
/** Markdown documents hide their section IDs; structured reviews keep them (FR-7). */
export const isDoc = () => state.view?.doc.kind === "doc";

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
        <span class="rev">rev ${meta.revisions}</span>${statusBadge(state.view.status_key, state.view.status_note)}
        <span>${doc.context?.repo ? `<span class="mono">${esc(doc.context.repo)}</span>` : ""} ${doc.context?.branch ? `· <span class="mono">${esc(doc.context.branch)}</span>` : ""}</span>
      </div>
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
        ${checksPanel(state.view)}
        ${doc.tldr_auto && state.tab !== "changes" ? "" : `<div class="tldr commentable"><b>TL;DR</b>${commentable(docItem(), 1, doc.tldr)}</div>`}
        ${below(docItem(), 0)}${below(docItem(), 1)}
        <div class="items">${items.map((i) => renderItem(i, changed.has(i.id))).join("") || '<p class="empty">No changes in this revision.</p>'}</div>
        ${hooks.after.map((h) => h()).join("")}
      </main>
    </div>`,
    state.repo,
    { ...state.info, login: state.whoami?.login },
  );
  // The hidden mode lives in the view state, so every render keeps it.
  app.classList.toggle("comments-hidden", Boolean(state.commentsHidden));
  hooks.rendered.forEach((h) => h());
}

/** Highlights and tracked changes on a line, as source ranges from the review hooks. */
const decorations = (item, i) => hooks.line.flatMap((h) => h(item, i, "decorations") || []);

/** A line as the line view renders it: formatted text, its comment button and its threads. */
function plainLine(item, i) {
  return `<div class="line"><div class="gutter">${hooks.line.map((h) => h(item, i, "gutter")).join("")}${i + 1}</div><div class="text" data-sel-item="${esc(item.id)}" data-sel-line="${i}">${renderLine(item.lines[i], decorations(item, i), item.blocks?.[i])}</div>${hooks.line.map((h) => h(item, i, "end") || "").join("")}</div>${below(item, i)}`;
}

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
  let html = `<button class="btn link" data-raw="${esc(item.id)}">Show as lines</button><div class="lines">`,
    i = 0;
  for (const t of item.tables) {
    for (; i < t.start; i++) html += plainLine(item, i);
    // The header, separator and rows without an ID aren't tree rows; show them as lines when busy.
    const loose = [t.start, t.start + 1, ...t.rows.filter((r) => !r.cells.ID).map((r) => r.line)];
    html += loose
      .filter((n) => busy(item, n))
      .map((n) => plainLine(item, n))
      .join("");
    const rows = t.rows
      .filter((r) => r.cells.ID)
      .map(({ line: n, cells }) => {
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

/** A question's options as one radio group; a markdown section headed "Question:" gets one below its lines. */
function answerHtml(item) {
  const open = state.canReview && state.view.meta.status !== "approved";
  return `<div class="qopts" role="radiogroup" aria-label="${esc(item.title)}">${(item.choices || [])
    .map(
      (c) =>
        `<label><input type="radio" name="q-${esc(item.id)}" id="q-${esc(item.id)}-${esc(c.id)}" value="${esc(c.id)}" data-q="${esc(item.id)}" ${open ? "" : "disabled"}> <span>${esc(c.id)}) ${esc(c.label)}</span> ${c.recommended ? '<span class="rec">recommended</span>' : ""}</label>`,
    )
    .join("")}</div>`;
}

function renderItem(item, changed) {
  const prev = state.view.previous?.items.find((p) => p.id === item.id);
  const diff = state.tab === "changes" && changed;
  let body;
  if (item.type === "question") {
    body = answerHtml(item);
  } else if (!diff && !state.raw[item.id] && treeMod && item.tables) {
    body = trackerBody(item);
  } else {
    const removed = diff && prev ? prev.lines.filter((l) => !item.lines.includes(l)) : [];
    // The Changes tab shows lines as written, so a change to markup alone stays visible.
    const prevBlock = (t) => prev?.blocks?.[prev.lines.indexOf(t)];
    const line = (t, i) => {
      const cls = diff && !prev?.lines.includes(t) ? "add" : "";
      return `<div class="line ${cls}"><div class="gutter">${hooks.line.map((h) => h(item, i, "gutter")).join("")}${i + 1}</div><div class="text" data-sel-item="${esc(item.id)}" data-sel-line="${i}">${!diff && isDiagram(t) ? diagramHtml(t) : renderLine(t, decorations(item, i), diff ? undefined : item.blocks?.[i])}</div>${diff ? "" : hooks.line.map((h) => h(item, i, "end") || "").join("")}</div>${hooks.line.map((h) => h(item, i, "below") || "").join("")}`;
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
    body = `${!diff && treeMod && item.tables ? `<button class="btn link" data-raw="${esc(item.id)}">Show as tree</button>` : ""}<div class="lines">${removed.map((t) => `<div class="line del"><div class="gutter">−</div><div class="text">${renderLine(t, [], diff ? undefined : prevBlock(t))}</div></div>`).join("")}${lines}</div>${item.choices?.length && !diff ? answerHtml(item) : ""}`;
  }
  // A viewed item stays collapsed unless the reviewer jumped to one of its lines.
  // A nested section sits inside its parent, indented by its depth under the title.
  const renamed = state.view.renamed?.[item.id];
  return `<article class="item ${state.viewed[item.id] && !state.open[item.id] ? "collapsed" : ""}" id="item-${esc(item.id)}" style="--depth:${depthOf(item) - 1}">
    <div class="item-head commentable">${isDoc() ? "" : `<span class="id">${esc(item.id)}</span>`}<span class="t">${commentable(item, -1, item.title)}</span>${renamed ? `<span class="renamed">renamed from “${esc(renamed)}”</span>` : ""}
      ${item.risk ? `<span class="risk ${item.risk}">risk: ${item.risk}</span>` : ""}${changed ? '<span class="chg">changed</span>' : ""}
      <label><input type="checkbox" id="viewed-${esc(item.id)}" data-viewed="${esc(item.id)}" ${state.viewed[item.id] ? "checked" : ""}> Viewed</label></div>${below(item, -1)}${body}</article>`;
}

// The review list's groups, in the order a reviewer acts on them.
const GROUPS = ["changes_requested", "awaiting_review", "commented", "approved", "closed"].map((k) => [k, REVIEW[k].label]);
const CHANNELS = { local: "Local", github: "GitHub" };
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

const listView = { project: "" };

async function renderList() {
  const all = await api("/api/reviews");
  const projects = [...new Set(all.map((m) => m.project).filter(Boolean))].sort();
  const list = all.filter((m) => !listView.project || m.project === listView.project);
  const known = new Set(GROUPS.map(([k]) => k));
  // A key from a newer server still gets a group, after the known ones.
  const groups = [...GROUPS, ...[...new Set(list.map((m) => m.status_key))].filter((k) => !known.has(k)).map((k) => [k, k])];
  const row = (m) =>
    `<a href="/r/${esc(m.id)}"><span class="t">${esc(m.title)}</span><span class="rev">rev ${m.revisions}</span>${statusBadge(m.status_key, m.status_note)}<span class="m">${m.repo ? `<span class="mono">${esc(m.repo.name)}</span> · ` : ""}${esc(CHANNELS[m.channel] ?? m.channel)} · updated ${esc(when(m.updated))}</span></a>`;
  const body = list.length
    ? groups
        .map(([key, label]) => {
          const rows = list.filter((m) => m.status_key === key);
          return rows.length
            ? `<section class="group" aria-labelledby="g-${esc(key)}"><h2 id="g-${esc(key)}">${esc(label)} <span class="count">${rows.length}</span></h2>${rows.map(row).join("")}</section>`
            : "";
        })
        .join("")
    : all.length
      ? '<p class="empty">No reviews in this project.</p>'
      : '<p class="empty">No reviews yet. Reviews appear here when Claude submits one with hoop_submit.</p>';
  const filter =
    projects.length > 1
      ? `<label>Project <select id="list-project"><option value="">All</option>${projects.map((p) => `<option ${p === listView.project ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></label>`
      : "";
  app.innerHTML = frame("reviews", `<div class="list"><header class="tracker-head"><h1>Reviews</h1>${filter}</header>${body}</div>`, undefined, {
    ...state.info,
    login: state.whoami?.login,
  });
  $("#list-project")?.addEventListener("change", (e) => {
    listView.project = e.target.value;
    renderList().then(() => $("#list-project")?.focus());
  });
}

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
  if (t?.dataset.raw) {
    state.raw[t.dataset.raw] = !state.raw[t.dataset.raw];
    render();
    return;
  }
  if (t?.id === "tab-proposal" || t?.id === "tab-changes") {
    state.tab = t.id === "tab-changes" ? "changes" : "proposal";
    render();
  }
  if (t?.dataset.gotoItem) goToLine(t.dataset.gotoItem, Number(t.dataset.gotoLine));
});

/** Opens the item if it is collapsed, then scrolls to the line and marks it for a moment. */
function goToLine(itemId, line) {
  state.tab = "proposal";
  state.open[itemId] = true;
  const find = () => document.querySelector(`[data-sel-item="${CSS.escape(itemId)}"][data-sel-line="${line}"]`);
  render();
  // A tracker table shows rows, not lines, so it switches to its lines to show this one.
  if (!find() && state.view.doc.items.find((i) => i.id === itemId)?.tables) {
    state.raw[itemId] = true;
    render();
  }
  const el = find();
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  const row = el.closest(".line") ?? el;
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1500);
}

export async function load(id) {
  state.view = await api(`/api/reviews/${id}`);
  state.repo = state.view.repo;
  state.viewed = loadDraft().viewed || {};
  render();
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
  [state.info, state.whoami] = await Promise.all([Promise.race([api("/api/info").catch(() => undefined), late]), api("/api/whoami").catch(() => null)]);
  if (state.info) showBanner(state.info);
  watchInfo();
  const m = location.pathname.match(/^\/r\/(rv_[a-z0-9]+)$/);
  if (location.pathname === "/changes")
    return import("/changes.js")
      .then((c) => c.renderChanges())
      .then(() => false)
      .catch((err) => {
        app.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
        return false;
      });
  if (location.pathname === "/tracker")
    return import("/tracker.js")
      .then((t) => t.renderTracker())
      .then(() => false)
      .catch((err) => {
        app.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
        return false;
      });
  return (m ? load(m[1]) : renderList())
    .then(() => Boolean(m))
    .catch((err) => {
      app.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
      return false;
    });
}
