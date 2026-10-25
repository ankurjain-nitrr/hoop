// The Work page: each Claude Code session's todos and subagents, from /api/work. People add todos,
// comment on, edit, reorder, put next, park and remove queued ones, comment on and edit running ones,
// and comment on or stop running agents; each change goes to the session in one message and through
// hoop's gate, and shows how far it got.
// It asks again every few seconds while the tab is visible.
import { esc } from "./esc.js";
import { frame } from "./frame.js";
import { agentHealth, clockText, counts, sortAgents, sortSessions, sortTodos, span, todoState, upNext } from "./activity.js";
import { foldAllHtml, foldBody, foldButton, foldClick, foldSummary, tally, unfold } from "./fold.js";
import { inlineHtml } from "./inline.js";
import { statusBadge, WORK } from "./status.js";
import { icons } from "./icons.js";

const app = document.getElementById("app");
/**
 * `ui` is the open form or confirmation: `{ key, mode, draft, desc, error }`, where key is
 * `<session>|todo|<id>`, `<session>|agent|<id>` or `<session>|add|new`, mode is comment, edit, add,
 * remove or stop, and desc an edit's or new todo's description. `more` holds the todos whose whole description shows.
 */
const work = { sessions: [], error: "", open: new Set(), more: new Set(), info: undefined, ui: null, focus: null };

/** How long something ran, as people read it: 45s, 3m 20s, 1h 05m. */
export function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const ENABLE = "<code>CLAUDE_CODE_ENABLE_TODO_TOOLS=1</code>";
const NO_TODOS = `No todos. Newer models keep no written todo list unless the session starts with ${ENABLE} in its environment: run <code>hoop init</code> to turn it on.`;

/** How far a change got, as the page says it. */
export const DELIVERY = {
  pending: "Sending",
  sent: "Sent to the session",
  read: "Read by the agent",
  waiting: "Waits for the gate",
  seen: "Seen by the agent",
  overridden: "Overridden by the agent",
  withdrawn: "Withdrawn",
};

const open = (c) => c.delivery !== "seen" && c.delivery !== "overridden" && c.delivery !== "withdrawn";
const quote = (s) => `“${esc(s)}”`;
/** A person's comment reads as conversation, apart from the notes on edits and moves. */
const noteClass = (c) => (c.kind === "comment" ? "note person" : "note");
const time = (at) => {
  const d = new Date(at);
  return `<time datetime="${esc(at)}">${esc(d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</time>`;
};

/** How close in time a person's moves of one todo must be to read as one move. */
export const MOVE_GROUP_MS = 10_000;

/**
 * The changes as the page lists them: each run of one person's moves of one todo, each within
 * MOVE_GROUP_MS of the last, is one entry, `{ c, from }`, with the last move and where the first began.
 */
export function collapseMoves(changes) {
  const out = [];
  for (const c of changes) {
    const last = out[out.length - 1]?.c;
    const same =
      c.kind === "move" && last?.kind === "move" && last.todo === c.todo && last.by === c.by && Date.parse(c.at) - Date.parse(last.at) <= MOVE_GROUP_MS;
    if (same) out[out.length - 1] = { c, from: out[out.length - 1].from };
    else out.push({ c, from: c.from });
  }
  return out;
}

/** A move in plain words, with which way it went when known: “moved #4 up, before #3”. */
function moveWords(c, from) {
  const way = typeof from === "number" && typeof c.to === "number" && from !== c.to ? (c.to < from ? " up," : " down,") : "";
  return `${esc(c.by)} moved #${esc(c.todo)}${way} ${c.before ? `before #${esc(c.before)}` : `after #${esc(c.after)}`}`;
}

/** A change in plain words, as a note under its todo or agent. */
function changeWords(c) {
  const by = esc(c.by);
  switch (c.kind) {
    case "remove":
      return `${by} removed it`;
    case "edit": {
      const desc = c.description === undefined ? "" : c.description ? `its description to ${quote(c.description)}` : "its description cleared";
      if (c.text === c.subject) return `${by} edited ${desc || "it"}`;
      return `${by} edited it to ${quote(c.text)}${desc ? `, ${desc.replace(/^its description to/, "with the description")}` : ""}`;
    }
    case "move":
      return c.before ? `${by} moved it before #${esc(c.before)}` : `${by} moved it after #${esc(c.after)}`;
    case "comment":
      return `<span class="by">${by}</span><span class="visually-hidden">: </span> <span class="said">${esc(c.text)}</span>`;
    case "stop":
      return `${by} stopped it`;
    case "add":
      return `${by} added it${c.description ? `, with the description ${quote(c.description)}` : ""}`;
    case "park":
      return `${by} parked it`;
    case "unpark":
      return `${by} unparked it`;
    case "withdraw":
      return `${by} withdrew it`;
    default:
      return by;
  }
}

/** How far a change got, in one muted style with an icon per state; only an overridden change, or one its turn missed, stands out. */
const DELIVERY_ICON = { pending: "clock", sent: "sent", read: "check", waiting: "clock", seen: "check", overridden: "warning", withdrawn: "undo" };

/**
 * Whether a sent change missed the agent's turn: the server read the whole transcript since it went
 * out without finding it (`unread`), and the session went on after it was sent and idles now.
 */
const missed = (c, s) => c.delivery === "sent" && c.unread && s.state === "idle" && Boolean(c.sent_at && s.activity && s.activity > c.sent_at);

