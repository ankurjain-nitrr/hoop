// Tips (docs/DESIGN-LANGUAGE.md, Tips): one quiet line beside the control a feature uses, at the
// moment it applies, linking the feature's page in docs/using/. A tip goes for good, in this browser,
// once its feature is used, and the Tips switch on Home turns every tip off and on again.
import { icons } from "/icons.js";

const DOCS = "https://github.com/ankurjain-nitrr/hoop/blob/main/docs/using/";

/** Each tip: its words, its link's words, and its page. */
const TIPS = {
  select: { text: "Comment on just these words", link: "How comments work", page: "reviewing.md" },
  suggest: { text: "Suggest the wording instead", link: "How suggestions work", page: "suggestions.md" },
  build: { text: "Ask Claude for the next section", link: "How building works", page: "building.md" },
};

const OFF = "hoop:tips:off";
const USED = "hoop:tips:used:";

/** Reads a stored flag; storage that can't be read counts as unset. */
function flag(key) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Stores a flag, or clears it; storage that refuses keeps nothing, and the page works as before. */
function setFlag(key, on) {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Nothing is kept; the tip shows again next time.
  }
}

/** Whether tips show at all. */
const tipsOn = () => !flag(OFF);

/** Whether tip `name` shows now: tips are on and its feature wasn't used in this browser. */
export const showsTip = (name) => tipsOn() && !flag(USED + name);

/**
 * Retires tip `name` for good: its feature was used. A tip on the page keeps its place, unseen, so
 * nothing moves, and no control is described by it any more.
 */
export function retireTip(name) {
  setFlag(USED + name, true);
  for (const el of document.querySelectorAll(`[data-tip="${name}"]`)) {
    el.classList.add("tip-gone");
    for (const c of document.querySelectorAll(`[aria-describedby="${el.id}"]`)) c.removeAttribute("aria-describedby");
  }
}

/**
 * Tip `name`'s line, with `id` for the control's `aria-describedby`; empty when it doesn't show,
 * unless `keep`, when its place stays, unseen, as a page that showed it keeps it until it loads
 * again. The link opens the feature's page in a new tab, as other links to another site do.
 */
export function tipHtml(name, id, { keep = false } = {}) {
  const shows = showsTip(name);
  if (!shows && !keep) return "";
  const t = TIPS[name];
  return `<span class="tip${shows ? "" : " tip-gone"}" id="${id}" data-tip="${name}">${t.text}. <a href="${DOCS}${t.page}" target="_blank" rel="noopener noreferrer">${t.link}</a></span>`;
}

/** The Tips switch, beside Notify me on Home: pressed while tips are on, with a check. */
export function tipsSwitchHtml() {
  const on = tipsOn();
  return `<button type="button" class="btn small icon-label" id="tipsOn" aria-pressed="${on}" title="Show a short tip where a feature applies, until you use it">${on ? icons.check : ""}<span>Tips</span></button>`;
}

document.addEventListener("click", (e) => {
  const b = e.target.closest?.("#tipsOn");
  if (!b) return;
  setFlag(OFF, tipsOn());
  b.outerHTML = tipsSwitchHtml();
  document.getElementById("tipsOn")?.focus();
});
