// The Work page: each Claude Code session's todos and subagents, from /api/work. People comment on,
// edit, reorder and remove queued todos, and comment on or stop running agents; each change goes to
// the session in one message and through hoop's gate, and shows how far it got.
// It asks again every few seconds while the tab is visible.
import { esc } from "./esc.js";
import { frame } from "./frame.js";
import { foldAllHtml, foldBody, foldButton, foldClick, foldSummary, tally } from "./fold.js";
import { inlineHtml } from "./inline.js";
import { statusBadge, WORK } from "./status.js";

const app = document.getElementById("app");
/**
 * `ui` is the open form or confirmation: `{ key, mode, draft, desc, error }`, where key is
 * `<session>|todo|<id>` or `<session>|agent|<id>`, mode is comment, edit, remove or stop, and desc
 * an edit's description. `more` holds the todos whose whole description shows.
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
  waiting: "Waits for the gate",
  seen: "Seen by the agent",
  overridden: "Overridden by the agent",
};

const open = (c) => c.delivery !== "seen" && c.delivery !== "overridden";
const quote = (s) => `“${esc(s)}”`;
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
      return `${by}: ${quote(c.text)}`;
    case "stop":
      return `${by} stopped it`;
    default:
      return by;
  }
}

const delivery = (c) => `<span class="delivery d-${esc(c.delivery)}">${DELIVERY[c.delivery] ?? esc(c.delivery)}</span>`;

/** The notes under a todo or agent: one per change, one per move however many steps it took. */
function notesHtml(s, kind, id) {
  const mine = collapseMoves(s.changes.filter((c) => c[kind] === id));
  if (!mine.length) return "";
  return `<ul class="notes">${mine
    .map(({ c, from }) =>
      c.kind === "move"
        ? `<li class="note"><span class="what">${moveWords(c, from)}</span> ${time(c.at)}</li>`
        : `<li class="note"><span class="what">${changeWords(c)}</span> ${time(c.at)} ${delivery(c)}</li>`,
    )
    .join("")}</ul>`;
}

/** Every change to the session, each step with how far it got, folded below the todos. */
function historyHtml(s) {
  if (!s.changes.length) return "";
  const key = `history:${s.id}`;
  const about = (c) => (c.todo ? `#${esc(c.todo)}` : `agent ${quote(c.subject)}`);
  const items = s.changes
    .map(
      (c) =>
        `<li class="note"><span class="what">${c.kind === "move" ? moveWords(c, c.from) : `${about(c)}: ${changeWords(c)}`}</span> ${time(c.at)} ${delivery(c)}</li>`,
    )
    .join("");
  return `<details class="history" data-fold="${esc(key)}"${work.open.has(key) ? " open" : ""}><summary>History</summary><ol class="notes">${items}</ol></details>`;
}

const btn = (act, key, label, text, extra = "") =>
  `<button type="button" class="btn small" data-act="${act}" data-key="${esc(key)}" aria-label="${esc(label)}"${extra}>${text}</button>`;

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
  const label = ui.mode === "edit" ? `New text for ${esc(name)}` : `Comment on ${esc(name)}`;
  const hint = `<span id="${id}-hint" class="hint">Enter sends; Shift+Enter starts a new line.</span>`;
  const field =
    ui.mode === "edit"
      ? `<input id="${id}" name="text" maxlength="500" autocomplete="off" value="${esc(ui.draft)}" aria-describedby="${id}-err"><label for="${id}-d">Description of ${esc(name)}</label><textarea id="${id}-d" name="description" rows="4" maxlength="8000" aria-describedby="${id}-hint ${id}-err">${esc(ui.desc ?? "")}</textarea>${hint}`
      : `<textarea id="${id}" name="text" rows="2" maxlength="2000" aria-describedby="${id}-hint ${id}-err">${esc(ui.draft)}</textarea>${hint}`;
  return `<form class="steer-form" data-form="${esc(key)}"><label for="${id}">${label}</label>${field}<button type="submit" class="btn small primary">${ui.mode === "edit" ? "Save" : "Send"}</button><button type="button" class="btn small" data-cancel>Cancel</button>${err}</form>`;
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

