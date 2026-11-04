// What the build page shows of a section's past and Claude's flags on it: the section's earlier
// versions, stepped through as a list of choices, with what changed since the one picked and Save to
// put it back; and Claude's notes on text it wrote that contradicts other text it wrote, each naming
// both places, with Resolve. Pure HTML from the build's data, so build.js keeps only the page's state
// and events.
import { esc } from "./esc.js";
import { icons } from "./icons.js";
import { readAt } from "./activity.js";
import { disclosure, foldCount } from "./fold.js";

/** How a version's text came to be, as its line in the list says it. */
const MADE = {
  generated: "Claude generated",
  continued: "Claude continued",
  rewrote: "Claude rewrote a block",
  edited: "You edited",
};

/** A version as the list names it: who made its text and when; the text a build started with says when it was replaced. */
export const versionLabel = (v) => (v.how ? `${MADE[v.how]} · ${readAt(v.at)}` : `Earlier text · replaced ${readAt(v.replaced)}`);

/** A section's versions, newest first. */
const newestFirst = (history) => [...(history?.versions ?? [])].reverse();

/** The version picked in a section's list: `pick` while it is kept, else the newest. */
export const pickedVersion = (history, pick) => newestFirst(history).find((v) => v.id === pick) ?? newestFirst(history)[0];

/** The disclosure on a section heading that opens its versions, with their count; nothing before it has one. */
export function versionsButton(block, name, history, open) {
  const n = history?.versions.length ?? 0;
  if (!n) return "";
  const id = esc(block.id);
  const button = disclosure({
    open,
    content: foldCount("Versions", n),
    attrs: `data-b-versions="${id}"`,
    controls: open ? `bv-${block.id}` : "",
    label: `Versions ${n} of ${name}`,
  });
  return `<div class="bvers">${button}</div>`;
}

/** One block in the change view: unchanged, only in the version ("del"), or new since ("add"), said in words as well as colour. */
function diffRow(kind, block, render) {
  const said = { del: "Only in this version: ", add: "New since this version: " }[kind];
  const mark = { del: "−", add: "+" }[kind] ?? "";
  return `<div class="bdiff-row${kind ? ` ${kind}` : ""}"><span class="bdiff-mark" aria-hidden="true">${mark}</span><div class="bdiff-text">${said ? `<span class="visually-hidden">${said}</span>` : ""}${render(block)}</div></div>`;
}

/**
 * What changed since a version, as the review page's Changes tab shows a revision: the version's
 * blocks the current text no longer has, struck through, then the current text, with what is new
 * since highlighted.
 */
function diffHtml(version, current, render) {
  const then = version.blocks.map((x) => x.text);
  const now = current.map((x) => x.text);
  const gone = version.blocks.filter((x) => !now.includes(x.text));
  if (!gone.length && now.every((t) => then.includes(t)) && then.length === now.length) return '<p class="bnote">Same as the text there now.</p>';
  return gone.map((x) => diffRow("del", x, render)).join("") + current.map((x) => diffRow(then.includes(x.text) ? "" : "add", x, render)).join("");
}

/**
 * A section's versions, open under its heading: how its current text came to be, the versions as a
 * list of choices (arrow keys step through them), what changed since the one picked against the text
 * there now (`current`), and Save, which puts it back, with its error line. `open` is the page's
 * state for them: the version picked, and the error Save last met.
 */
export function versionsPanel(block, name, history, current, { pick, error }, render) {
  const id = esc(block.id);
  const picked = pickedVersion(history, pick);
  const choices = newestFirst(history)
    .map(
      (v) =>
        `<label class="bver"><input type="radio" name="bv-${id}" value="${esc(v.id)}" data-b-version="${esc(v.id)}" data-b-on="${id}"${v === picked ? " checked" : ""}><span>${esc(versionLabel(v))}</span></label>`,
    )
    .join("");
  const now = history.current ? `The text there now: ${MADE[history.current.how]} · ${readAt(history.current.at)}. ` : "";
  return `<div class="bhist" id="bv-${id}" role="group" aria-label="${esc(`Versions of ${name}`)}">
    <p class="bnote">${esc(now)}Saving a version puts its text back under the heading, and the text there now stays here as a version.</p>
    <fieldset class="bver-list"><legend>Versions, newest first</legend>${choices}</fieldset>
    <p class="bdiff-k">What changed since this version: struck-through text was only in it; highlighted text is new.</p>
    <div class="bdiff">${diffHtml(picked, current, render)}</div>
    <div class="row end"><button type="button" class="btn small primary" data-b-restore="${id}" data-version="${esc(picked.id)}" aria-label="${esc(`Save this version of ${name}: ${versionLabel(picked)}`)}" aria-describedby="bve-${id}">Save this version</button></div>
    <p class="berr" id="bve-${id}" role="alert">${esc(error ?? "")}</p>
  </div>`;
}

/**
 * Claude's open notes on the section headed by `block` (or on the block, when it is under no
 * section): the note, who made it and when, the two places it is about, with a link to the other,
 * and Resolve. `place` names a block for people, with the heading it is under.
 */
export function notesHtml(notes, block, name, place) {
  return notes
    .filter((n) => n.section === block.id)
    .map((n, k) => {
      const label = `Claude's note ${k + 1} on ${name}`;
      return `<div class="bflag" role="group" aria-label="${esc(label)}" data-note="${esc(n.id)}">
        <p class="bflag-head">${icons.warning}<span class="who">Claude</span> <span class="m">${esc(readAt(n.at))}</span></p>
        <p class="bflag-text">${esc(n.note)}</p>
        <p class="bflag-where">Where: ${esc(place(n.with))}, and <a class="bjump" href="#bk-${esc(n.block)}" data-b-jump="${esc(n.block)}">${esc(place(n.block))}</a>.</p>
        <div class="row end"><button type="button" class="btn small" data-b-resolve-note="${esc(n.id)}" aria-label="${esc(`Resolve ${label}`)}">Resolve</button></div>
      </div>`;
    })
    .join("");
}
