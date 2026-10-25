// What the build page shows beside a block Claude wrote: Generate again with its form, where the
// request stands, and Claude's rewrite waiting to be accepted or undone. Pure HTML from the build's
// data, so build.js keeps only the page's state and events.
import { esc } from "./esc.js";

/** The line saying where a Generate again stands, or "" once Claude has written the block. */
export function requestLine(r) {
  if (!r || r.status === "written" || r.kind !== "rewrite") return "";
  const text = r.status === "taken" ? "Claude is writing this again…" : "Queued: Claude writes this again when its session next checks the build.";
  return `<p class="bstatus"><span>${esc(text)}</span>${r.note ? ` <span class="bnote">Note: ${esc(r.note)}</span>` : ""}</p>`;
}

/** Generate again, as a labelled button under a block Claude wrote. */
export function blockActions(block, name, open) {
  if (block.by !== "claude") return "";
  return `<div class="bacts"><button type="button" class="btn small" data-b-regen="${esc(block.id)}" aria-expanded="${open}" aria-label="${esc(`Generate again ${name}`)}">Generate again</button></div>`;
}

/** The form Generate again opens: what should change, and whether Claude writes everything under the heading instead. */
export function regenForm(block, name, heading) {
  const id = esc(block.id);
  const wide = heading
    ? `<label class="bcheck"><input type="checkbox" name="all" id="br-all-${id}"> Everything under the heading “${esc(heading.title)}”</label>`
    : "";
  return `<form class="bgen" data-b-regen-form="${id}"${heading ? ` data-heading="${esc(heading.id)}"` : ""}>
    <label class="lab" for="br-${id}">What should change in ${esc(name)}? (optional)</label>
    <input id="br-${id}" class="bnote-in" name="note" maxlength="500" autocomplete="off" placeholder="For example: shorter, with an example">
    ${wide}
    <div class="row end"><div><button type="button" class="btn small" data-b-regen-cancel>Cancel</button><button type="submit" class="btn small primary">Generate again</button></div></div>
  </form>`;
}

/** Claude's rewrite of a block, waiting: what the block said before, with Accept and Undo. `render` shows a block as it reads. */
export function changeBar(change, block, name, render) {
  const id = esc(block.id);
  const before = change.before.map(render).join("");
  return `<div class="bchange" role="group" aria-label="${esc(`Claude's change to ${name}`)}">
    <p class="bchange-head">Claude changed this.</p>
    <details class="bbefore"><summary>What it said before</summary><div class="bbefore-body">${before}</div></details>
    <div class="row end"><div><button type="button" class="btn small" data-b-unchange="${id}" aria-label="${esc(`Undo Claude's change to ${name}`)}">Undo</button><button type="button" class="btn small primary" data-b-keep="${id}" aria-label="${esc(`Accept Claude's change to ${name}`)}">Accept</button></div></div>
  </div>`;
}