function todoHtml(s, t, queued) {
  const key = `${s.id}|todo|${t.id}`;
  const name = `todo #${t.id}`;
  const removed = s.changes.some((c) => c.kind === "remove" && c.todo === t.id && open(c));
  const label = `${name}, ${t.text}`;
  let acts = "";
  if (!removed && t.status !== "done" && work.ui?.key !== key) {
    const at = queued.indexOf(t);
    acts = btn("comment", key, `Comment on ${label}`, "Comment");
    if (t.status === "queued") {
      acts += btn("edit", key, `Edit ${label}`, "Edit");
      if (at > 0) acts += btn("up", key, `Move up ${label}`, "Move up", ` data-other="${esc(queued[at - 1].id)}"`);
      if (at >= 0 && at < queued.length - 1) acts += btn("down", key, `Move down ${label}`, "Move down", ` data-other="${esc(queued[at + 1].id)}"`);
      acts += btn("remove", key, `Remove ${label}`, "Remove");
    }
    acts = `<span class="acts">${acts}</span>`;
  }
  const shown = t.status === "running" && t.active ? t.active : t.text;
  return `<li class="todo${removed ? " removed" : ""}" data-todo="${esc(t.id)}" data-key="${esc(key)}"><div class="row">${statusBadge(t.status, WORK)}<span class="t">${esc(shown)}</span>${acts}</div>${descHtml(t, key, label)}${notesHtml(s, "todo", t.id)}${uiHtml(key, name)}</li>`;
}

function todosHtml(s) {
  if (!s.todos.length) return `<p class="none">${NO_TODOS}</p>`;
  const live = s.todos.filter((t) => t.status !== "done");
  const done = s.todos.filter((t) => t.status === "done");
  const removed = (t) => s.changes.some((c) => c.kind === "remove" && c.todo === t.id && open(c));
  const queued = live.filter((t) => t.status === "queued" && !removed(t));
  const key = `done:${s.id}`;
  const folded = done.length
    ? `<details class="done" data-fold="${esc(key)}"${work.open.has(key) ? " open" : ""}><summary>${done.length} done</summary><ol class="todos">${done.map((t) => todoHtml(s, t, queued)).join("")}</ol></details>`
    : "";
  return `${live.length ? `<ol class="todos">${live.map((t) => todoHtml(s, t, queued)).join("")}</ol>` : ""}${folded}`;
}

function agentHtml(s, a, now) {
  const key = `${s.id}|agent|${a.id}`;
  const desc = a.description || "Subagent";
  const time_ = elapsed((a.ended ? Date.parse(a.ended) : now) - Date.parse(a.started));
  const meta = [a.type ? `<span class="type mono">${esc(a.type)}</span>` : "", `<span class="time" title="How long it ran">${time_}</span>`].join("");
  const last = a.last ? `<p class="last"><span class="visually-hidden">Last step: </span>${esc(a.last)}</p>` : "";
  const path = a.transcript ? `<p class="path mono" title="Its transcript">${esc(a.transcript)}</p>` : "";
  const stopped = s.changes.some((c) => c.kind === "stop" && c.agent === a.id);
  const acts =
    a.status === "running" && !stopped && work.ui?.key !== key
      ? `<span class="acts">${btn("comment", key, `Comment on agent ${desc}`, "Comment")}${btn("stop", key, `Stop agent ${desc}`, "Stop")}</span>`
      : "";
  return `<li class="agent" data-agent="${esc(a.id)}" data-key="${esc(key)}"><div class="row">${statusBadge(a.status, WORK)}<span class="t">${esc(desc)}</span>${meta}${acts}</div>${last}${path}${notesHtml(s, "agent", a.id)}${uiHtml(key, `agent ${quote(desc)}`)}</li>`;
}