/** How far a change got, with when the agent read it, and a warning when its turn ended without it. */
const delivery = (c, s) => {
  if (missed(c, s)) return `<span class="delivery d-overridden">${icons.warning}Not read yet: the session's turn ended without it</span>`;
  const read = c.delivery === "read" && c.read_at ? ` ${time(c.read_at)}` : "";
  return `<span class="delivery d-${esc(c.delivery)}">${icons[DELIVERY_ICON[c.delivery]] ?? ""}${DELIVERY[c.delivery] ?? esc(c.delivery)}${read}</span>`;
};

/** The notes under a todo or agent: one per change, one per move however many steps it took. */
function notesHtml(s, kind, id) {
  const mine = collapseMoves(s.changes.filter((c) => c[kind] === id));
  if (!mine.length) return "";
  return `<ul class="notes">${mine
    .map(({ c, from }) =>
      c.kind === "move"
        ? `<li class="note"><span class="what">${moveWords(c, from)}</span> ${time(c.at)}</li>`
        : `<li class="${noteClass(c)}"><span class="what">${changeWords(c)}</span> ${time(c.at)} ${delivery(c, s)}</li>`,
    )
    .join("")}</ul>`;
}

/** Every change to the session, each step with how far it got, folded below the todos. */
function historyHtml(s) {
  if (!s.changes.length) return "";
  const key = `history:${s.id}`;
  const about = (c) =>
    c.todo
      ? `#${esc(c.todo)}`
      : c.kind === "add" || c.kind === "withdraw"
        ? `new todo ${quote(c.text)}`
        : c.request
          ? `request ${quote(clip(c.subject))}`
          : `agent ${quote(c.subject)}`;
  const items = s.changes
    .map(
      (c) =>
        `<li class="${noteClass(c)}"><span class="what">${c.kind === "move" ? moveWords(c, c.from) : `${about(c)}: ${changeWords(c)}`}</span> ${time(c.at)} ${delivery(c, s)}</li>`,
    )
    .join("");
  return `<details class="history" data-fold="${esc(key)}"${work.open.has(key) ? " open" : ""}><summary>History</summary><ol class="notes">${items}</ol></details>`;
}

const btn = (act, key, label, text, extra = "", cls = "") =>
  `<button type="button" class="btn small${cls}" data-act="${act}" data-key="${esc(key)}" aria-label="${esc(label)}"${extra}>${text}</button>`;
/** Holds a button's place, unseen, so the buttons around it sit where they do in rows that have it. */
const slot = (text, cls = "") => `<span class="btn small slot${cls}" aria-hidden="true">${text}</span>`;

/** The form or confirmation open on a todo or agent, if it is this one. */
function uiHtml(key, name) {
  const ui = work.ui;
  if (!ui || ui.key !== key) return "";
  const id = `f-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const err = `<p id="${id}-err" class="steer-error" role="alert">${esc(ui.error ?? "")}</p>`;
  if (ui.mode === "remove" || ui.mode === "stop") {
    const ask = ui.mode === "remove" ? `Remove ${esc(name)} from the agent's list?` : `Stop ${esc(name)}? Its tool calls are refused from now on.`;
    const yes = ui.mode === "remove" ? "Remove" : "Stop";
    return `<div class="confirm" role="group" aria-labelledby="${id}-q"><span id="${id}-q">${ask}</span><button type="button" class="btn small danger" data-confirm data-key="${esc(key)}">${yes}</button><button type="button" class="btn small" data-cancel>Cancel</button>${err}</div>`;
  }
  const label = ui.mode === "edit" ? `New text for ${esc(name)}` : ui.mode === "add" ? "Subject of the new todo" : `Comment on ${esc(name)}`;
  const hint = `<span id="${id}-hint" class="hint">Enter sends; Shift+Enter starts a new line.</span>`;
  const about = ui.mode === "add" ? "Description of the new todo (optional)" : `Description of ${esc(name)}`;
  const field =
    ui.mode === "edit" || ui.mode === "add"
      ? `<input id="${id}" name="text" maxlength="500" autocomplete="off" value="${esc(ui.draft)}" aria-describedby="${id}-err"><label for="${id}-d">${about}</label><textarea id="${id}-d" name="description" rows="4" maxlength="8000" aria-describedby="${id}-hint ${id}-err">${esc(ui.desc ?? "")}</textarea>${hint}`
      : `<textarea id="${id}" name="text" rows="2" maxlength="2000" aria-describedby="${id}-hint ${id}-err">${esc(ui.draft)}</textarea>${hint}`;
  return `<form class="steer-form" data-form="${esc(key)}"><label for="${id}">${label}</label>${field}<button type="submit" class="btn small primary">${ui.mode === "edit" ? "Save" : ui.mode === "add" ? "Add" : "Send"}</button><button type="button" class="btn small" data-cancel>Cancel</button>${err}</form>`;
}

/** A link in a description: a hoop review link opens here and shows the review's title when known. */
export function descLink(t) {
  return (href, shown) => {
    const id = href.match(REVIEW_LINK)?.[1];
    if (!id) return {};
    const title = shown === href ? t.reviews?.[id] : undefined;
    return { sameTab: true, ...(title ? { text: title } : {}) };
  };
}
const REVIEW_LINK = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/r\/(rv_[a-z0-9]+)\/?$/;

