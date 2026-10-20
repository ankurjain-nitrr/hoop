// The findings panel: the project's check outcome for the latest checked revision. Each
// placed finding shows its line through the line renderer and links to it.
import { esc } from "./esc.js";
import { renderLine } from "./inline.js";

/** The panel's HTML for a review view, or "" when the review has no stored outcome. */
export function checksPanel(view) {
  const c = view.checks;
  if (!c) return "";
  const latest = view.meta.revisions;
  const stale = c.revision < latest ? `<p class="checks-note">Revision ${latest} wasn't checked, so these findings are from revision ${c.revision}.</p>` : "";
  let body;
  // A check that didn't run is a warning, so a revision nobody checked never looks clean.
  if (!c.ran)
    body =
      c.reason === "running"
        ? `<p class="checks-state">${esc(c.message ?? "The check is running.")}</p>`
        : `<p class="checks-state warn" role="status"><b>Warning:</b> ${esc(c.message ?? "The check didn't run.")}</p>`;
  else if (!c.findings.length) body = `<p class="checks-state ok">No findings in revision ${c.revision}.</p>`;
  else body = `<ol class="checks-list">${c.findings.map((f) => findingHtml(view, f, c.revision)).join("")}</ol>`;
  const count = c.ran && c.findings.length ? ` <span class="count">${c.findings.length}</span>` : "";
  return `<section class="checks" aria-labelledby="checks-title"><h2 id="checks-title">Checks${count}</h2>${stale}${body}</section>`;
}

function findingHtml(view, f, checked) {
  const unplaced = () =>
    `<li><span class="checks-msg">${esc(f.message)}</span>${f.line ? ` <span class="checks-where">source line ${f.line}</span>` : ""}</li>`;
  if (!f.place) return unplaced();
  // A finding from an older revision shows that revision's line, and offers no jump, because the
  // latest revision's line may hold other words.
  if (checked < view.meta.revisions) {
    const old = view.history?.[checked]?.[f.place.item];
    const text = Array.isArray(old) ? old[f.place.line] : undefined;
    if (text === undefined) return unplaced();
    return `<li><span class="checks-msg">${esc(f.message)}</span>
      <span class="checks-line">${renderLine(text, [], view.history_blocks?.[checked]?.[f.place.item]?.[f.place.line])}</span></li>`;
  }
  const item = view.doc.items.find((i) => i.id === f.place.item);
  const text = item?.lines?.[f.place.line];
  if (text === undefined) return unplaced();
  return `<li><button class="checks-go" data-goto-item="${esc(item.id)}" data-goto-line="${f.place.line}"><span class="checks-msg">${esc(f.message)}</span>
    <span class="checks-line">${renderLine(text, [], item.blocks?.[f.place.line])}</span></button></li>`;
}
