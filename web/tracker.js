// The tracker page: the repository's tracker (or a change's) as a tree table.
import { api, esc, frame, state, $ } from "/app.js";
import { onTreeChange, renderTree } from "/tree.js";

export async function renderTracker() {
  const params = new URLSearchParams(location.search);
  // The page offers each open repository, and keeps the chosen key in its address.
  const repos = state.info?.repos ?? [];
  const repo = repos.find((r) => r.key === params.get("repo")) ?? repos[0];
  const scope = repo ? `repo=${encodeURIComponent(repo.key)}` : "";
  const files = await api(`/api/trackers?${scope}`);
  const asked = params.get("file");
  const file = asked || files[0];
  let t = null, error = "";
  if (file) {
    try { t = await api(`/api/tracker?${scope}&file=${encodeURIComponent(file)}`); } catch (err) { error = err.message; }
  }
  const rows = t ? t.items.map((i) => ({ id: i.id, parent: i.parent, cells: i.cells })) : [];
  const draw = () => {
    const body = t ? renderTree(file, t.columns, rows)
      : `<p class="empty">${esc(error || "No tracker in this repository yet. Add docs/TRACKER.md with a table that has ID and Parent columns.")}</p>`;
    $("#app").innerHTML = frame("tracker", `<div class="tracker-page">
      <header class="tracker-head"><h1>Tracker</h1>
        ${repos.length > 1 ? `<label>Repository <select id="tracker-repo">${repos.map((r) => `<option value="${esc(r.key)}" ${r.key === repo?.key ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>` : ""}
        ${files.length ? `<label>File <select id="tracker-file">${files.map((f) => `<option ${f === file ? "selected" : ""}>${esc(f)}</option>`).join("")}</select></label>` : ""}</header>
      ${body}</div>`, repo, state.info);
    $("#tracker-repo")?.addEventListener("change", (e) => { location.search = `?repo=${encodeURIComponent(e.target.value)}`; });
    $("#tracker-file")?.addEventListener("change", (e) => {
      location.search = `?${repo ? `repo=${encodeURIComponent(repo.key)}&` : ""}file=${encodeURIComponent(e.target.value)}`;
    });
  };
  onTreeChange(draw);
  draw();
}
