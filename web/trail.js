// The history: every event on a review, with who and when, as a section that starts collapsed. Each
// submitted review says when the agent read it.
import { esc, hooks, receiptHtml, state } from "/app.js";

const when = (at) => new Date(at).toLocaleString();

hooks.after.push(() => {
  const entries = state.view?.trail ?? [];
  if (!entries.length) return "";
  const rows = entries
    .map(
      (e) =>
        `<li><time datetime="${esc(e.at)}">${esc(when(e.at))}</time> <span class="trail-who">${esc(e.who)}</span> ${esc(e.what)}${e.revision ? ` <span class="trail-rev">rev ${e.revision}</span>` : ""}${e.review ? ` ${receiptHtml(e.review)}` : ""}</li>`,
    )
    .join("");
  return `<details class="trail"><summary>History <span class="count">${entries.length}</span></summary><ol class="trail-list">${rows}</ol></details>`;
});