/** A todo's description, two lines until "More" shows it whole. The button shows once the text overflows. */
function descHtml(t, key, label) {
  if (!t.description?.trim()) return "";
  const id = `d-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const more = work.more.has(key);
  const button = `<button type="button" class="more" data-act="more" data-key="${esc(key)}" aria-expanded="${more}" aria-controls="${id}" aria-label="${more ? "Less" : "More"} of the description of ${esc(label)}" hidden>${more ? "Less" : "More"}</button>`;
  return `<div class="desc-wrap"><p id="${id}" class="desc${more ? " open" : ""}">${inlineHtml(t.description.trim(), descLink(t))}</p>${button}</div>`;
}

/** A todo's or subagent's element ID, which the header's stalled link points at. */
export const itemId = (session, kind, id) => `${kind}-${session}-${id}`.replace(/[^A-Za-z0-9_-]/g, "_");

/** A running item's badge, how long it ran and its last activity, and a warning when it stalled. */
function healthHtml(h, started, activity, now) {
  if (!h) return { badge: "", meta: "", note: "" };
  return {
    badge: statusBadge(h.state, WORK),
    meta: `<span class="clock">${esc(clockText(started, activity, now, h.state === "notrunning"))}</span>`,
    note: h.note ? `<p class="stall">${esc(h.note)}</p>` : "",
  };
}

/**
 * A todo's state as the row shows it: its badge, with the reason on hover; how long it has been in
 * that state; and the reason as a note, with the review or pull request that shows it.
 */
function stateHtml(st, t, s, now) {
  if (!st) return { badge: "", meta: "", note: "", warn: "" };
  const warn = st.state === "stalled" || st.state === "notrunning";
  const started = t.since ?? t.updated;
  const clock =
    st.state === "running" || st.state === "stalled"
      ? clockText(started, s.activity, now)
      : st.state === "notrunning"
        ? clockText(started, undefined, now, true)
        : st.since && st.state !== "done"
          ? `for ${span(now - Date.parse(st.since))}`
          : "";
  const link = st.link
    ? ` <a href="${esc(st.link.href)}"${st.link.href.startsWith("/") ? "" : ' target="_blank" rel="noopener"'}>${esc(st.link.text)}</a>`
    : "";
  return {
    badge: `<span class="state" title="${esc(st.note)}">${statusBadge(st.state, WORK)}</span>`,
    meta: clock ? `<span class="clock">${esc(clock)}</span>` : "",
    note: `<p class="${warn ? "stall" : "why"}">${esc(st.note)}${link}</p>`,
    warn: warn ? " warn" : "",
  };
}

function todoHtml(s, t, queued, now) {
  const key = `${s.id}|todo|${t.id}`;
  const name = `todo #${t.id}`;
  const removed = s.changes.some((c) => c.kind === "remove" && c.todo === t.id && open(c));
  const parked = t.status === "queued" && s.parked?.includes(t.id);
  const label = `${name}, ${t.text}`;
  let acts = "";
  if (!removed && t.status !== "done" && work.ui?.key !== key) {
    const at = queued.indexOf(t);
    // Every row keeps the same slots, so each button sits at the same place down the list: a move
    // off the end shows disabled, and a running todo's missing controls hold their places unseen.
    // Two groups, so a narrow screen puts the second (park, remove) on its own line.
    let order = `${slot("Next")}${slot("Up")}${slot("Down")}`;
    let keep = `${slot("Park")}${slot("Remove", " danger")}`;
    if (parked) keep = `${btn("unpark", key, `Unpark ${label}`, "Unpark")}${btn("remove", key, `Remove ${label}`, "Remove", "", " danger")}`;
    else if (t.status === "queued") {
      const other = (i) => (at >= 0 && i >= 0 && i < queued.length && i !== at ? ` data-other="${esc(queued[i].id)}"` : " disabled");
      order =
        btn("next", key, `Put next ${label}`, "Next", other(0)) +
        btn("up", key, `Move up ${label}`, "Up", other(at - 1)) +
        btn("down", key, `Move down ${label}`, "Down", other(at + 1));
      keep = `${btn("park", key, `Park ${label}`, "Park")}${btn("remove", key, `Remove ${label}`, "Remove", "", " danger")}`;
    }
    // A group of empty slots only keeps places in line; a narrow screen, where the groups wrap, drops it.
    const slots = !parked && t.status !== "queued" ? " slots" : "";
    acts = `<span class="acts">${btn("comment", key, `Comment on ${label}`, "Comment")}${btn("edit", key, `Edit ${label}`, "Edit")}${order}</span><span class="acts${slots}">${keep}</span>`;
  }
  const shown = t.status === "running" && t.active ? t.active : t.text;
  const h = stateHtml(todoState(s, t, now), t, s, now);
  const warn = h.warn;
  return `<li class="todo${removed ? " removed" : ""}${warn}" id="${itemId(s.id, "todo", t.id)}" data-todo="${esc(t.id)}" data-key="${esc(key)}"><div class="row">${h.badge || statusBadge(t.status, WORK)}<span class="t">${esc(shown)}</span>${h.meta}${acts}</div>${h.note}${sourceHtml(s, t)}${descHtml(t, key, label)}${notesHtml(s, "todo", t.id)}${uiHtml(key, name)}</li>`;
}