function sessionHtml(s, n, now) {
  const id = `w-${n}`;
  const name = s.name ?? "Unnamed session";
  const details = `<span class="sid mono" title="Session ID">${esc(s.id.slice(0, 8))}</span>${s.folder ? `<span class="place mono" title="The folder the session works in">${esc(s.folder)}</span>` : ""}${statusBadge(s.state, WORK)}`;
  const agents = s.agents.length ? `<ul class="agents">${s.agents.map((a) => agentHtml(s, a, now)).join("")}</ul>` : '<p class="none">No subagents.</p>';
  const waits = s.changes.some((c) => c.delivery === "waiting")
    ? `<p class="gate-note">This session can't take messages now: it isn't running, or its Claude Code has no messaging socket. Changes wait for the gate, hoop's hook that stops the agent from starting a changed todo and tells it why, and refuses a stopped agent's tool calls.</p>`
    : "";
  // The session, its todos and its subagents each fold, kept by session ID.
  const key = `work:${s.id}`;
  const todos = tally(s.todos, WORK);
  const agentStates = tally(s.agents, WORK);
  const summary = foldSummary(key, [...todos, [s.agents.length, "agent", "agents"]]);
  const part = (k, title, body, counts) =>
    `<div class="part-head"><h3 id="${id}-${k}">${foldButton(`${key}:${k}`, `${id}-${k}-body`, title)}</h3>${foldSummary(`${key}:${k}`, counts)}</div><div ${foldBody(`${key}:${k}`, `${id}-${k}-body`)}>${body}</div>`;
  return `<section class="session work-session" aria-labelledby="${id}"><div class="session-head"><h2 id="${id}">${foldButton(key, `${id}-body`, esc(name), "session")}</h2>${summary}${details}</div><div ${foldBody(key, `${id}-body`)}>${waits}${part("todos", "Todos", todosHtml(s) + historyHtml(s), todos)}${part("agents", "Subagents", agents, agentStates)}</div></section>`;
}

/** The Work page's body for a list of sessions; `now` sets how long running agents have run. */
export function workHtml(sessions, now = Date.now()) {
  if (!sessions.length)
    return `<div class="empty"><p>No work tracked yet. A session's todos and subagents appear here once hoop's Claude Code plugin is installed (<code>hoop init</code>) and the session uses them.</p><p>Newer models keep no written todo list by default. Run <code>hoop init</code> and answer yes to turn the todo tools on (it sets ${ENABLE} in Claude Code's settings and keeps a backup), or start Claude Code with it in its environment.</p></div>`;
  return sessions.map((s, n) => sessionHtml(s, n, now)).join("");
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

function paint() {
  document.title = "Work · hoop";
  // A refresh keeps focus on the same control.
  const active = document.activeElement;
  const fold = active?.closest?.("[data-fold]")?.dataset.fold;
  const act = active?.dataset?.act && { act: active.dataset.act, key: active.dataset.key };
  const toggle = active?.dataset?.collapse
    ? `[data-collapse="${CSS.escape(active.dataset.collapse)}"]`
    : active?.dataset?.collapseAll && `[data-collapse-all="${active.dataset.collapseAll}"]`;
  const err = work.error ? `<p class="empty" role="alert">${esc(work.error)}</p>` : "";
  app.innerHTML = frame(
    "work",
    `<div class="list work"><header class="list-head"><h1>Work</h1>${work.sessions.length ? foldAllHtml() : ""}</header>${err}${workHtml(work.sessions)}</div>`,
    work.info,
  );
  measure();
  const focus = work.focus ?? act;
  work.focus = null;
  if (focus?.sel ?? toggle) app.querySelector(focus?.sel ?? toggle)?.focus();
  else if (focus === "field") app.querySelector(".steer-form input, .steer-form textarea")?.focus();
  else if (focus === "confirm") app.querySelector("[data-confirm]")?.focus();
  else if (focus?.key) {
    const sel = (a) => `[data-act="${a}"][data-key="${CSS.escape(focus.key)}"]`;
    const target = app.querySelector(sel(focus.act)) ?? app.querySelector(`[data-key="${CSS.escape(focus.key)}"] [data-act]`);
    if (target) target.focus();
    else {
      // The todo or agent has no controls left: focus its row, so the keyboard stays in place.
      const row = app.querySelector(`li[data-key="${CSS.escape(focus.key)}"]`);
      row?.setAttribute("tabindex", "-1");
      row?.focus();
    }
  } else if (fold) app.querySelector(`[data-fold="${CSS.escape(fold)}"] summary`)?.focus();
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
  if (act === "up" || act === "down") {
    const [, , id] = key.split("|");
    try {
      await sendChange(key, { kind: "move", todo: id, [act === "up" ? "before" : "after"]: t.dataset.other });
      work.focus = { act, key };
    } catch (err) {
      work.error = `Couldn't move it: ${err.message}`;
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
