// The history: every event on a review, with who and when, as a section that starts folded. Each
// submitted review says when Claude read it.
import { esc, hooks, readAt, receiptHtml, state } from "/app.js";
import { foldBody, foldButton, foldCount, foldedByDefault } from "/fold.js";

foldedByDefault("trail:");

hooks.after.push(() => {
  const entries = state.view?.trail ?? [];
  if (!entries.length) return "";
  const rows = entries
    .map(
      (e) =>
        `<li><time datetime="${esc(e.at)}">${esc(readAt(e.at))}</time> <span class="trail-who">${esc(e.who)}</span> ${esc(e.what)}${e.revision ? ` <span class="trail-rev">rev ${e.revision}</span>` : ""}${e.review ? ` ${receiptHtml(e.review)}` : ""}</li>`,
    )
    .join("");
  const key = `trail:${state.view.meta.id}`;
  return `<div class="trail">${foldButton(key, "trail-body", foldCount("History", entries.length), "item", { here: true })}<div ${foldBody(key, "trail-body")}><ol class="trail-list">${rows}</ol></div></div>`;
});
