// The Work page: each Claude Code session's todos and subagents, from /api/work, read-only.
// It asks again every few seconds while the tab is visible.
import { esc } from "./esc.js";
import { frame } from "./frame.js";
import { statusBadge, WORK } from "./status.js";

const app = document.getElementById("app");
const work = { sessions: [], error: "", open: new Set(), info: undefined };

/** How long something ran, as people read it: 45s, 3m 20s, 1h 05m. */
export function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const ENABLE = "<code>CLAUDE_CODE_ENABLE_TODO_TOOLS=1</code>";
const NO_TODOS = `No todos. Newer models keep no written todo list unless the session starts with ${ENABLE} in its environment.`;

const todoHtml = (t) =>
  `<li class="todo" data-todo="${esc(t.id)}">${statusBadge(t.status, WORK)}<span class="t">${esc(t.status === "running" && t.active ? t.active : t.text)}</span></li>`;

function todosHtml(s) {
  if (!s.todos.length) return `<p class="none">${NO_TODOS}</p>`;
  const open = s.todos.filter((t) => t.status !== "done");
  const done = s.todos.filter((t) => t.status === "done");
  const key = `done:${s.id}`;
  const folded = done.length
    ? `<details class="done" data-fold="${esc(key)}"${work.open.has(key) ? " open" : ""}><summary>${done.length} done</summary><ol class="todos">${done.map(todoHtml).join("")}</ol></details>`
    : "";
  return `${open.length ? `<ol class="todos">${open.map(todoHtml).join("")}</ol>` : ""}${folded}`;
}

function agentHtml(a, now) {
  const time = elapsed((a.ended ? Date.parse(a.ended) : now) - Date.parse(a.started));
  const meta = [a.type ? `<span class="type mono">${esc(a.type)}</span>` : "", `<span class="time" title="How long it ran">${time}</span>`].join("");
  const last = a.last ? `<p class="last"><span class="visually-hidden">Last step: </span>${esc(a.last)}</p>` : "";
  const path = a.transcript ? `<p class="path mono" title="Its transcript">${esc(a.transcript)}</p>` : "";
  return `<li class="agent" data-agent="${esc(a.id)}"><div class="row">${statusBadge(a.status, WORK)}<span class="t">${esc(a.description || "Subagent")}</span>${meta}</div>${last}${path}</li>`;
}

function sessionHtml(s, n, now) {
  const id = `w-${n}`;
  const name = s.name ?? "Unnamed session";
  const details = `<span class="sid mono" title="Session ID">${esc(s.id.slice(0, 8))}</span>${s.folder ? `<span class="place mono" title="The folder the session works in">${esc(s.folder)}</span>` : ""}${statusBadge(s.state, WORK)}`;
  const agents = s.agents.length ? `<ul class="agents">${s.agents.map((a) => agentHtml(a, now)).join("")}</ul>` : '<p class="none">No subagents.</p>';
  return `<section class="session work-session" aria-labelledby="${id}"><div class="session-head"><h2 id="${id}">${esc(name)}</h2>${details}</div><h3>Todos</h3>${todosHtml(s)}<h3>Subagents</h3>${agents}</section>`;
}

/** The Work page's body for a list of sessions; `now` sets how long running agents have run. */
export function workHtml(sessions, now = Date.now()) {
  if (!sessions.length)
    return `<div class="empty"><p>No work tracked yet. A session's todos and subagents appear here once hoop's Claude Code plugin is installed (<code>hoop init</code>) and the session uses them.</p><p>Newer models keep no written todo list by default. To have one, start Claude Code with ${ENABLE} in its environment; hoop doesn't change your settings.</p></div>`;
  return sessions.map((s, n) => sessionHtml(s, n, now)).join("");
}

function paint() {
  document.title = "Work · hoop";
  // A refresh keeps focus on the same control.
  const active = document.activeElement;
  const fold = active?.closest?.("[data-fold]")?.dataset.fold;
  const err = work.error ? `<p class="empty" role="alert">${esc(work.error)}</p>` : "";
  app.innerHTML = frame("work", `<div class="list work"><header class="list-head"><h1>Work</h1></header>${err}${workHtml(work.sessions)}</div>`, work.info);
  if (fold) app.querySelector(`[data-fold="${CSS.escape(fold)}"] summary`)?.focus();
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
  paint();
}

document.addEventListener(
  "toggle",
  (e) => {
    const key = e.target.dataset?.fold;
    if (!key) return;
    if (e.target.open) work.open.add(key);
    else work.open.delete(key);
  },
  true,
);

/** Shows the Work page, and asks again every few seconds while the tab is visible. */
export async function renderWork(info) {
  work.info = info;
  await load();
  setInterval(() => document.visibilityState === "visible" && load(), window.HOOP_WORK_MS ?? 3000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load());
}