/** A todo a person added that the agent hasn't created yet, at the end of the queue. */
function addedHtml(s, c) {
  const key = `${s.id}|add|${c.id}`;
  const acts = `<span class="acts">${btn("withdraw", key, `Withdraw the new todo ${c.text}`, "Withdraw")}</span>`;
  return `<li class="todo added" data-key="${esc(key)}"><div class="row">${statusBadge("queued", WORK)}<span class="t">${esc(c.text)}</span>${acts}</div><ul class="notes"><li class="note"><span class="what">${changeWords(c)}</span> ${time(c.at)} ${delivery(c, s)}</li></ul></li>`;
}

/** The Add todo button, or its form while open. */
function addHtml(s) {
  const key = `${s.id}|add|new`;
  return `<div class="add-todo">${uiHtml(key, "the new todo") || btn("add", key, `Add todo to ${s.name ?? "Unnamed session"}`, "Add todo")}</div>`;
}

function todosHtml(s, now) {
  const adds = s.changes.filter((c) => c.kind === "add" && !c.todo && open(c));
  if (!s.todos.length && !adds.length) return `<p class="none">${NO_TODOS}</p>${addHtml(s)}`;
  const isParked = (t) => t.status === "queued" && s.parked?.includes(t.id);
  // Running todos come first; queued ones keep the person's order; parked ones fold away.
  const live = sortTodos(s.todos.filter((t) => t.status !== "done" && !isParked(t)));
  const parked = s.todos.filter(isParked);
  const done = s.todos.filter((t) => t.status === "done");
  const removed = (t) => s.changes.some((c) => c.kind === "remove" && c.todo === t.id && open(c));
  const queued = live.filter((t) => t.status === "queued" && !removed(t));
  const fold = (cls, list) => {
    const key = `${cls}:${s.id}`;
    return list.length
      ? `<details class="${cls}" data-fold="${esc(key)}"${work.open.has(key) ? " open" : ""}><summary>${list.length} ${cls}</summary><ol class="todos">${list.map((t) => todoHtml(s, t, queued, now)).join("")}</ol></details>`
      : "";
  };
  const rows = live.map((t) => todoHtml(s, t, queued, now)).join("") + adds.map((c) => addedHtml(s, c)).join("");
  return `${rows ? `<ol class="todos">${rows}</ol>` : ""}${addHtml(s)}${fold("parked", parked)}${fold("done", done)}`;
}

