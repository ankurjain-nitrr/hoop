// The tracker page: the repository's tracker (or a change's) as a tree table.
import { api, esc, $ } from "/app.js";
import { onTreeChange, renderTree } from "/tree.js";

export async function renderTracker() {
  const files = await api("/api/trackers");
  const asked = new URLSearchParams(location.search).get("file");
  const file = asked || files[0];
  let t = null, error = "";
  if (file) {
    try { t = await api(`/api/tracker?file=${encodeURIComponent(file)}`); } catch (err) { error = err.message; }
  }
  const rows = t ? t.items.map((i) => ({ id: i.id, parent: i.parent, cells: i.cells })) : [];
  const draw = () => {
    const body = t ? renderTree(file, t.columns, rows)
      : `<p class="empty">${esc(error || "No tracker in this repository yet. Add docs/TRACKER.md with a table that has ID and Parent columns.")}</p>`;
    $("#app").innerHTML = `<div class="tracker-page">
      <header class="tracker-head"><h1>Tracker</h1>
        ${files.length ? `<label>File <select id="tracker-file">${files.map((f) => `<option ${f === file ? "selected" : ""}>${esc(f)}</option>`).join("")}</select></label>` : ""}
        <a href="/">All reviews</a></header>
      ${body}</div>`;
    $("#tracker-file")?.addEventListener("change", (e) => { location.search = `?file=${encodeURIComponent(e.target.value)}`; });
  };
  onTreeChange(draw);
  draw();
}
