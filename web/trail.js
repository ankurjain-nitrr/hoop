// The audit trail: every event on a review, with who and when, as a section that starts collapsed.
// A name a poster chose is marked self named; only a GitHub sign-in names someone for sure.
import { esc, hooks, state } from "/app.js";

const when = (at) => new Date(at).toLocaleString();

hooks.after.push(() => {
  const entries = state.view?.trail ?? [];
  if (!entries.length) return "";
  const rows = entries
    .map(
      (e) =>
        `<li><time datetime="${esc(e.at)}">${esc(when(e.at))}</time> <span class="trail-who">${esc(e.who)}${e.signed_in ? ' <span class="trail-mark ok">GitHub</span>' : ' <span class="trail-mark">self named</span>'}</span> ${esc(e.what)}${e.revision ? ` <span class="trail-rev">rev ${e.revision}</span>` : ""}</li>`,
    )
    .join("");
  return `<details class="trail"><summary>Audit trail <span class="count">${entries.length}</span></summary><ol class="trail-list">${rows}</ol></details>`;
});
