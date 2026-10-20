// The change request page: every change in a repository, grouped as queued, in progress, done and
// closed, with its labels, documents, reviews, pull requests, history and size.
import { $, api, esc, frame, state } from "/app.js";
import { statusChip } from "/status.js";

const GROUPS = [
  ["queued", "Queued"],
  ["in progress", "In progress"],
  ["done", "Done"],
  ["closed", "Closed"],
];
const view = { project: "" };

const when = (iso) => (iso ? new Date(iso).toLocaleDateString([], { dateStyle: "medium" }) : "");

function sizeHtml(s) {
  if (!s || (!s.files && !s.lines && !s.unknown.length)) return "";
  const total = `<span class="mono">${s.files} files, ${s.lines} lines</span> estimated`;
  const unknown = s.unknown.length ? ` · no estimate for ${s.unknown.map(esc).join(", ")}` : "";
  const flag = s.flagged
    ? `<p class="cr-flag" role="note"><b>Over devloop's limit</b> of 50 files or 2,500 lines for one change. ${s.kept ? "The requester chose to keep it whole." : "Consider splitting it into smaller changes."}</p>`
    : "";
  return `<p class="cr-size">${total}${unknown}</p>${flag}`;
}

function historyHtml(c) {
  if (!c.history.length) return "";
  const rows = c.history
    .map(
      (h) =>
        `<li><time datetime="${esc(h.at)}">${esc(when(h.at))}</time> <b>${esc(h.event)}</b>${h.verdict ? ` · ${esc(h.verdict)}` : ""}${h.note ? `: ${esc(h.note)}` : ""} <span class="m">${esc(h.by)}</span></li>`,
    )
    .join("");
  return `<details class="cr-history"><summary>History <span class="count">${c.history.length}</span></summary><ol>${rows}</ol></details>`;
}

function changeHtml(c) {
  const docs = c.documents
    .map((d) => {
      const name = d.doc.toUpperCase();
      const review = d.review_id
        ? `<a href="/r/${esc(d.review_id)}">${esc(name)} review</a> ${statusChip(d.stale ? "stale" : (d.status ?? "open"))}`
        : `<span class="m">${esc(name)}: no review yet</span>`;
      return `<li>${review}${d.path ? ` <code>${esc(d.path)}</code>` : ""}</li>`;
    })
    .join("");
  const prs = c.prs.length ? `<p class="cr-prs">Pull requests: ${c.prs.map((n) => `<span class="mono">#${n}</span>`).join(", ")}</p>` : "";
  return `<article class="cr" id="cr-${esc(c.id)}">
    <header class="cr-head"><span class="mono cr-id">${esc(c.id)}</span><h3>${esc(c.title)}</h3>${statusChip(c.step)}</header>
    <p class="cr-labels"><span class="tbadge t-${esc(c.type)}">${esc(c.type)}</span> <span class="cr-chip">${esc(c.kind)}</span> <span class="cr-chip">project: ${esc(c.project)}</span>${c.created ? ` <span class="m">captured ${esc(when(c.created))}</span>` : ""}</p>
    ${c.request ? `<p class="cr-request">Request: <code>${esc(c.request)}</code></p>` : ""}
    <ul class="cr-docs">${docs}</ul>${prs}${sizeHtml(c.size)}${historyHtml(c)}</article>`;
}

/** Renders the page for the repository in the address, or the server's own. */
export async function renderChanges() {
  const params = new URLSearchParams(location.search);
  const repos = state.info?.repos ?? [];
  const repo = repos.find((r) => r.key === params.get("repo")) ?? repos[0];
  const scope = repo ? `?repo=${encodeURIComponent(repo.key)}` : "";
  const list = await api(`/api/changes${scope}`);
  const draw = () => {
    const projects = [...new Set(list.map((c) => c.project))].sort();
    const shown = list.filter((c) => !view.project || c.project === view.project);
    const body = list.length
      ? GROUPS.map(([key, label]) => {
          const rows = shown.filter((c) => c.group === key);
          return rows.length
            ? `<section class="group" aria-labelledby="cg-${key.replace(" ", "-")}"><h2 id="cg-${key.replace(" ", "-")}">${label} <span class="count">${rows.length}</span></h2>${rows.map(changeHtml).join("")}</section>`
            : "";
        }).join("") || '<p class="empty">No changes in this project.</p>'
      : '<p class="empty">No change requests in this repository yet. Ask your agent to capture a request, or run <code>hoop cr create</code> with the request on standard input.</p>';
    $("#app").innerHTML = frame(
      "changes",
      `<div class="list changes-page"><header class="tracker-head"><h1>Change requests</h1>
        ${repos.length > 1 ? `<label>Repository <select id="changes-repo">${repos.map((r) => `<option value="${esc(r.key)}" ${r.key === repo?.key ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>` : ""}
        ${projects.length > 1 ? `<label>Project <select id="changes-project"><option value="">All</option>${projects.map((p) => `<option ${p === view.project ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></label>` : ""}
      </header>${body}</div>`,
      repo,
      { ...state.info, login: state.whoami?.login },
    );
    $("#changes-repo")?.addEventListener("change", (e) => {
      location.search = `?repo=${encodeURIComponent(e.target.value)}`;
    });
    $("#changes-project")?.addEventListener("change", (e) => {
      view.project = e.target.value;
      draw();
      $("#changes-project")?.focus();
    });
  };
  draw();
}
