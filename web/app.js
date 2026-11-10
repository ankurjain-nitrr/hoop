// hoop review page. Renders a review from /api/reviews/:id; review.js adds commenting through `hooks`.
import { esc } from "/esc.js";
import { ACTION, MESSAGES_OFF, PR, READ, REVIEW, statusBadge } from "/status.js";
import { foldAllHtml, foldBody, foldButton, foldClick, foldCount, foldSummary, tally } from "/fold.js";
import { announce, frame, PAGES_STOPPED, setBanner, updateNav } from "/frame.js";
import { focusSpot, regainFocus } from "/focus.js";
import { sweepKept } from "/drafts.js";
import { api, post } from "/api.js";
import { notifyHtml, watchPending } from "/pending.js";
import { tipsSwitchHtml } from "/tips.js";
import { icons } from "/icons.js";
import { loadPermissions, onPermissions, permissionFormOpen, prompts, promptHtml } from "/permissions.js";
import { readAt, span } from "/activity.js";
import { plainText, PROSE, renderLine, renderTableRow, titleHtml } from "/inline.js";
import { OPTION, rowCells, TABLE_DELIM } from "/blocks.js";
import { depthOf, outlineHtml } from "/outline.js";
import { diagramHtml, isDiagram, mountDiagrams } from "/diagram.js";
import { reviewOfPath, reviewPath } from "/links.js";
import { DOC_LINES, docLineText } from "/doc-lines.js";
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");

export const state = {
  view: null,
  /**
   * While a live refresh shows the review again (noticeChange): what the page would say, gathered into
   * one message, as `{ said: [] }`. Hooks that would announce or store drafts check it.
   */
  live: null,
  tab: "proposal",
  viewed: {},
  canReview: false,
  info: undefined,
  open: {},
  commentsHidden: false,
};
// Extension points for review features; ask.js sets `renderAsk`, which draws a quick question's page.
export const hooks = { item: [], line: [], top: [], after: [], before: [], rendered: [], loaded: [], renderAsk: null, threadPlace: null, linePlace: null };
hooks.rendered.push(() => mountDiagrams(app));
// A diagram the library refuses is reported once per page, on the revision it was drawn from, so
// Claude reads why it didn't render. Only a request that never reached hoop is tried again.
const reportedDiagrams = new Set();
app.addEventListener("diagram-error", (e) => {
  const id = state.view?.meta?.id;
  const { revision, item, line, message } = e.detail;
  const key = `${revision}|${item}|${line}`;
  if (!id || reportedDiagrams.has(key)) return;
  reportedDiagrams.add(key);
  post(`/api/reviews/${encodeURIComponent(id)}/diagram-error`, { revision, item, line, message }).catch((err) => {
    if (!err.body) reportedDiagrams.delete(key);
  });
});

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

export { esc, frame, $ };

/**
 * Text at a page anchor (0-based index; line = index + 1): index -1 is an item's heading, and item
 * "DOC" index 0 is the title, 1 the TL;DR, 2 the subtitle. `rev` reads an earlier revision from history.
 */
export function textAt(itemId, idx, rev) {
  const v = state.view;
  if (rev && rev !== v.meta.revisions) return historyAt(v.history?.[rev], itemId, idx);
  if (itemId === "DOC") return docLineText(v.doc, idx + 1);
  const item = v.doc.items.find((i) => i.id === itemId);
  return idx === -1 ? item?.title : item?.lines[idx];
}

/** Text at a page anchor in an earlier revision's history `h`, as textAt reads it. */
function historyAt(h, itemId, idx) {
  if (itemId === "DOC") return h?.DOC?.[idx];
  return idx === -1 ? h?.[`#${itemId}`] : h?.[itemId]?.[idx];
}

export { PROSE };

/** A commentable piece of text: selection anchors, highlight hooks, and the + button before it. */
function commentable(item, idx, text, tag = "span") {
  const gutter = hooks.line.map((h) => h(item, idx, "gutter")).join("");
  return `${gutter ? `<span class="inline-gutter">${gutter}</span>` : ""}<${tag} class="anchor" data-sel-item="${esc(item.id)}" data-sel-line="${idx}">${renderLine(text ?? "", decorations(item, idx), PROSE)}</${tag}>`;
}
const below = (item, idx) => hooks.line.map((h) => h(item, idx, "below") || "").join("");

/**
 * Each section's counterpart in the compared revision, by ID, else by heading: a section removed and
 * written again later gets a new ID, and is still the same section to the reviewer.
 */
function previousItems(view) {
  const out = new Map();
  if (!view.previous) return out;
  const ids = new Set(view.doc.items.map((i) => i.id));
  const byId = new Map(view.previous.items.map((p) => [p.id, p]));
  for (const i of view.doc.items) if (byId.has(i.id)) out.set(i.id, byId.get(i.id));
  for (const i of view.doc.items) {
    if (out.has(i.id)) continue;
    const p = view.previous.items.find((x) => !ids.has(x.id) && x.title === i.title && ![...out.values()].includes(x));
    if (p) out.set(i.id, p);
  }
  return out;
}

function changedIds(view) {
  if (!view.previous) return new Set();
  const before = previousItems(view);
  const text = (i) => (i ? JSON.stringify(i.lines) + i.title : undefined);
  return new Set(view.doc.items.filter((i) => text(before.get(i.id)) !== text(i)).map((i) => i.id));
}

/** The sections the compared revision had that this one doesn't, by ID or heading. */
function removedItems(view) {
  if (!view.previous) return [];
  const matched = new Set(previousItems(view).values());
  return view.previous.items.filter((i) => !matched.has(i));
}

/** The review that replaced this one, when there is one. */
function decidedNote(meta) {
  if (!meta.superseded_by) return "";
  return `<section class="decided" data-ended><p>A newer review replaced this one: <a href="${reviewPath(meta.superseded_by)}">${esc(meta.superseded_by)}</a>.</p></section>`;
}

// Close: a person closes a review or quick question they no longer need, without approving it,
// confirming in place with an optional one-line reason. Their request for changes or answer reopens it.
const closing = { open: false, reason: "", error: "", busy: false };

/**
 * Whether the person may close a review: not closed, approved, replaced or being built, nor a quick
 * question already answered or withdrawn. `ask` carries a quick question's state, as its page and Home have it.
 */
const closable = (meta, ask) => !meta.closed && meta.status !== "approved" && !meta.superseded_by && meta.build !== "open" && (!ask || ask.state === "open");

/**
 * The close confirmation, on the review page and on a Home row: its elements' IDs start with `p`,
 * `attrs` names the form and `cancel` its Cancel button. A review opened from a file (`file`) has no
 * session to tell.
 */
const closeFormHtml = (p, attrs, cancel, reason, error, file) =>
  `<form ${attrs} aria-labelledby="${p}Ask"><span id="${p}Ask">Close this without approving it?${file ? "" : " Claude is told, and it stops."}</span><label for="${p}Reason">Reason (optional)</label><input id="${p}Reason" name="reason" maxlength="200" autocomplete="off" value="${esc(reason)}" aria-describedby="${p}Error"${error ? ' aria-invalid="true"' : ""}><button type="submit" class="btn small danger">Close</button><button type="button" class="btn small" ${cancel}>Cancel</button><p id="${p}Error" class="steer-error" role="alert">${esc(error)}</p></form>`;

/** The Close button, while the review can be closed and its confirmation isn't open. */
export const closeButtonHtml = (v = state.view) =>
  closable(v.meta, v.ask) && !closing.open ? '<button type="button" class="btn" id="closeReview">Close</button>' : "";

/** Who closed the review, when and why, and what reopens it; or the confirmation, while it is open. */
export function closePanelHtml(v = state.view) {
  const c = v.meta.closed;
  const reopens = v.ask ? "Answering a question reopens it." : "Requesting changes reopens it.";
  if (c)
    return `<section class="decided closed-note" aria-labelledby="closedText"><p id="closedText" tabindex="-1">${YOU} closed this without approving it, ${esc(readAt(c.at))}${c.reason ? `: ${esc(c.reason)}${/[.!?]$/.test(c.reason) ? "" : "."}` : "."} ${reopens}</p></section>`;
  if (!closing.open || !closable(v.meta, v.ask)) return "";
  return closeFormHtml("close", 'class="steer-form" id="closeForm"', 'id="cancelClose"', closing.reason, closing.error, fromFile(v));
}

/** Draws the review or quick question again, with focus on `focus`. */
async function paintView(focus) {
  if (state.view.ask) hooks.renderAsk();
  else render();
  $(focus)?.focus();
}

/** Closes the review shown and shows it as the server now has it, with focus on the note; a refusal shows in the confirmation. */
async function closeShown(reason) {
  // A second Enter or click while the first request runs sends nothing.
  if (closing.busy) return;
  closing.busy = true;
  try {
    const view = await post(`/api/reviews/${encodeURIComponent(state.view.meta.id)}/close`, { reason });
    Object.assign(closing, { open: false, reason: "", error: "" });
    await show(view);
    $("#closedText")?.focus();
  } catch (err) {
    closing.error = err.message;
    await paintView("#closeReason");
  } finally {
    closing.busy = false;
  }
}