/** Text clipped to `max` characters on one line. */
const clip = (text, max = 60) => {
  const line = String(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Where a todo came from, in a few words: the person's prompt, a review, the Work page, or the agent. */
export function sourceWords(s, src) {
  if (!src) return "";
  if (src.kind === "agent") return "added by the agent";
  if (src.kind === "change") return "from the Work page";
  if (src.kind === "review") {
    const title = s.requests?.find((q) => q.id === src.request)?.title;
    return `from review <a href="/r/${esc(src.review)}">${esc(title ?? src.review)}</a>`;
  }
  return `from ${quote(clip(src.text))} ${time(src.at)}`;
}

/** The request most of a session's todos came from, when at least three share it; their rows then leave it out. */
export function sharedSource(s) {
  const counts = new Map();
  for (const t of s.todos) if (t.source?.request) counts.set(t.source.request, (counts.get(t.source.request) ?? 0) + 1);
  const [id, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  return n >= 3 && n * 2 > s.todos.length ? s.todos.find((t) => t.source?.request === id).source : undefined;
}

const sourceHtml = (s, t) => (t.source && t.source.request !== sharedSource(s)?.request ? `<p class="why">${sourceWords(s, t.source)}</p>` : "");

/** What the person asked for, oldest first, with the todos each became; a prompt no todo came from is flagged. */
function requestsHtml(s) {
  if (!s.requests?.length) return "";
  const key = `requests:${s.id}`;
  const flagged = s.requests.filter((q) => q.unregistered).length;
  const KIND = { prompt: "You asked", review: "Review", change: "Work page" };
  const items = s.requests
    .map((q) => {
      const k = `${s.id}|request|${q.id}`;
      const what = q.kind === "review" ? `<a href="/r/${esc(q.review)}">${esc(q.title ?? clip(q.text))}</a>` : esc(clip(q.text, 120));
      const long = q.kind === "prompt" && clip(q.text, 120) !== q.text.trim();
      const full = long
        ? `<details class="req-full" data-fold="${esc(`req:${k}`)}"${work.open.has(`req:${k}`) ? " open" : ""}><summary>Full text</summary><p>${esc(q.text)}</p></details>`
        : "";
      const todos = q.todos.map((id) => s.todos.find((t) => t.id === id)).filter(Boolean);
      const list = todos.length
        ? `<ul class="req-todos">${todos.map((t) => `<li>${statusBadge(t.status, WORK)} #${esc(t.id)} ${esc(t.text)}</li>`).join("")}</ul><p class="why">${todos.filter((t) => t.status === "done").length} of ${todos.length} done</p>`
        : "";
      const asked = s.changes.find((c) => c.request === q.id);
      let flag = "";
      if (q.dismissed) flag = `<p class="why">Dismissed: no todo needed</p>`;
      else if (q.unregistered) {
        const ask = asked
          ? `${esc(asked.by)} asked the agent to register it ${delivery(asked, s)}`
          : btn("register", k, `Ask the agent to register ${clip(q.text)}`, "Ask the agent to register it");
        flag = `<p class="stall">Not registered: no todo came from it.</p><p class="req-acts">${ask}${btn("dismiss", k, `Dismiss ${clip(q.text)}: no todo needed`, "Dismiss")}</p>`;
      }
      return `<li class="request" data-key="${esc(k)}"><p class="req-head"><span class="now-label">${KIND[q.kind]}</span> <span class="said">${what}</span> ${time(q.at)}</p>${full}${list}${flag}</li>`;
    })
    .join("");
  const label = `Requests${flagged ? ` (${flagged} not registered)` : ""}`;
  return `<details class="requests" data-fold="${esc(key)}"${work.open.has(key) ? " open" : ""}><summary>${label}</summary><ol class="steps">${items}</ol></details>`;
}

/** The text of the comment that asks the agent to register a request. */
export const REGISTER_TEXT = "Register todos for it with TaskCreate, or reply that none are needed.";

/** The todo the session starts next, while it runs. */
function nextHtml(s) {
  const t = s.state === "ended" ? undefined : upNext(s);
  return t ? `<p class="up-next"><span class="now-label">Up next:</span> <span class="what">#${esc(t.id)} ${esc(t.text)}</span></p>` : "";
}

/** A finished agent's links, as its report names them: "PR #214", "Issue #233", "Review". */
const linksHtml = (a) =>
  a.links?.length
    ? `<p class="links">${a.links.map((l) => `<a href="${esc(l.url)}"${l.label === "Review" ? "" : ' target="_blank" rel="noopener"'}>${esc(l.label)}</a>`).join("")}</p>`
    : "";

/** What only a curious person reads: its type, its last step as the transcript has it, and the transcript's path. */
function agentDetails(s, a, label) {
  const parts = [
    a.type ? `<dt>Type</dt><dd class="mono">${esc(a.type)}</dd>` : "",
    a.last ? `<dt>Last step</dt><dd>${esc(a.last)}</dd>` : "",
    a.transcript ? `<dt>Transcript</dt><dd class="path mono">${esc(a.transcript)}</dd>` : "",
  ].join("");
  if (!parts) return "";
  const key = `agent:${s.id}:${a.id}`;
  return `<details class="agent-details" data-fold="${esc(key)}"${work.open.has(key) ? " open" : ""}><summary aria-label="Details of agent ${esc(label)}">Details</summary><dl>${parts}</dl></details>`;
}

/**
 * A subagent in plain words: what it was asked, then while it runs its step when one reads plainly,
 * and once it ends what it came to, or why it stopped or failed, with the links its report names.
 */
function agentHtml(s, a, now) {
  const key = `${s.id}|agent|${a.id}`;
  const desc = a.description || "Unnamed agent";
  const h = healthHtml(agentHealth(a, now), a.started, a.activity, now);
  const meta = h.meta || `<span class="time" title="How long it ran">ran for ${elapsed((a.ended ? Date.parse(a.ended) : now) - Date.parse(a.started))}</span>`;
  const said = a.status === "running" ? a.step : (a.reason ?? a.outcome);
  const more = a.reason && a.outcome ? `<p class="outcome">${esc(a.outcome)}</p>` : "";
  const line = said ? `<p class="${a.status === "running" ? "last" : "outcome"}">${esc(said)}</p>${more}` : "";
  const stopped = s.changes.some((c) => c.kind === "stop" && c.agent === a.id);
  const acts =
    a.status === "running" && !stopped && work.ui?.key !== key
      ? `<span class="acts">${btn("comment", key, `Comment on agent ${desc}`, "Comment")}${btn("stop", key, `Stop agent ${desc}`, "Stop", "", " danger")}</span>`
      : "";
  return `<li class="agent${h.note ? " warn" : ""}" id="${itemId(s.id, "agent", a.id)}" data-agent="${esc(a.id)}" data-key="${esc(key)}"><div class="row">${h.badge || statusBadge(a.status, WORK)}<span class="t">${esc(desc)}</span>${meta}${acts}</div>${h.note}${line}${linksHtml(a)}${notesHtml(s, "agent", a.id)}${agentDetails(s, a, desc)}${uiHtml(key, `agent ${quote(desc)}`)}</li>`;
}

/** A session's agents: running ones on top, finished ones folded under "N finished". */
function agentsHtml(s, now) {
  if (!s.agents.length) return '<p class="none">No subagents.</p>';
  const live = sortAgents(s.agents.filter((a) => a.status === "running"));
  const ended = s.agents.filter((a) => a.status !== "running");
  const key = `finished:${s.id}`;
  const folded = ended.length
    ? `<details class="finished" data-fold="${esc(key)}"${work.open.has(key) ? " open" : ""}><summary aria-label="${ended.length} finished ${ended.length === 1 ? "agent" : "agents"}">${ended.length} finished</summary><ul class="agents">${ended.map((a) => agentHtml(s, a, now)).join("")}</ul></details>`
    : "";
  return `${live.length ? `<ul class="agents">${live.map((a) => agentHtml(s, a, now)).join("")}</ul>` : ""}${folded}`;
}

const ago = (at, now) => `<time datetime="${esc(at)}">${span(now - Date.parse(at))} ago</time>`;

/** What a session does now, in one line: its running tool call and for how long, else its latest one. */
function nowHtml(s, now) {
  const d = s.doing;
  if (!d) return s.state === "busy" ? '<p class="now"><span class="now-label">Now:</span> <span class="what">activity unknown</span></p>' : "";
  const when = d.open ? `<span class="when">for ${span(now - Date.parse(d.at))}</span>` : `<span class="when">${ago(d.at, now)}</span>`;
  const badge = d.waiting ? `${statusBadge("waiting", WORK)} ` : "";
  return `<p class="now"><span class="now-label">Now:</span> ${badge}<span class="what">${esc(d.what)}</span> ${when}</p>`;
}

/** The session's steps in the last five minutes, newest first, folded. */
function recentHtml(s, now) {
  if (!s.recent?.length) return "";
  const key = `recent:${s.id}`;
  const items = s.recent.map((r) => `<li><span class="what">${esc(r.what)}</span> ${ago(r.at, now)}</li>`).join("");
  return `<details class="recent" data-fold="${esc(key)}"${work.open.has(key) ? " open" : ""}><summary>Last 5 minutes</summary><ul class="steps">${items}</ul></details>`;
}

function sessionHtml(s, n, now) {
  const id = `w-${n}`;
  const name = s.name ?? "Unnamed session";
  const details = `<span class="sid mono" title="Session ID">${esc(s.id.slice(0, 8))}</span>${s.folder ? `<span class="place mono" title="The folder the session works in">${esc(s.folder)}</span>` : ""}${statusBadge(s.state, WORK)}`;
  const agents = agentsHtml(s, now);
  const shared = sharedSource(s);
  const waits = s.changes.some((c) => c.delivery === "waiting")
    ? `<p class="gate-note">This session can't take messages now: it isn't running, or its Claude Code has no messaging socket. Changes wait for the gate, hoop's hook that stops the agent from starting a changed todo and tells it why, and refuses a stopped agent's tool calls.</p>`
    : "";
  // The session, its todos and its subagents each fold, kept by session ID.
  const key = `work:${s.id}`;
  const todos = tally(s.todos, WORK, (t) => todoState(s, t, now)?.state ?? t.status);
  const agentStates = tally(s.agents, WORK);
  // Agents count beside the session's name only while they run.
  const running = s.agents.filter((a) => a.status === "running").length;
  const summary = foldSummary(key, [...todos, [running, "agent running", "agents running"]]);
  const part = (k, title, body, counts) =>
    `<div class="part-head"><h3 id="${id}-${k}">${foldButton(`${key}:${k}`, `${id}-${k}-body`, title)}</h3>${foldSummary(`${key}:${k}`, counts)}</div><div ${foldBody(`${key}:${k}`, `${id}-${k}-body`)}>${body}</div>`;
  return `<section class="session work-session" aria-labelledby="${id}"><div class="session-head"><h2 id="${id}">${foldButton(key, `${id}-body`, esc(name), "session")}</h2>${summary}${details}</div>${nowHtml(s, now)}${nextHtml(s)}${shared ? `<p class="up-next"><span class="now-label">Source:</span> most todos ${sourceWords(s, shared)}</p>` : ""}<div ${foldBody(key, `${id}-body`)}>${recentHtml(s, now)}${waits}${part("todos", "Todos", todosHtml(s, now) + requestsHtml(s) + historyHtml(s), todos)}${part("agents", "Subagents", agents, agentStates)}</div></section>`;
}

/** The Work page's body for a list of sessions; `now` sets how long running agents have run. */
export function workHtml(sessions, now = Date.now()) {
  if (!sessions.length)
    return `<div class="empty"><p>No work tracked yet. A session's todos and subagents appear here once hoop's Claude Code plugin is installed (<code>hoop init</code>) and the session uses them.</p><p>Newer models keep no written todo list by default. Run <code>hoop init</code> and answer yes to turn the todo tools on (it sets ${ENABLE} in Claude Code's settings and keeps a backup), or start Claude Code with it in its environment.</p></div>`;
  return sortSessions(sessions)
    .map((s, n) => sessionHtml(s, n, now))
    .join("");
}

/** The counts above the sessions, as the rows read: running, waiting on you, stalled, not running; each links to its first row. */
export function countsHtml(sessions, now = Date.now()) {
  if (!sessions.length) return "";
  const c = counts(sessions, now);
  const part = (state, words) => {
    const first = c[state][0];
    const text = `${c[state].length} ${words}`;
    return first
      ? `<a href="#${itemId(first.session, first.kind, first.id)}" data-goto="${esc(`${first.session}|${first.kind}`)}" data-count="${state}">${text}</a>`
      : text;
  };
  const parts = [part("running", "running"), part("waiting", "waiting on you"), part("stalled", "stalled"), part("notrunning", "not running")];
  return `<p class="work-counts">${parts.join(" · ")}</p>`;
}

/** Says something to screen readers, from a region outside the part the page repaints. */
function announce(text) {
  let live = document.getElementById("work-live");
  if (!live) {
    live = document.createElement("div");
    live.id = "work-live";
    live.className = "visually-hidden";
    live.setAttribute("role", "status");
    document.body.append(live);
  }
  live.textContent = text;
}

/** Shows "More" only where a description runs past two lines, and "Less" wherever one is open. */
function measure() {
  for (const b of app.querySelectorAll('[data-act="more"]')) {
    const desc = document.getElementById(b.getAttribute("aria-controls"));
    b.hidden = !(work.more.has(b.dataset.key) || (desc && desc.scrollHeight > desc.clientHeight + 1));
  }
}

const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";
/** What a control is, so a repaint finds the same one: its tag, address, label and text. */
const what = (el) => [el.tagName, el.getAttribute("href"), el.getAttribute("aria-label"), (el.textContent || "").trim().slice(0, 60)].join("|");

/** Where a focused control is: what it is, which of the controls like it, and its place among all. */
function spot(active) {
  if (!active || active === app || !app.contains(active)) return null;
  const all = [...app.querySelectorAll(FOCUSABLE)];
  const key = what(active);
  return { key, nth: all.filter((el) => what(el) === key).indexOf(active), place: all.indexOf(active) };
}

/** The control at `at` after a repaint: the same one if it is still there, else the one in its place, or the last. */
function regain(at) {
  const all = [...app.querySelectorAll(FOCUSABLE)];
  const same = all.filter((el) => what(el) === at.key);
  (same[at.nth] ?? same[0] ?? all[Math.min(at.place, all.length - 1)])?.focus();
}

function paint() {
  document.title = "Work · hoop";
  // A refresh keeps focus on the same control.
  const active = document.activeElement;
  // A fold's own summary keeps the focus by its fold; a link inside a fold keeps it below, as any control.
  const fold = active?.matches?.("summary") ? active.closest("[data-fold]")?.dataset.fold : undefined;
  const act = active?.dataset?.act && { act: active.dataset.act, key: active.dataset.key };
  // A row focused on its own, as the stalled link leaves one, keeps the focus too.
  const row = active?.matches?.("li[data-key]") ? active.dataset.key : undefined;
  // So does a link in the counts, by the state it counts.
  const counted = active?.closest?.(".work-counts") ? active.dataset?.count : undefined;
  const toggle = active?.dataset?.collapse
    ? `[data-collapse="${CSS.escape(active.dataset.collapse)}"]`
    : active?.dataset?.collapseAll && `[data-collapse-all="${active.dataset.collapseAll}"]`;
  // Any other control, such as a link in the header, keeps the focus too.
  const at = spot(active);
  const err = work.error ? `<p class="empty" role="alert">${esc(work.error)}</p>` : "";
  app.innerHTML = frame(
    "work",
    `<div class="list work"><header class="list-head"><h1>Work</h1>${work.sessions.length ? foldAllHtml() : ""}</header>${countsHtml(work.sessions, Date.now())}${err}${workHtml(work.sessions)}</div>`,
    work.info,
  );
  measure();
  const focus = work.focus ?? act;
  work.focus = null;
  if (focus?.sel ?? toggle) app.querySelector(focus?.sel ?? toggle)?.focus();
  else if (focus === "field") app.querySelector(".steer-form input, .steer-form textarea")?.focus();
  else if (focus === "confirm") app.querySelector("[data-confirm]")?.focus();
  else if (focus?.key) {
    // A move to the end of the list disables the button pressed; focus goes to the other move.
    const sel = (a) => `[data-act="${a}"][data-key="${CSS.escape(focus.key)}"]:enabled`;
    const other = { up: "down", down: "up", next: "down", park: "unpark", unpark: "park" }[focus.act];
    const target =
      app.querySelector(sel(focus.act)) ??
      (other && app.querySelector(sel(other))) ??
      app.querySelector(`[data-key="${CSS.escape(focus.key)}"] [data-act]:enabled`);
    if (target) target.focus();
    else {
      // The todo or agent has no controls left: focus its row, so the keyboard stays in place.
      const row = app.querySelector(`li[data-key="${CSS.escape(focus.key)}"]`);
      row?.setAttribute("tabindex", "-1");
      row?.focus();
    }
  } else if (fold) app.querySelector(`[data-fold="${CSS.escape(fold)}"] summary`)?.focus();
  else if (counted && app.querySelector(`.work-counts [data-count="${CSS.escape(counted)}"]`))
    app.querySelector(`.work-counts [data-count="${CSS.escape(counted)}"]`).focus();
  else if (row) {
    const el = app.querySelector(`li[data-key="${CSS.escape(row)}"]`);
    el?.setAttribute("tabindex", "-1");
    el?.focus();
  } else if (at) regain(at);
}

async function load() {
  try {
    const res = await fetch("/api/work");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    work.sessions = body.sessions;
    work.error = "";
  } catch (err) {
    work.error = `Couldn't read the work: ${err.message}`;
  }
  // A refresh waits while a form or confirmation is open, so it doesn't drop what is being typed.
  if (!work.ui) paint();
}

/** Sends one change, and shows the session as the server has it now. */
async function sendChange(key, change) {
  const [session] = key.split("|");
  const res = await fetch(`/api/work/${encodeURIComponent(session)}/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ changes: [change] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  if (body.session) work.sessions = work.sessions.map((s) => (s.id === session ? body.session : s));
  const c = body.changes?.[0];
  announce(
    c?.delivery === "waiting"
      ? "Saved. The session can't take messages now, so the change waits for the gate."
      : "Saved. It goes to the session in a few seconds.",
  );
}

/** The change a form or confirmation makes. */
function changeFor(key, mode, text, description) {
  const [, kind, id] = key.split("|");
  if (kind === "add") return { kind: "add", text, ...(description ? { description } : {}) };
  const target = kind === "todo" ? { todo: id } : { agent: id };
  if (mode === "remove" || mode === "stop") return { kind: mode, ...target };
  return { kind: mode, ...target, text, ...(mode === "edit" && description !== undefined ? { description } : {}) };
}

async function submit(key, mode, text, description) {
  try {
    await sendChange(key, changeFor(key, mode, text, description));
  } catch (err) {
    work.ui = { ...work.ui, error: err.message };
    const box = app.querySelector(".steer-error");
    if (box) box.textContent = err.message;
    app.querySelector(".steer-form input, .steer-form textarea")?.setAttribute("aria-invalid", "true");
    return;
  }
  work.ui = null;
  work.focus = { act: mode, key };
  paint();
}

function close() {
  const key = work.ui?.key;
  const mode = work.ui?.mode;
  work.ui = null;
  work.focus = key ? { act: mode, key } : null;
  paint();
}

document.addEventListener(
  "toggle",
  (e) => {
    const key = e.target.dataset?.fold;
    if (!key) return;
    if (e.target.open) work.open.add(key);
    else work.open.delete(key);
    measure();
  },
  true,
);

document.addEventListener("click", async (e) => {
  // The stalled link opens the folds around the first stalled item, then goes to it.
  const go = e.target.closest?.("a[data-goto]");
  if (go && app.contains(go)) {
    e.preventDefault();
    const [session, kind] = go.dataset.goto.split("|");
    unfold([`work:${session}`, `work:${session}:${kind === "todo" ? "todos" : "agents"}`]);
    const target = go.getAttribute("href");
    paint();
    const el = app.querySelector(target);
    el?.setAttribute("tabindex", "-1");
    el?.focus();
    return;
  }
  const t = e.target.closest?.("button");
  if (!t || !app.contains(t)) return;
  if (t.hasAttribute("data-cancel")) return close();
  const fold = foldClick(t, app);
  if (fold) {
    work.focus = { sel: fold };
    return paint();
  }
  if (t.hasAttribute("data-confirm")) return submit(t.dataset.key, work.ui.mode);
  const act = t.dataset.act;
  if (!act) return;
  const key = t.dataset.key;
  if (act === "more") {
    if (work.more.has(key)) work.more.delete(key);
    else work.more.add(key);
    work.focus = { act, key };
    return paint();
  }
  if (act === "register" || act === "dismiss") {
    const [session, , id] = key.split("|");
    try {
      if (act === "register") await sendChange(key, { kind: "comment", request: id, text: REGISTER_TEXT });
      else {
        const res = await fetch(`/api/work/${encodeURIComponent(session)}/dismiss`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request: id }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || res.statusText);
        if (body.session) work.sessions = work.sessions.map((x) => (x.id === session ? body.session : x));
        announce("Dismissed.");
      }
      work.focus = { act, key };
    } catch (err) {
      work.error = `Couldn't ${act === "register" ? "ask the agent" : "dismiss it"}: ${err.message}`;
    }
    return paint();
  }
  if (act === "withdraw") {
    const [session, , id] = key.split("|");
    try {
      await sendChange(key, { kind: "withdraw", of: id });
      // The row goes: the focus goes to Add todo.
      work.focus = { sel: `[data-act="add"][data-key="${CSS.escape(`${session}|add|new`)}"]` };
    } catch (err) {
      work.error = `Couldn't withdraw it: ${err.message}`;
    }
    return paint();
  }
  if (act === "up" || act === "down" || act === "next" || act === "park" || act === "unpark") {
    const [session, , id] = key.split("|");
    const change =
      act === "park" || act === "unpark" ? { kind: act, todo: id } : { kind: "move", todo: id, [act === "down" ? "after" : "before"]: t.dataset.other };
    try {
      await sendChange(key, change);
      // A parked todo moves into the Parked fold: open it, so the focus can follow.
      if (act === "park") work.open.add(`parked:${session}`);
      work.focus = { act, key };
    } catch (err) {
      work.error = `Couldn't ${act === "park" || act === "unpark" ? act : "move"} it: ${err.message}`;
    }
    return paint();
  }
  const s = work.sessions.find((x) => x.id === key.split("|")[0]);
  const todo = s?.todos.find((x) => `${s.id}|todo|${x.id}` === key);
  work.ui = { key, mode: act, draft: act === "edit" ? (todo?.text ?? "") : "", desc: act === "edit" ? (todo?.description ?? "") : "", error: "" };
  work.focus = act === "remove" || act === "stop" ? "confirm" : "field";
  paint();
});

document.addEventListener("input", (e) => {
  if (!work.ui || !e.target.closest?.(".steer-form")) return;
  if (e.target.name === "description") work.ui.desc = e.target.value;
  else work.ui.draft = e.target.value;
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest?.("[data-form]");
  if (!form) return;
  e.preventDefault();
  submit(form.dataset.form, work.ui.mode, form.querySelector("input, textarea").value, form.elements.description?.value);
});

document.addEventListener("keydown", (e) => {
  // Enter sends a comment, as in the edit field; Shift+Enter starts a new line.
  if (e.key === "Enter" && !e.shiftKey && e.target.matches?.(".steer-form textarea")) {
    e.preventDefault();
    e.target.form.requestSubmit();
    return;
  }
  if (e.key === "Escape" && work.ui && e.target.closest?.(".steer-form, .confirm")) {
    e.preventDefault();
    close();
  }
});

/** Shows the Work page, and asks again every few seconds while the tab is visible. */
export async function renderWork(info) {
  work.info = info;
  await load();
  setInterval(() => document.visibilityState === "visible" && load(), window.HOOP_WORK_MS ?? 3000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load());
}
