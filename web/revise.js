// What the build page shows beside a block in Preview: Generate again (on a block Claude wrote) and
// Comment with their forms, where each request stands, the comment threads with Claude's replies,
// and Claude's rewrite waiting to be accepted or undone. Pure HTML from the build's data, so
// build.js keeps only the page's state and events.
import { esc } from "./esc.js";

/** What a block request waits for, as its queued and taken lines say it. */
const WAITS = {
  rewrite: ["writes this again", "is writing this again"],
  revise: ["reads your comment", "is reading your comment"],
};

/** The line saying where a Generate again or a comment stands, or "" once Claude has answered it. */
export function requestLine(r) {
  if (!r || r.status === "written" || !WAITS[r.kind]) return "";
  const [queued, taken] = WAITS[r.kind];
  const text = r.status === "taken" ? `Claude ${taken}…` : `Queued: Claude ${queued}.`;
  return `<p class="bstatus"><span>${esc(text)}</span>${r.note ? ` <span class="bnote">Note: ${esc(r.note)}</span>` : ""}</p>`;
}

/** Generate again (on a block Claude wrote) and Comment, as labelled buttons under a block. `open` names the form that is open. */
export function blockActions(block, name, open) {
  const id = esc(block.id);
  const again =
    block.by === "claude"
      ? `<button type="button" class="btn small" data-b-regen="${id}" aria-expanded="${open === "regen"}" aria-label="${esc(`Generate again ${name}`)}">Generate again</button>`
      : "";
  return `<div class="bacts">${again}<button type="button" class="btn small" data-b-comment="${id}" aria-expanded="${open === "comment"}" aria-label="${esc(`Comment on ${name}`)}">Comment</button></div>`;
}

/** The form Comment opens: the words selected in the block, if any, the comment for Claude (kept when refused), and why it was refused. */
export function commentForm(block, name, selection, text = "", error = "") {
  const id = esc(block.id);
  return `<form class="bgen bcomment-form" data-b-comment-form="${id}">
    <p class="bon" id="bco-${id}">${selection ? `On “${esc(selection)}”` : "On the whole block"}</p>
    <label class="lab" for="bc-${id}">Comment on ${esc(name)} for Claude</label>
    <textarea id="bc-${id}" class="bnote-in" name="comment" rows="2" maxlength="2000" aria-describedby="bco-${id} bce-${id}" placeholder="For example: make this friendlier, or add an example">${esc(text)}</textarea>
    <p class="berr" id="bce-${id}" role="alert">${esc(error)}</p>
    <div class="row end"><div><button type="button" class="btn small" data-b-comment-cancel>Cancel</button><button type="submit" class="btn small primary">Comment</button></div></div>
  </form>`;
}

/** The open comment threads on a block: the words, the comment, Claude's replies, and Resolve. */
export function threadsHtml(threads, name) {
  return threads
    .map((t, k) => {
      const replies = t.replies.map((r) => `<p class="breply"><span class="who">${r.by === "claude" ? "Claude" : "You"}</span> ${esc(r.body)}</p>`).join("");
      const label = `Comment ${k + 1} on ${name}`;
      return `<div class="bthread" role="group" aria-label="${esc(label)}" data-thread="${esc(t.id)}">
        ${t.selection ? `<p class="bquote">“${esc(t.selection)}”</p>` : ""}${t.outdated ? '<p class="bstale">Claude has rewritten these words since.</p>' : ""}
        <p class="bcomment"><span class="who">You</span> ${esc(t.comment)}</p>${replies}
        <div class="row end"><button type="button" class="btn small" data-b-resolve="${esc(t.id)}" aria-label="${esc(`Resolve ${label}`)}">Resolve</button></div>
      </div>`;
    })
    .join("");
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