/** Where a review was written, as people read it: the folder's name, and its git repository's when that differs. */
function placeText(place) {
  if (!place?.folder) return "";
  return place.repo ? `${place.folder} in ${place.repo}` : place.folder;
}

/**
 * What a review opened from a file says of who opened it. `hoop open` runs as the person at this
 * machine, who is the one viewing these local pages, so it reads "you" rather than their account name.
 */
const OPENED_BY_YOU = "Opened by you";

/**
 * Who sent a review's feedback, as the page names them: a session that commented by its name, and
 * the person at this machine, who is the one viewing, as "You", sent or not. Their account name stays
 * in the review's history.
 */
export const YOU = "You";
export const sentBy = (fb) => (fb.session ? fb.reviewer : YOU);

/** Who a review is by: the session that submitted it, or the person who opened its file. */
function byWhom(who, openedBy) {
  if (who) return `by ${esc(who)}`;
  return openedBy ? OPENED_BY_YOU : "";
}

/** The review page's small "by <session> · <place>" line, or "Opened by you · <place>" for a file the person opened. */
export function byline(view) {
  const who = view.session?.label ?? view.meta.owner;
  const by = byWhom(who, view.meta.opened_by);
  const where = placeText(view.place);
  if (!by && !where) return "";
  const title = who ? "The Claude Code session that submitted this review, and the folder it worked in" : "Who opened this file for review, and its folder";
  return `<span class="owner" title="${title}">${by}${by && where ? " · " : ""}${where ? `<span class="mono">${esc(where)}</span>` : ""}</span>`;
}

/** The title and TL;DR as a pseudo item for comment hooks. */
/** Markdown documents hide their section IDs; structured reviews keep them. */
export const isDoc = () => state.view?.doc.kind === "doc";

/** The latest submitted review's receipt key, `<revision>.<index>`, or undefined before any review. */
function latestReview(view = state.view) {
  const all = view.feedback ?? [];
  const last = all.at(-1);
  return last && `${last.revision}.${all.filter((f) => f.revision === last.revision).length - 1}`;
}

export { readAt };

/** A review that reached the session, as a status: a wait took it, or the session got a message naming it. */
const sentTo = (d) => `Sent to Claude ${readAt(d.at)}`;

/** A review from the page that isn't read yet, by how it reached the session. */
const DELIVERY = {
  waiting: sentTo,
  sent: sentTo,
  no_session: () => "Not read yet; no live Claude session took it",
  other_home: () => "Not read yet; Claude's session uses another hoop",
  failed: () => "Not read yet; couldn't reach Claude's session",
  off: () => MESSAGES_OFF,
};

/**
 * A review that asks Claude to act on nothing (an approval, or any review of a closed one) is never
 * "not read yet": the page says whether the wake message told Claude of it.
 */
const TOLD = {
  waiting: sentTo,
  sent: sentTo,
  no_session: () => "Claude wasn't told; no live Claude session took it",
  other_home: () => "Claude wasn't told; its session uses another hoop",
  failed: () => "Claude wasn't told; couldn't reach Claude's session",
  off: () => MESSAGES_OFF,
};

/**
 * Whether and when Claude read a submitted review, as a short status: "Read by Claude 21:04", "Sent
 * to Claude 21:03", or "Not read yet" with why it didn't reach the session; for a review that asks
 * Claude to act on nothing, as the server's asks_to_act says, whether Claude was told. `of` holds
 * the receipts and deliveries: the page's review, or a quick question's card on it.
 */
export function receiptText(key, of = state.view) {
  const r = of?.receipts?.[key];
  if (r) return `Read by ${r.by === "agent" ? "Claude" : r.by} ${readAt(r.at)}`;
  const d = of?.deliveries?.[key];
  if (of?.asks_to_act?.[key] === false) return d && TOLD[d.outcome] ? TOLD[d.outcome](d) : "Nothing for Claude to act on";
  return d && DELIVERY[d.outcome] ? DELIVERY[d.outcome](d) : "Not read yet";
}

/**
 * Whether the latest submitted review reached Claude (a wait took it, or its session got a message)
 * and Claude hasn't read it yet. The receipt then says it was sent, and the header leaves out the
 * agent line, which still says what Claude did before it, such as waiting for your review. A review
 * that asks Claude to act on nothing is never unread.
 */
function sentUnread(view) {
  const key = latestReview(view);
  if (key && view.asks_to_act?.[key] === false) return false;
  const outcome = key && !view.receipts?.[key] ? view.deliveries?.[key]?.outcome : undefined;
  return outcome === "waiting" || outcome === "sent";
}

/**
 * The agent state the header shows: on a review, none while a review that reached Claude waits to be
 * read. A quick question's wait goes on while questions are left, so its page always shows it.
 */
const shownAgent = (view = state.view) => (!view.ask && sentUnread(view) ? undefined : view.agent);

/** The command that resumes a Claude Code session. */
const resumeCommand = (session) => `claude --resume ${session}`;

/**
 * A live session's line: idle or working, and whether a submit (`ask`: an answer) reaches it, or
 * why not: it takes no messages, or it uses another hoop (another hoop home), which a submit here never reaches.
 */
function liveText(a, ask) {
  const told = ask ? "after you answer, ask it in the session to read your answers" : "after you submit, ask it in the session to read your review";
  const idle = a.state === "idle";
  const doing = idle ? "Claude's session is idle" : "Claude is working";
  if (a.elsewhere) return `${doing} and uses another hoop`;
  if (!a.wakes) return `${doing} and takes no messages; ${told}`;
  if (idle) return `Claude's session is idle; ${ask ? "answering" : "submitting"} wakes it`;
  return `Claude is working on something else; ${ask ? "answering sends it your answer" : "submitting sends it your review"}`;
}

/** What the agent that owns the review is doing, in words for the reviewer. */
export function agentText(a) {
  // A quick question is answered, not reviewed, and each answer is sent at once.
  const ask = Boolean(state.view?.ask);
  switch (a?.state) {
    case "waiting":
      return ask ? "Claude is waiting for your answer" : "Claude is waiting for your review";
    case "idle":
    case "busy":
      return liveText(a, ask);
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

/** The header's line on the agent's state. It stays in the page, and the live region says a change (showAgent). */
export const agentHtml = (a) => `<div class="agent-state" data-agent="${esc(a?.state ?? "")}" ${a ? "" : "hidden"}>${agentInner(a)}</div>`;

/** Whether a person opened the review from a file with `hoop open`, so no session takes it (`fromFile` in src/rules.ts). */
export const fromFile = (view = state.view) => Boolean(view?.meta?.opened_by && !view?.meta?.owner);

/**
 * A receipt that the receipts poll keeps current without rendering the page again. A review opened
 * from a file shows none: no session reads it.
 */
export const receiptHtml = (key) => (fromFile() ? "" : `<span class="receipt" data-receipt="${esc(key)}">${esc(receiptText(key))}</span>`);

/** The header's notice that Claude submitted a newer revision. It stays in the page, and the live region says it arrived. */
function newRevisionInner() {
  const n = state.newRevision;
  return n ? `${icons.info}<span>Revision ${n} is ready</span><button type="button" class="btn small primary" id="showRevision">Show it</button>` : "";
}
const newRevisionHtml = () => `<div class="new-revision" ${state.newRevision ? "" : "hidden"}>${newRevisionInner()}</div>`;

/** Shows that a newer revision is ready, in place, so nothing the reviewer is writing moves. */
function noticeRevision(n) {
  if (!n || n <= state.view.meta.revisions || n === state.newRevision) return;
  state.newRevision = n;
  const el = $(".new-revision");
  if (!el) return;
  el.innerHTML = newRevisionInner();
  el.hidden = false;
  announce(`Revision ${n} is ready. Show it is in the header.`);
}

const docItem = () => ({ id: "DOC", title: "Document", lines: DOC_LINES.map((l) => state.view.doc[l.field]) });

/** The Proposal and Changes tabs, once there is an earlier revision; `count` is how many sections changed or went. */
function tabsHtml(meta, count) {
  if (!(meta.revisions > 1)) return "";
  const previous = state.view.previous;
  return `<div class="tabs" role="tablist">
        <button class="tab" role="tab" id="tab-proposal" aria-selected="${state.tab === "proposal"}">Proposal</button>
        <button class="tab" role="tab" id="tab-changes" aria-selected="${state.tab === "changes"}">Changes since ${previous?.reviewed ? "your review of " : ""}rev ${previous?.revision ?? meta.revisions - 1} (${count})</button>
      </div>`;
}

/** What the items show when none do: nothing on the Changes tab while sections went, else that nothing changed. */
const noChangesHtml = (gone) => (gone.length && state.tab === "changes" ? "" : '<p class="empty">No changes in this revision.</p>');

export function render() {
  const { meta, doc } = state.view;
  const changed = changedIds(state.view);
  const gone = removedItems(state.view);
  const items = state.tab === "changes" ? doc.items.filter((i) => changed.has(i.id)) : doc.items;
  const viewedCount = doc.items.filter((i) => state.viewed[i.id]).length;
  document.title = `${plainText(doc.title)} · hoop`;
  // A redraw keeps focus on the control pressed, or the one now in its place, unless the action puts it elsewhere.
  const was = focusSpot(app);
  const html = frame(
    "",
    `
    <header class="top">
      <div class="title-row"><h1 class="commentable">${commentable(docItem(), 0, doc.title)}</h1><div class="actions">${statusBadge(state.view.status_key)}${closeButtonHtml()}${hooks.top.map((h) => h()).join("")}</div></div>
      ${doc.subtitle !== undefined ? `<p class="subtitle commentable">${commentable(docItem(), 2, doc.subtitle)}</p>` : ""}
      <div class="sub">
        <span class="rev">rev ${meta.revisions}</span>${byline(state.view)}
        <span>${doc.context?.repo ? `<span class="mono">${esc(doc.context.repo)}</span>` : ""} ${doc.context?.branch ? `· <span class="mono">${esc(doc.context.branch)}</span>` : ""}</span>
      </div>
      ${latestReview() && !fromFile() ? `<div class="sub latest-receipt">Latest review: ${receiptHtml(latestReview())}</div>` : ""}
      ${agentHtml(shownAgent())}
      ${newRevisionHtml()}
      ${tabsHtml(meta, changed.size + gone.length)}
    </header>
    <div class="layout">
      <nav class="outline" aria-label="Items">
        <div class="progress">${viewedCount} of ${doc.items.length} viewed</div>
        ${outlineHtml(
          doc.items,
          (i) =>
            `<a href="#item-${esc(i.id)}"><span class="dot ${state.viewed[i.id] ? "viewed" : ""}"></span><span class="ol-t fmt">${isDoc() ? "" : `${esc(i.id)} `}${titleHtml(i.title)}</span><span class="badge">${hooks.item.map((h) => h(i, "badge")).join("")}</span></a>`,
          meta.id,
        )}
      </nav>
      <main>
        ${/* An automatic TL;DR repeats the first paragraph, so it shows only where that may be filtered out. */ ""}
        ${decidedNote(meta)}${closePanelHtml()}
        ${hooks.before.map((h) => h()).join("")}
        ${doc.tldr_auto && state.tab !== "changes" ? "" : `<div class="tldr commentable"><b>TL;DR</b>${commentable(docItem(), 1, doc.tldr)}</div>`}
        ${below(docItem(), 0)}${below(docItem(), 2)}${below(docItem(), 1)}
        ${state.tab === "changes" && gone.length ? `<p class="removed-sections">Removed: ${gone.map((i) => `<span class="removed-title fmt">${titleHtml(i.title)}</span>`).join(", ")}</p>` : ""}
        <div class="items">${items.map((i) => renderItem(i, changed.has(i.id))).join("") || noChangesHtml(gone)}</div>
        ${hooks.after.map((h) => h()).join("")}
      </main>
    </div>`,
    state.info,
  );
  // A live refresh changes the page in place, so what didn't change, such as a drawn diagram, stays.
  if (state.live) morph(app, html);
  else app.innerHTML = html;
  // The hidden mode lives in the view state, so every render keeps it.
  app.classList.toggle("comments-hidden", Boolean(state.commentsHidden));
  hooks.rendered.forEach((h) => h());
  regainFocus(app, was);
}

/** Highlights and tracked changes on a line, as source ranges from the review hooks. */
const decorations = (item, i) => hooks.line.flatMap((h) => h(item, i, "decorations") || []);

/** A table column's alignment from its delimiter cell: `:-:` centers, `-:` aligns right. */
function cellAlign(c) {
  if (c.text.startsWith(":") && c.text.endsWith(":")) return "center";
  return c.text.endsWith(":") ? "right" : "";
}

/**
 * A table line's cells, `width` wide: the delimiter row as a plain rule, a line that isn't a row as
 * one cell, else its cells, as header cells in the first row when the table has a delimiter after it.
 */
function tableCells(item, n, { from, delim, width, align }) {
  const t = item.lines[n];
  // The delimiter's dashes aren't drawn, unless a highlight or a tracked change sits on them.
  if (n === delim) {
    const marks = decorations(item, n);
    const shown = marks.length ? renderLine(t, marks) : "";
    return `<td class="tdelim" colspan="${width}"><span data-sel-item="${esc(item.id)}" data-sel-line="${n}" class="text">${shown}</span></td>`;
  }
  const cells = renderTableRow(t, decorations(item, n));
  if (!cells) return `<td colspan="${width}">${renderLine(t, decorations(item, n))}</td>`;
  const tag = n === from && (n < delim || delim < 0) ? "th" : "td";
  return Array.from({ length: width }, (_, k) =>
    k < cells.length ? `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${cells[k]}</${tag}>` : `<${tag}></${tag}>`,
  ).join("");
}

/**
 * Lines `from` to `end` of an item as one table. Each row is still its own commentable line, with
 * its gutter and number; the first row is the header and the delimiter row shows as a plain rule.
 */
function tableHtml(item, from, end) {
  const delim = item.lines.findIndex((t, n) => n > from && n < end && TABLE_DELIM.test(t));
  const align = delim < 0 ? [] : rowCells(item.lines[delim]).map(cellAlign);
  const width = Math.max(...item.lines.slice(from, end).map((t) => rowCells(t).length));
  let rows = "";
  for (let n = from; n < end; n++) {
    const gutter = `<td class="gutter">${hooks.line.map((h) => h(item, n, "gutter")).join("")}${n + 1}</td>`;
    const endHook = `<td class="tend">${hooks.line.map((h) => h(item, n, "end") || "").join("")}</td>`;
    const after = hooks.line.map((h) => h(item, n, "below") || "").join("");
    const inner = tableCells(item, n, { from, delim, width, align });
    const host = n === delim ? "" : ` data-sel-item="${esc(item.id)}" data-sel-line="${n}"`;
    rows += `<tr class="tline${n === delim ? " tdelim-row" : ""}"${host}>${gutter}${inner}${endHook}</tr>`;
    if (after) rows += `<tr class="tafter"><td colspan="${width + 2}">${after}</td></tr>`;
  }
  return `<div class="md-table-wrap"><table class="md-table"><tbody>${rows}</tbody></table></div>`;
}

/** A radio button for one answer to a question. */
function radioHtml(item, value, label) {
  // An approved or closed review still takes answers, with a request for changes; a replaced one takes none.
  const off = state.canReview && !state.view.meta.superseded_by ? "" : "disabled";
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
  return `<div class="qopts">${options}${radio("other", "Other: answer in a comment", "<span>Other: answer in a comment</span>")}</div>${takenNote(item)}${keptOtherHtml(item)}`;
}

/** Says when an approval took this question's recommended option because nobody picked one. */
function takenNote(item) {
  const rev = state.view.meta.revisions;
  const taken = (state.view.feedback ?? []).some((fb) => fb.revision === rev && fb.answers.some((a) => a.item === item.id && a.recommended));
  return taken ? '<p class="taken">Approved without an answer here, so the recommended option was taken.</p>' : "";
}

/**
 * The reviewer's own words for an Other answer in force on this question, as a message with its
 * author and time, when no comment of that review carries them: an approval of a review opened from
 * a file keeps them in the answer alone. Elsewhere the comment's thread shows them.
 */
function keptOtherHtml(item) {
  const rev = state.view.meta.revisions;
  const all = state.view.feedback ?? [];
  const latest = all.filter((fb) => fb.revision === rev && fb.answers.some((a) => a.item === item.id)).at(-1);
  const answer = latest?.answers.find((a) => a.item === item.id) ?? (state.view.carried ?? []).find((a) => a.item === item.id);
  if (answer?.choice !== "other" || !answer.text) return "";
  const same = (a) => a.item === item.id && a.choice === "other" && a.text === answer.text;
  const fb = latest ?? all.filter((f) => f.answers.some(same)).at(-1);
  if (!fb || fb.comments.some((c) => c.item === item.id && c.body === answer.text)) return "";
  return `<div class="thread kept-answer"><div class="comment"><div class="who">${esc(sentBy(fb))} <span class="role">${esc(readAt(fb.at))}</span></div><div>${esc(answer.text)}</div></div></div>`;
}

/** A line's text: a diagram, or its markdown; the Changes tab (`diff`) shows both as written. */
function lineTextHtml(item, t, i, diff) {
  if (!diff && isDiagram(t)) return diagramHtml(t, { revision: state.view.meta.revisions, item: item.id, line: i + 1 });
  return renderLine(t, decorations(item, i), diff ? undefined : item.blocks?.[i]);
}

/** One line of an item, with its gutter, its option's radio button and what the hooks put after it. */
function lineHtml(item, t, i, { diff, prev, options }) {
  const cls = diff && !prev?.lines.includes(t) ? "add" : "";
  const choice = options.get(i);
  const pick = choice ? `<span class="qpick">${radioHtml(item, choice.id, `${choice.id}) ${choice.label}`)}</span>` : "";
  return `<div class="line ${cls}${choice ? " option" : ""}"><div class="gutter">${hooks.line.map((h) => h(item, i, "gutter")).join("")}${i + 1}</div><div class="text" data-sel-item="${esc(item.id)}" data-sel-line="${i}">${pick}${lineTextHtml(item, t, i, diff)}</div>${diff ? "" : hooks.line.map((h) => h(item, i, "end") || "").join("")}</div>${hooks.line.map((h) => h(item, i, "below") || "").join("")}`;
}

/** An item's lines, a run of table lines as one table, after the lines the compared revision had and this one doesn't. */
function linesHtml(item, { diff, prev, options }) {
  const removed = diff && prev ? prev.lines.filter((l) => !item.lines.includes(l)) : [];
  // The Changes tab shows lines as written, so a change to markup alone stays visible.
  const prevBlock = (t) => prev?.blocks?.[prev.lines.indexOf(t)];
  let lines = "";
  for (let i = 0; i < item.lines.length; ) {
    // A run of table lines shows as one table; the Changes tab shows lines as written.
    let end = i;
    while (!diff && item.blocks?.[end]?.kind === "table") end++;
    if (end - i >= 2) {
      lines += tableHtml(item, i, end);
      i = end;
    } else lines += lineHtml(item, item.lines[i], i++, { diff, prev, options });
  }
  return `<div class="lines${diff ? " raw" : ""}">${removed.map((t) => `<div class="line del"><div class="gutter">−</div><div class="text">${renderLine(t, [], diff ? undefined : prevBlock(t))}</div></div>`).join("")}${lines}</div>`;
}

/** An item's body: a structured question's answers, or its lines, with Other after a markdown question's options. */
function itemBody(item, prev, diff) {
  if (item.type === "question") return `<div class="qbox" role="radiogroup" aria-label="${esc(item.title)}">${answerHtml(item, true)}</div>`;
  const options = !diff && item.choices?.length ? optionLines(item) : new Map();
  const lines = linesHtml(item, { diff, prev, options });
  return options.size ? `<div class="qbox" role="radiogroup" aria-label="${esc(item.title)}">${lines}${answerHtml(item, false)}</div>` : lines;
}

function renderItem(item, changed) {
  const prev = previousItems(state.view).get(item.id);
  const diff = state.tab === "changes" && changed;
  const body = itemBody(item, prev, diff);
  // A viewed item stays collapsed unless the reviewer jumped to one of its lines.
  // A nested section sits inside its parent, indented by its depth under the title.
  const renamed = state.view.renamed?.[item.id];
  return `<article class="item ${state.viewed[item.id] && !state.open[item.id] ? "collapsed" : ""}${hooks.item.map((h) => h(item, "class")).join("")}" id="item-${esc(item.id)}" style="--depth:${depthOf(item) - 1}">
    <div class="item-head commentable">${isDoc() ? "" : `<span class="id">${esc(item.id)}</span>`}<span class="t">${commentable(item, -1, item.title)}</span>${renamed ? `<span class="renamed">renamed from “${esc(renamed)}”</span>` : ""}${hooks.item.map((h) => h(item, "head")).join("")}
      ${item.risk ? `<span class="risk ${item.risk}">risk: ${item.risk}</span>` : ""}${changed ? '<span class="chg">changed</span>' : ""}
      <label><input type="checkbox" id="viewed-${esc(item.id)}" data-viewed="${esc(item.id)}" ${state.viewed[item.id] ? "checked" : ""}> Viewed</label></div>${below(item, -1)}${body}</article>`;
}

// Home's sections: every review that isn't approved is pending; approved, closed and superseded ones are completed.
const SECTIONS = [
  ["pending", "Pending"],
  ["completed", "Completed"],
];
const sectionOf = (m) => (["approved", "answered", "withdrawn", "closed"].includes(m.status_key) || m.superseded_by ? "completed" : "pending");
/** Each section's usual statuses, which its rows don't repeat: Pending awaits review; Completed is approved or answered, and its pull requests merged. */
const USUAL = { pending: new Set(["awaiting_review"]), completed: new Set(["approved", "answered"]) };

/** Pull request states that no longer change: merged, closed, or gone from GitHub. */
const PR_SETTLED = new Set(["merged", "closed", "gone"]);

/** A pull request's state badges: merged, closed or gone, else its checks, conflicts, a review asked of you and readiness. */
function prBadges(p) {
  if (p.state !== "open") return [PR_SETTLED.has(p.state) ? p.state : "unknown"];
  return [
    p.checks && p.checks !== "none" ? `checks_${p.checks}` : "",
    p.conflicts ? "conflicts" : "",
    p.review_requested ? "review_requested" : "",
    p.ready ? "ready" : "",
  ].filter(Boolean);
}
/** A status a row doesn't show because its section implies it, still read out to screen readers. */
const usualHtml = (label) => `<span class="visually-hidden">${esc(label)}</span>`;
const prBadgesHtml = (p) =>
  prBadges(p)
    .map((k) => (k === "merged" ? usualHtml(PR.merged.label) : statusBadge(k, PR)))
    .join("");
const prSection = (p) => (PR_SETTLED.has(p.state) ? "completed" : "pending");

/** A Home group's key: the owning session's ID, "opened" for every file a person opened, or "" for neither. */
const groupKey = (m) => m.session?.id ?? (m.opened_by ? "opened" : "");

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

/**
 * Home's state: the reviews, tracked pull requests and action items it shows, the session being
 * renamed (`section:session`), and the action item whose Won't do reason is being written.
 */
const home = {
  shown: false,
  list: [],
  prs: [],
  actions: [],
  // A newer hoop, as Home last loaded it (updateHtml).
  update: undefined,
  // Your response times, per kind, from /api/loop-time (src/loop-time.ts).
  loop: [],
  renaming: null,
  error: "",
  // Why Open a sample review didn't open, under the button until the next press.
  sampleError: "",
  declining: null,
  declineError: "",
  // The action item the person just marked done, `{ id, title, error }`, which Undo opens again.
  undone: null,
  // A refused Done, `{ id, error }`, on the error line under the item's buttons until the next attempt.
  doneError: null,
  focus: null,
  closing: null,
  closeReason: "",
  closeError: "",
  closeBusy: false,
};

/**
 * A review's Close on its Home row, beside the row's link, or its confirmation in place with an
 * optional reason while it is open; nothing for a review the person can't close.
 */
function rowCloseHtml(m) {
  if (!closable(m, m.ask)) return "";
  const id = esc(m.id);
  if (home.closing !== m.id)
    return `<button type="button" class="btn small row-close" data-close-review="${id}" aria-label="Close: ${esc(plainText(m.title))}">Close</button>`;
  return closeFormHtml(
    `${id}-close`,
    `class="steer-form row-confirm" data-close-form="${id}"`,
    "data-close-cancel",
    home.closeReason,
    home.closeError,
    fromFile({ meta: m }),
  );
}

/** What closes an action item, by its check. */
const DONE_WHEN = {
  pr_merged: "done when it merges",
  review_approved: "done when you approve it",
  npm_version: "done when it is published",
  manual: "press Done when you have",
};

/** Opens a link to another site, such as a pull request, in a new tab, so Home stays open. */
const NEW_TAB = ' target="_blank" rel="noopener noreferrer"';

/** Why a pull request an open action item waits on can't merge now, and when to press Won't do. */
const PR_CANT_MERGE = {
  closed: "the pull request was closed without merging; press Won't do if it won't be reopened",
  gone: "the pull request no longer exists on GitHub; press Won't do to clear it",
};

/** An action item's state in words: when it was added and what closes it, or how and when it closed. */
function actionStateText(a) {
  // A close Claude's session wasn't told of, with messages into a session off.
  if (a.state !== "open" && a.delivery === "off") return `${closedText(a)} · ${MESSAGES_OFF}`;
  return closedText(a);
}

/** An action item's state and when, as its row says it. */
function closedText(a) {
  if (a.state === "done") return a.closed_by === "hoop" ? `hoop saw it done ${readAt(a.closed_at)}` : `marked done ${readAt(a.closed_at)}`;
  if (a.state === "wont_do") return `won't do (${readAt(a.closed_at)}): ${a.reason}`;
  if (a.state === "withdrawn") return `withdrawn (${readAt(a.closed_at)}): ${a.reason}`;
  if (a.pr_state) return `added ${readAt(a.created)} · ${PR_CANT_MERGE[a.pr_state]}`;
  return `added ${readAt(a.created)} · ${DONE_WHEN[a.kind] ?? ""}`;
}

/**
 * An action item on Home: its title, description, link, the session that added it and its state; an
 * open one has Won't do, and Done when only the person can tell it is done. `h` is its heading level.
 */
function actionHtml(a, h) {
  const id = esc(a.id);
  const external = a.link && !a.link.href.startsWith("/");
  const link = a.link ? `<a href="${esc(a.link.href)}"${external ? NEW_TAB : ""}>${esc(a.link.text)}</a> · ` : "";
  const open = a.state === "open";
  const writing = open && home.declining === a.id;
  const buttons =
    open && !writing
      ? `<div class="action-btns">${a.kind === "manual" ? `<button type="button" class="btn small primary" data-action-done="${id}">Done</button>` : ""}<button type="button" class="btn small" data-action-decline="${id}" aria-label="Won't do: ${esc(a.title)}">Won't do</button></div>${doneErrorHtml(a.id)}`
      : "";
  const form = writing
    ? `<form class="decline" data-decline-form="${id}"><label for="${id}-reason">Why won't you do it?</label><input id="${id}-reason" name="reason" maxlength="200" autocomplete="off" aria-describedby="${id}-err"><button type="submit" class="btn small primary">Send</button><button type="button" class="btn small" data-decline-cancel>Cancel</button><p id="${id}-err" class="rename-error" role="alert">${esc(home.declineError)}</p></form>`
    : "";
  return `<article class="action${open ? "" : " closed"}" data-action="${id}" aria-labelledby="${id}-t"><div class="action-head"><h${h} id="${id}-t" class="t">${esc(a.title)}</h${h}>${statusBadge(a.state, ACTION)}</div><p class="d">${a.description
    .split("\n")
    .map(esc)
    .join("<br>")}</p><p class="m">${link}from ${esc(a.session.label)} · ${esc(actionStateText(a))}</p>${buttons}${form}</article>`;
}

/** The error line under an action item's buttons, while its Done was refused. */
const doneErrorHtml = (id) => (home.doneError?.id === id ? `<p class="rename-error" role="alert">${esc(home.doneError.error)}</p>` : "");

/** Home's first section: the open action items, newest first. */
function waitingHtml() {
  const open = home.actions.filter((a) => a.state === "open");
  // Claude Code's permission prompts: each waiting one, and an answered one's note for a while.
  const asks = prompts();
  const waiting = asks.filter((p) => p.state === "waiting").length;
  const perms = asks.map((p) => promptHtml(p, 3, p.session_label)).join("");
  const undo = undoneHtml();
  if (!open.length && !waiting && !undo && !perms) return "";
  // Holding only the Undo line after Done on its last item, or answered prompts' notes: its name, with no count and no fold.
  if (!open.length && !waiting)
    return `<section class="group" aria-labelledby="g-waiting"><h2 id="g-waiting">Waiting on you</h2><div id="g-waiting-body">${perms}${undo}</div></section>`;
  const key = "home:waiting";
  return `<section class="group" aria-labelledby="g-waiting"><h2 id="g-waiting">${foldButton(key, "g-waiting-body", foldCount("Waiting on you", open.length + waiting))}</h2><div ${foldBody(key, "g-waiting-body")}>${perms}${undo}${open.map((a) => actionHtml(a, 3)).join("")}</div></section>`;
}

/** What a folded session's reviews are, as "2 awaiting review · 1 approved". */
const reviewTally = (rows) => [...tally(rows, REVIEW, (m) => !m.superseded_by && m.status_key), [rows.filter((m) => m.superseded_by).length, "replaced"]];

/**
 * A session's heading on Home: a disclosure button with its name, a pencil to rename it, short ID,
 * the folder it worked in, and whether it runs. `fold` is the key and body ID its button folds.
 */
function sessionHead(section, s, place, n, fold, summary, openedBy) {
  const id = `s-${section}-${n}`;
  const toggle = (name) => foldButton(fold.key, fold.body, esc(name), "session");
  if (!s) return `<div class="session-head"><h3 id="${id}">${toggle(openedBy ? OPENED_BY_YOU : "No session")}</h3>${summary}</div>`;
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
  const closed = home.actions.filter((a) => a.state !== "open");
  // A quick question shows how many of its questions wait for an answer in place of its revision.
  const count = (m) => {
    if (!m.ask) return `<span class="rev">rev ${m.revisions}</span>`;
    return m.ask.unanswered ? `<span class="rev">${m.ask.unanswered} of ${m.ask.questions} unanswered</span>` : "";
  };
  // A row shows its status only where it differs from its section's usual one.
  const status = (m) => {
    const key = m.superseded_by ? "superseded" : m.status_key;
    return USUAL[sectionOf(m)].has(key) ? usualHtml(REVIEW[key].label) : statusBadge(key);
  };
  // A row is its link and, beside it, never inside it, the review's Close.
  const row = (m) =>
    `<div class="list-row"><a class="row" href="${esc(reviewPath(m.id))}"><span class="t fmt">${titleHtml(m.title)}</span>${m.sample ? '<span class="tag-sample">Sample</span>' : ""}${count(m)}${status(m)}${m.unread ? statusBadge(m.not_sent ? "not_sent" : "unread", READ) : ""}${m.summary && m.summary !== m.title ? `<span class="s" title="${esc(m.summary)}">${esc(m.summary)}</span>` : ""}<span class="m">updated ${esc(readAt(m.updated))}</span></a>${rowCloseHtml(m)}</div>`;
  const prRow = (p) =>
    `<div class="list-row"><a class="row pr" href="${esc(p.url)}"${NEW_TAB}><span class="t">${esc(p.title || `${p.repo}#${p.number}`)}</span>${p.title ? `<span class="rev">${esc(p.repo)}#${p.number}</span>` : ""}${prBadgesHtml(p)}${p.summary ? `<span class="s" title="${esc(p.summary)}">${esc(p.summary)}</span>` : ""}<span class="m">pull request opened by ${esc(p.owner)}</span></a></div>`;
  // A permission prompt waits on the person like an open action item.
  const asks = prompts();
  if (!list.length && !prs.length && !home.actions.length && !asks.length) return startHtml();
  // Until a real review comes, Home keeps offering the sample: one finished with (approved or closed) isn't one.
  const start = !prs.length && !home.actions.length && !asks.length && list.every(finishedSample);
  // The server lists reviews newest first, so each section and each session keeps that order;
  // pull requests follow the sessions, newest first. With nothing open, one line says so above Completed.
  const clear =
    !home.actions.some((a) => a.state === "open") &&
    !asks.length &&
    !list.some((m) => sectionOf(m) === "pending") &&
    !prs.some((p) => prSection(p) === "pending");
  return (
    topHtml(start, clear) +
    SECTIONS.map(([key, label]) => {
      const rows = list.filter((m) => sectionOf(m) === key);
      const prRows = prs.filter((p) => prSection(p) === key).map(prRow);
      // Closed action items fold into Completed, in a group of their own.
      const done = key === "completed" ? closed : [];
      if (!rows.length && !prRows.length && !done.length) return "";
      // Each section, session and pull request group folds; the folded state is kept by section and session ID.
      const pf = `home:${key}:prs`;
      const pulls = prRows.length
        ? `<section class="session" aria-labelledby="p-${esc(key)}"><div class="session-head"><h3 id="p-${esc(key)}">${foldButton(pf, `p-${key}-body`, "Pull requests", "session")}</h3>${foldSummary(pf, [[prRows.length, "pull request", "pull requests"]])}</div><div ${foldBody(pf, `p-${key}-body`)}>${prRows.join("")}</div></section>`
        : "";
      const af = `home:${key}:actions`;
      const items = done.length
        ? `<section class="session" aria-labelledby="a-${esc(key)}"><div class="session-head"><h3 id="a-${esc(key)}">${foldButton(af, `a-${key}-body`, "Action items", "session")}</h3>${foldSummary(
            af,
            tally(done, ACTION, (a) => a.state),
          )}</div><div ${foldBody(af, `a-${key}-body`)}>${done.map((a) => actionHtml(a, 4)).join("")}</div></section>`
        : "";
      const sessions = bySession(rows)
        .map((g, n) => {
          const fold = { key: `home:${key}:${g.key || "none"}`, body: `s-${key}-${n}-body` };
          const head = sessionHead(key, g.session, g.rows[0].place, n, fold, foldSummary(fold.key, reviewTally(g.rows)), g.opened_by);
          return `<section class="session" aria-labelledby="s-${esc(key)}-${n}">${head}<div ${foldBody(fold.key, fold.body)}>${g.rows.map(row).join("")}</div></section>`;
        })
        .join("");
      const gf = `home:${key}`;
      return `<section class="group" aria-labelledby="g-${esc(key)}"><h2 id="g-${esc(key)}">${foldButton(gf, `g-${key}-body`, foldCount(esc(label), rows.length + prRows.length + done.length))}</h2><div ${foldBody(gf, `g-${key}-body`)}>${sessions}${pulls}${items}</div></section>`;
    }).join("") +
    responseTimesHtml()
  );
}

/**
 * A newer hoop than these pages run, when the pages process found one: an info callout with its icon,
 * as a new revision's, with the one command that updates and its Copy button. It is read as Home
 * loads (`home.update`), never added to a Home already open, so nothing on the page moves under you.
 */
function updateHtml() {
  const u = home.update;
  if (!u) return "";
  return `<p class="update-notice">${icons.info}<span>hoop ${esc(u.latest)} is available. To update, run <code class="resume">${esc(u.command)}</code></span><button type="button" class="btn small" data-copy="${esc(u.command)}" aria-label="Copy the command ${esc(u.command)}">Copy</button></p>`;
}

/**
 * Home's last section, Your response times, folded by default: one Stat line per kind, its name, then
 * its median with how many answers it is of, in --muted; and a muted closing line. It shows once any
 * request has an answer. The numbers stay on this machine.
 */
function responseTimesHtml() {
  if (!home.loop.some((r) => r.answered)) return "";
  const key = "home:response-times";
  // A duration never breaks across lines ("1 h 17 m"), as readAt writes a time.
  const value = (r) => (r.median_ms === undefined ? "none answered yet" : `${span(r.median_ms).replace(/\s/g, "\u00a0")} median, of ${r.answered}`);
  const lines = home.loop
    .map((r) => `<p class="stat"><span class="stat-name">${esc(r.label)}</span> <span class="stat-value">${esc(value(r))}</span></p>`)
    .join("");
  const note = '<p class="stat-note">From Claude\'s request to your first response. These numbers stay on this machine.</p>';
  return `<section class="group" aria-labelledby="g-response-times"><h2 id="g-response-times">${foldButton(key, "g-response-times-body", "Your response times")}</h2><div ${foldBody(key, "g-response-times-body")}>${lines}${note}</div></section>`;
}

/** Loads Your response times, and shows them when they changed. */
async function loadLoopTime() {
  const rows = await api("/api/loop-time").catch(() => undefined);
  if (!rows || JSON.stringify(rows) === JSON.stringify(home.loop)) return;
  home.loop = rows;
  repaintList();
}

/** What Home shows above its sections: the sample's offer, "Nothing waiting on you", or Waiting on you. */
function topHtml(start, clear) {
  if (start) return startHtml();
  return clear ? '<p class="all-clear">Nothing waiting on you.</p>' : waitingHtml();
}

/** Whether a review is the sample review, finished with: approved or closed. */
const finishedSample = (m) => Boolean(m.sample && (m.closed || m.status === "approved"));

/** What Claude is asked, on Home with no reviews, to send a review to try. */
const SAMPLE_PROMPT = "Send me a short sample review in hoop, with one question for me, so I can try it.";

/**
 * Home with no reviews but finished samples: what will appear here and how, Open a sample review,
 * which opens the sample to try the review page on (src/sample.ts), and a prompt to copy that asks
 * Claude for one.
 */
function startHtml() {
  return `<div class="empty start">
    <p>No reviews yet. Reviews appear here when Claude submits one with hoop_submit, or when you run hoop open on a markdown file.</p>
    <p><button type="button" class="btn primary" id="openSample" aria-describedby="sampleErr">Open a sample review</button></p>
    <p class="rename-error" id="sampleErr" role="alert">${esc(home.sampleError)}</p>
    <p>Or ask Claude for one: <code class="prompt">${esc(SAMPLE_PROMPT)}</code><button type="button" class="btn small" data-copy="${esc(SAMPLE_PROMPT)}" aria-label="Copy the prompt">Copy</button></p>
  </div>`;
}

/** Opens the sample review and goes to it; a refusal shows under the button, which keeps the focus. */
async function openSample() {
  home.sampleError = "";
  try {
    const out = await post("/api/sample", {});
    location.href = reviewPath(out.review_id);
  } catch (err) {
    home.sampleError = `The sample review didn't open: ${err.message}. Try again.`;
    home.focus = "sel:#openSample";
    paintList();
  }
}

document.addEventListener("click", (e) => {
  if (e.target.closest?.("button")?.id === "openSample") openSample();
});

function paintList() {
  dropStaleClose();
  document.title = "Home · hoop";
  const was = focusSpot(app);
  app.innerHTML = frame(
    "home",
    `<div class="list"><header class="list-head"><h1>Home</h1>${notifyHtml()}${tipsSwitchHtml()}${home.list.length || home.prs.length || home.actions.length ? foldAllHtml() : ""}</header>${updateHtml()}${listHtml()}</div>`,
    state.info,
  );
  const focus = home.focus;
  home.focus = null;
  if (focus === "input") $(".rename input, .decline input")?.focus();
  else if (focus?.startsWith("sel:")) $(focus.slice(4))?.focus();
  else if (focus?.startsWith("href:")) [...document.querySelectorAll(".list a")].find((a) => a.getAttribute("href") === focus.slice(5))?.focus();
  else if (focus) $(`[data-rename="${CSS.escape(focus)}"]`)?.focus();
  regainFocus(app, was);
}

async function renderList() {
  home.list = await api("/api/reviews");
  // A newer hoop shows as Home loads, from the info the pages last gave; a later one waits for the next load.
  home.update = state.info?.update;
  home.shown = true;
  paintList();
  loadLoopTime();
  void loadPermissions();
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
  // Drafts for what has ended go, whichever page learns of it.
  sweepKept(list);
  const shown = state.view && !state.view.build && list.find((m) => m.id === state.view.meta.id);
  if (shown) {
    noticeRevision(shown.revisions);
    noticeEnded(shown);
    noticeChange(shown);
  }
  if (!home.shown || JSON.stringify(list) === JSON.stringify(home.list)) return;
  home.list = list;
  repaintList();
  // A review answered or sent changes the response times.
  loadLoopTime();
}

let noticing = false;
/**
 * A review replaced, or a quick question Claude withdrew, while its page is open: shows it as the
 * server has it now, and the live region says the note once. A page that loads with it says nothing.
 */
async function noticeEnded(m) {
  const v = state.view;
  const replaced = m.superseded_by && !v.meta.superseded_by;
  const withdrawn = v.ask && m.ask?.state === "withdrawn" && v.ask.state !== "withdrawn";
  if (noticing || (!replaced && !withdrawn)) return;
  noticing = true;
  try {
    const now = await api(`/api/reviews/${encodeURIComponent(v.meta.id)}`).catch(() => undefined);
    if (!now || state.view !== v) return;
    await show(now);
    const note = $("[data-ended]")?.textContent.trim();
    if (note) announce(note);
  } finally {
    noticing = false;
  }
}

/**
 * Whether the person is in the middle of something a refresh must wait for (Refreshing): writing a
 * comment or reply, the verdict panel or the close confirmation open, typing in a box, or text
 * selected on the page, where a comment starts.
 */
function midWork() {
  if ($("#cbody, #finishPop:not([hidden]), #closeReason, .ask-other, dialog[open]")) return true;
  if (document.activeElement?.matches?.("textarea, input:not([type=checkbox], [type=radio], [type=button])")) return true;
  const sel = getSelection();
  return Boolean(sel && !sel.isCollapsed && app.contains(sel.anchorNode));
}

/**
 * The view the page last refreshed to, and when the reviews list said the review last changed then. A
 * reply, a review, a proposed edit, or a quick question on one of its lines changes it (src/store.ts).
 */
const heard = { view: null, stamp: null, busy: false };

/** A node's key, for matching it across a redraw: its ID, its line, or the diagram it is or holds. */
function keyOf(n) {
  if (n.nodeType !== 1) return null;
  if (n.id) return `#${n.id}`;
  if (n.dataset.selItem !== undefined) return `line:${n.dataset.selItem}:${n.dataset.selLine}`;
  if (n.dataset.thread) return `thread:${n.dataset.thread}`;
  // A line's row is its line, and a conversation's buttons follow its comments, so a reply or a new
  // conversation goes in among them and they stay.
  const line = n.classList.contains("line") && n.querySelector(":scope > [data-sel-item]");
  if (line) return `row:${keyOf(line)}`;
  if (n.classList.contains("thread-actions")) return "thread-actions";
  const d = n.matches(".diagram[data-diagram-source]") ? n : n.querySelector(".diagram[data-diagram-source]");
  return d ? `diagram:${d.dataset.diagramSource}` : null;
}

/** Gives `old` the attributes, and a field's state, that `next` has. */
function syncAttributes(old, next) {
  for (const { name } of [...old.attributes]) if (!next.hasAttribute(name)) old.removeAttribute(name);
  for (const { name, value } of next.attributes) if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  if (old instanceof HTMLInputElement) old.checked = next.checked;
  const field = old instanceof HTMLTextAreaElement || old instanceof HTMLInputElement;
  if (field && old.value !== next.value) old.value = next.value;
}

/**
 * Makes `old` read as `next` while keeping every node that stays: a node keeps its place, focus and
 * frame, and only what changed is added, removed or rewritten. A drawn diagram whose source is the
 * same isn't touched, since a frame taken out of the page has to draw again.
 */
function patch(old, next) {
  if (old.nodeType !== 1) {
    if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue;
    return;
  }
  if (old.matches(".diagram[data-mounted]") && old.dataset.diagramSource === next.dataset.diagramSource) return;
  syncAttributes(old, next);
  morphChildren(old, [...next.childNodes]);
}

/** Whether `old` can become `next` in place: the same kind of node, with the same key. */
const alike = (old, next) => old.nodeType === next.nodeType && old.nodeName === next.nodeName && keyOf(old) === keyOf(next);

/** Removes the nodes from `at` up to `end` (or to the last), and returns `end`. */
function removeUntil(at, end = null) {
  let n = at;
  while (n && n !== end) {
    const after = n.nextSibling;
    n.remove();
    n = after;
  }
  return end;
}

/**
 * The old child that `next` becomes: `at` when they match, else, for a keyed node, a match further on,
 * once the children before it are gone (it stays where it is, so a frame in it isn't reloaded).
 */
function matchFor(at, next) {
  if (!at) return null;
  if (alike(at, next)) return at;
  if (!keyOf(next)) return null;
  let n = at.nextSibling;
  while (n && !alike(n, next)) n = n.nextSibling;
  return n ? removeUntil(at, n) : null;
}

/** Puts `nodes` into `parent` in place of its children, keeping and patching each child that matches. */
function morphChildren(parent, nodes) {
  let at = parent.firstChild;
  for (const next of nodes) {
    const match = matchFor(at, next);
    if (match) {
      patch(match, next);
      at = match.nextSibling;
    } else parent.insertBefore(next, at);
  }
  removeUntil(at);
}

/** Morphs `root`'s contents into `html`. */
function morph(root, html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  morphChildren(root, [...t.content.childNodes]);
}

/** The first document line in view, and how far it sits from the top of the window. */
function inView() {
  // In the page body: the header's title stays in view as the page scrolls.
  for (const el of app.querySelectorAll("main [data-sel-item][data-sel-line]")) {
    const { top, bottom } = el.getBoundingClientRect();
    if (bottom > 0) return { el, key: keyOf(el), top };
  }
  return null;
}

/** Scrolls so the line `spot` names sits where it was, whatever arrived above it. */
function keepInView(spot) {
  if (!spot) return;
  const el = spot.el.isConnected ? spot.el : [...app.querySelectorAll("main [data-sel-item][data-sel-line]")].find((x) => keyOf(x) === spot.key);
  if (el) scrollBy(0, el.getBoundingClientRect().top - spot.top);
}

/** A place as the live region says it, with the section's name in curly quotes as the build page has them. */
const curly = (place) => place?.replace(/"([^"]*)"/g, "“$1”");

/** The words for one kind of new thing Claude added, at `places`: none, one with its place, or a count. */
function addedSaid(places, one, many) {
  if (!places.length) return "";
  if (places.length > 1) return many(places.length);
  return places[0] ? `${one} on ${curly(places[0])}.` : `${one}.`;
}

/**
 * What the live region says for what Claude added that `now` has and `was` didn't: replies, by
 * conversation, edits it proposed and quick questions it asked beside a line. None for nothing new.
 */
function changesSaid(was, now) {
  const fresh = (list, key) => {
    const seen = new Set(list(was).map(key));
    return list(now).filter((x) => !seen.has(key(x)));
  };
  const threads = [
    ...new Set(
      fresh(
        (v) => v.replies ?? [],
        (r) => JSON.stringify(r),
      ).map((r) => r.thread),
    ),
  ];
  const edits = fresh(
    (v) => (v.edits ?? []).filter((e) => e.status === "proposed"),
    (e) => e.id,
  );
  const asks = fresh(
    (v) => v.asks ?? [],
    (a) => a.id,
  );
  return [
    addedSaid(
      threads.map((t) => hooks.threadPlace?.(t)),
      "Claude replied",
      (n) => `Claude replied in ${n} conversations.`,
    ),
    addedSaid(
      edits.map((e) => hooks.linePlace?.(e.item, e.line)),
      "Claude proposed an edit",
      (n) => `Claude proposed ${n} edits.`,
    ),
    addedSaid(
      asks.map((a) => hooks.linePlace?.(a.anchor.item, a.anchor.line)),
      "Claude asked a quick question",
      (n) => `Claude asked ${n} quick questions.`,
    ),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Claude's replies, proposed edits and anchored questions while a review's page is open, and
 * anything else that changed without a new revision: the page shows the review as it is now, in
 * place (Refreshing), and the live region says a reply. It reads the review only when the list says
 * it changed and the tab is in view, and waits while the person is in the middle of something.
 */
async function noticeChange(m) {
  const v = state.view;
  if (v.ask || v.meta.closed || v.meta.superseded_by || m.superseded_by || m.revisions !== v.meta.revisions) return;
  const stamp = m.updated;
  // A page that just loaded takes the list as it finds it, unless the review changed since its read.
  if (heard.view !== v) Object.assign(heard, { view: v, stamp: m.updated === v.meta.updated ? stamp : null });
  if (stamp === heard.stamp || heard.busy || document.visibilityState !== "visible" || midWork()) return;
  heard.busy = true;
  try {
    const now = await api(`/api/reviews/${encodeURIComponent(v.meta.id)}`).catch(() => undefined);
    if (!now || state.view !== v || now.meta.revisions !== v.meta.revisions || midWork()) return;
    const said = [changesSaid(v, now)];
    const spot = inView();
    state.live = { said };
    try {
      await show(now);
    } finally {
      state.live = null;
    }
    // What the person reads stays put, though a reply or a card arrived above it.
    keepInView(spot);
    Object.assign(heard, { view: now, stamp });
    // One message, so what the refresh changed in the verdict isn't said over by the reply.
    const words = said.filter(Boolean).join(" ");
    if (words) announce(words);
  } finally {
    heard.busy = false;
  }
}

/** Shows a newer list of action items on Home, when it changed. */
// Home shows the permission prompts again when they change, or after an answer.
onPermissions((local) => home.shown && location.pathname === "/" && (local ? paintList() : repaintList()));

function showActions(items) {
  // Home's regular ask for action items asks for the permission prompts too.
  if (home.shown) void loadPermissions();
  if (JSON.stringify(items) === JSON.stringify(home.actions)) return;
  home.actions = items;
  if (!home.shown) return;
  repaintList();
  // An item done or declined, here or elsewhere, changes the response times.
  loadLoopTime();
}

/** Forgets a row's open Close confirmation once its review can't be closed any more, as when it was answered or closed elsewhere. */
function dropStaleClose() {
  if (home.closing && !home.list.some((m) => m.id === home.closing && closable(m, m.ask)))
    Object.assign(home, { closing: null, closeReason: "", closeError: "" });
}

function repaintList() {
  dropStaleClose();
  // A refresh while a session is being renamed, or a Won't do, Close or Deny reason written, waits for the form to close, so it doesn't drop the typed text.
  if (home.renaming || home.declining || home.closing || permissionFormOpen()) return;
  // A refresh keeps focus on the same link or disclosure button.
  const active = document.activeElement;
  const href = active?.closest?.(".list a")?.getAttribute("href");
  if (href) home.focus = `href:${href}`;
  else if (active?.dataset?.collapse) home.focus = `sel:[data-collapse="${CSS.escape(active.dataset.collapse)}"]`;
  else if (active?.dataset?.collapseAll) home.focus = `sel:[data-collapse-all="${active.dataset.collapseAll}"]`;
  else if (active?.id === "notifyMe") home.focus = "sel:#notifyMe";
  else if (active?.dataset?.rename) home.focus = active.dataset.rename;
  else if (active?.dataset?.actionDone) home.focus = `sel:[data-action-done="${active.dataset.actionDone}"]`;
  else if (active?.dataset?.actionDecline) home.focus = `sel:[data-action-decline="${active.dataset.actionDecline}"]`;
  else if (active?.dataset?.closeReview) home.focus = `sel:[data-close-review="${CSS.escape(active.dataset.closeReview)}"]`;
  paintList();
}

/**
 * Closes an action item from Home (`done`, or `wont_do` with a reason) and shows the items again,
 * with focus on the next open item, else on Completed. Returns the refusal's message, if any.
 */
async function closeAction(id, body) {
  const title = home.actions.find((a) => a.id === id)?.title ?? "";
  try {
    await post(`/api/actions/${encodeURIComponent(id)}`, body);
  } catch (err) {
    return err.message;
  }
  home.actions = await api("/api/actions").catch(() => home.actions);
  loadLoopTime();
  home.declining = null;
  home.declineError = "";
  // Right after Done, Undo opens the item again; it goes with the next action.
  home.undone = body.action === "done" && title ? { id, title, error: "" } : null;
  if (home.undone) announce(`Marked “${title}” done. Undo opens it again.`);
  const next = home.actions.find((a) => a.state === "open");
  const after = home.undone ? "sel:[data-action-reopen]" : 'sel:[data-collapse="home:completed"]';
  home.focus = next ? `sel:[data-action="${next.id}"] button` : after;
  paintList();
  return "";
}

/** Done on an action item; a refusal shows under its buttons, with focus kept on Done. */
async function markDone(id) {
  home.doneError = null;
  const error = await closeAction(id, { action: "done" });
  if (!error) return;
  home.doneError = { id, error };
  home.focus = `sel:[data-action-done="${CSS.escape(id)}"]`;
  paintList();
}

/** Undo after Done: the item is open again and Claude is told; focus goes to its Done. A refusal shows under Undo. */
async function reopenAction(id) {
  const u = home.undone;
  // A second press while the first runs sends nothing.
  if (!u || u.id !== id || u.busy) return;
  u.busy = true;
  let told = "Claude is told.";
  try {
    const item = await post(`/api/actions/${encodeURIComponent(id)}`, { action: "reopen" });
    if (item?.delivery === "off") told = `${MESSAGES_OFF}.`;
  } catch (err) {
    home.undone = { ...u, busy: false, error: err.message };
    home.focus = "sel:[data-action-reopen]";
    return paintList();
  }
  const { title } = u;
  home.undone = null;
  home.actions = await api("/api/actions").catch(() => home.actions);
  loadLoopTime();
  announce(`Opened “${title}” again. ${told}`);
  home.focus = `sel:[data-action-done="${CSS.escape(id)}"]`;
  paintList();
}

/** Right after Done: which item, and Undo, which opens it again; then Undo's error line. */
function undoneHtml() {
  const u = home.undone;
  if (!u) return "";
  return `<p class="undo-line">Marked “${esc(u.title)}” done.<button type="button" class="btn small" data-action-reopen="${esc(u.id)}" aria-label="Undo: open “${esc(u.title)}” again" aria-describedby="undo-err">Undo</button></p><p id="undo-err" class="rename-error" role="alert">${esc(u.error)}</p>`;
}

/** The focus target for a row's Close reason box. */
const closeReasonFocus = (id) => `sel:#${CSS.escape(`${id}-closeReason`)}`;

/** Opens a review's Close confirmation on its Home row, with focus in its reason box. */
function openRowClose(id) {
  Object.assign(home, { closing: id, closeReason: "", closeError: "", focus: closeReasonFocus(id) });
  paintList();
}

/** Closes a review's Close confirmation on Home and puts focus back on its Close. */
function cancelRowClose() {
  home.focus = `sel:[data-close-review="${CSS.escape(home.closing)}"]`;
  Object.assign(home, { closing: null, closeReason: "", closeError: "" });
  paintList();
}

/** The row link after a review's row on Home, else the one before it, as a focus target; Completed's heading when it was the last. */
function nextRowFocus(id) {
  const links = [...document.querySelectorAll("#g-pending-body .list-row > a.row")].filter((a) => a.checkVisibility());
  const at = links.findIndex((a) => a.getAttribute("href") === reviewPath(id));
  const next = links[at + 1] ?? links[at - 1];
  return next ? `href:${next.getAttribute("href")}` : 'sel:[data-collapse="home:completed"]';
}

/**
 * Closes a review from its Home row, without approving it: the row moves to Completed, focus goes
 * to the next row and screen readers hear what happened. A refusal shows in the confirmation.
 * The confirmation stays open until the list is fetched again, so no refresh repaints in between.
 */
async function closeFromHome(id) {
  // A second Enter or click while the first request runs sends nothing.
  if (home.closeBusy) return;
  home.closeBusy = true;
  // Undo after Done is for right after it: the next change on Home ends it.
  home.undone = null;
  const title = plainText(home.list.find((m) => m.id === id)?.title ?? id);
  try {
    await post(`/api/reviews/${encodeURIComponent(id)}/close`, { reason: home.closeReason.trim() });
  } catch (err) {
    Object.assign(home, { closeError: err.message, focus: closeReasonFocus(id) });
    paintList();
    home.closeBusy = false;
    return;
  }
  const list = await api("/api/reviews").catch(() => undefined);
  home.focus = nextRowFocus(id);
  Object.assign(home, { closing: null, closeReason: "", closeError: "", closeBusy: false });
  if (list) home.list = list;
  paintList();
  announce(`Closed “${title}” without approving it.${list ? " It's under Completed." : ""}`);
}

/** Closes the Won't do form and puts focus back on its button. */
function closeDecline() {
  home.focus = `sel:[data-action-decline="${home.declining}"]`;
  home.declining = null;
  home.declineError = "";
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
  home.undone = null;
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

document.addEventListener("submit", async (e) => {
  const decline = e.target.closest?.("[data-decline-form]");
  if (decline) {
    e.preventDefault();
    const input = decline.querySelector("input");
    const error = await closeAction(decline.dataset.declineForm, { action: "wont_do", reason: input.value });
    if (!error) return;
    home.declineError = error;
    decline.querySelector(".rename-error").textContent = error;
    input.setAttribute("aria-invalid", "true");
    input.focus();
    return;
  }
  const closeForm = e.target.closest?.("[data-close-form]");
  if (closeForm) {
    e.preventDefault();
    closeFromHome(closeForm.dataset.closeForm);
    return;
  }
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
  if (e.key === "Escape" && e.target.closest?.("#closeForm")) {
    e.preventDefault();
    cancelClose();
  }
  if (e.key === "Escape" && e.target.closest?.("[data-decline-form]")) {
    e.preventDefault();
    closeDecline();
  }
  if (e.key === "Escape" && e.target.closest?.("[data-close-form]")) {
    e.preventDefault();
    cancelRowClose();
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
  if (t?.dataset.actionDone) markDone(t.dataset.actionDone);
  if (t?.dataset.actionReopen) reopenAction(t.dataset.actionReopen);
  if (t?.dataset.actionDecline) {
    home.declining = t.dataset.actionDecline;
    home.declineError = "";
    home.focus = "input";
    paintList();
  }
  if (t?.hasAttribute("data-decline-cancel")) closeDecline();
  const fold = t && home.shown && foldClick(t, app);
  if (fold) {
    home.focus = `sel:${fold}`;
    paintList();
  }
  if (t?.dataset.copy) copy(t);
  if (t?.id === "showRevision") showRevision();
});
document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (t?.dataset.closeReview) openRowClose(t.dataset.closeReview);
  if (t?.hasAttribute("data-close-cancel")) cancelRowClose();
  const id = t?.id;
  if (id === "closeReview") {
    Object.assign(closing, { open: true, error: "" });
    paintView("#closeReason");
  }
  if (id === "cancelClose") cancelClose();
});

/** Closes the confirmation and puts focus back on Close. */
function cancelClose() {
  Object.assign(closing, { open: false, reason: "", error: "" });
  paintView("#closeReview");
}
document.addEventListener("submit", (e) => {
  if (e.target.id !== "closeForm") return;
  e.preventDefault();
  closeShown($("#closeReason").value.trim());
});
document.addEventListener("input", (e) => {
  if (e.target.id === "closeReason") closing.reason = e.target.value;
  else if (e.target.closest?.("[data-close-form]")) home.closeReason = e.target.value;
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
  return show(await api(`/api/reviews/${id}`));
}

/** Shows a review's view as the server sent it, such as in a submit's answer; true when it is a review. */
export async function show(view) {
  state.view = view;
  if (state.view.ask) {
    hooks.renderAsk();
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
  agentTimer = setInterval(askAgent, window.HOOP_AGENT_MS ?? 10_000);
  document.addEventListener("visibilitychange", askAgent);
}

/** Asks what the agent is doing, and updates the header's agent line when that changed. */
async function askAgent() {
  const v = state.view;
  if (!v || document.visibilityState !== "visible" || v.meta.status !== "open") return;
  const { agent } = await api(`/api/reviews/${v.meta.id}/agent`).catch(() => ({ agent: v.agent }));
  if (state.view !== v || JSON.stringify(agent ?? null) === JSON.stringify(v.agent ?? null)) return;
  v.agent = agent ?? undefined;
  showAgent();
}

/** Puts the agent state the review header shows into its line, leaving the rest of the page alone. */
function showAgent() {
  const el = $(".agent-state");
  if (!el || !state.view) return;
  const agent = shownAgent();
  const inner = agentInner(agent);
  // The line's words, as the live region says them: an unchanged line isn't written or said again.
  const before = agentSaid ?? lineWords(el);
  const words = agent ? lineWords(Object.assign(document.createElement("div"), { innerHTML: inner })) : "";
  if (el.dataset.agent === (agent?.state ?? "") && words === before) return;
  el.dataset.agent = agent?.state ?? "";
  el.hidden = !agent;
  el.innerHTML = inner;
  if (words && words !== before) announce(words);
  agentSaid = words;
}

/** The agent line's words last shown, which the live region said; undefined until it first changes. */
let agentSaid;

/** The agent line's words in one line, without its Copy button's, which is a control, not news. */
function lineWords(el) {
  if (el.hidden) return "";
  const words = el.cloneNode(true);
  for (const b of words.querySelectorAll("button")) b.remove();
  return words.textContent.trim().replace(/\s+/g, " ");
}

/** Puts the current receipts into every receipt on the page, and the agent line they decide, leaving the rest alone. */
function showReceipts() {
  for (const el of document.querySelectorAll("[data-receipt]")) el.textContent = receiptText(el.dataset.receipt);
  showAgent();
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
    const sent = sentUnread(v);
    v.receipts = receipts;
    // The agent line shows again once Claude read the review, saying what it does now.
    if (sent && !sentUnread(v)) await askAgent();
    if (state.view === v) showReceipts();
  };
  receiptsTimer = setInterval(ask, window.HOOP_RECEIPTS_MS ?? 10_000);
  document.addEventListener("visibilitychange", ask);
}

/** Shows whether these pages run current code, and whether they still answer. */
function showBanner(info) {
  const stale = info?.stale
    ? `These pages run older hoop code than is installed, and restart into it on their own. If this stays, stop process ${info.pid}, and any hoop command starts the current code.`
    : "";
  setBanner(info ? stale : PAGES_STOPPED);
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
        // The Work link follows whether this machine has work, without a reload.
        updateNav(info);
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
  const first = api("/api/info").catch(() => undefined);
  state.info = await Promise.race([first, late]);
  if (state.info) showBanner(state.info);
  // Info that comes late still shows the Work link, which waits for it.
  else
    first.then((info) => {
      if (!info || state.info) return;
      state.info = info;
      updateNav(info);
    });
  watchInfo();
  // Home checks open action items as it asks for them, so they close when hoop sees them done.
  const onHome = location.pathname === "/";
  watchPending({ onList: showReviews, onActions: showActions, checkActions: onHome });
  if (location.pathname === "/work") {
    const { renderWork } = await import("/work.js");
    return renderWork(state.info).then(() => false);
  }
  const id = reviewOfPath(location.pathname);
  return (id ? load(id) : renderList().then(() => false)).catch((err) => {
    app.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    return false;
  });
}
