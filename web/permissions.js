// Claude Code's permission prompts on Work and in Home's Waiting on you (decided in rv_mw7wkyez20853f):
// "Waiting on you: permission", the tool, the command or change in full, then Allow once and Deny,
// whose box asks for an optional reason Claude reads. An answered prompt says where it was answered.
// The terminal still asks, and the first answer wins: an answer that comes second shows how the
// first went. The answers go to the pages process only from these pages (src/web.ts).
//
// Nothing here may approve by accident: cards go oldest first, so a new one joins below; an answered
// card keeps its place and size for a moment, so the next one never moves up under the pointer; an
// Allow once press is ignored for a moment after any answer or after the cards changed or moved, and
// a double click counts once; focus after an answer goes to its note, never to a button that approves.
import { esc } from "/esc.js";
import { readAt } from "/activity.js";
import { peek, post } from "/api.js";
import { announce } from "/frame.js";

/** How long an answered prompt keeps its line on the pages. */
const SHOWN_MS = 10 * 60 * 1000;
/** How long an answered card keeps its place and size, and how long Allow once waits after the cards changed. */
const HOLD_MS = 1500;
const QUIET_MS = 500;
/** The longest a reason runs, as Won't do's. */
const REASON_MAX = 200;

/**
 * What the pages know of the prompts; the Deny box open on one and what is typed in it; each
 * prompt's last refusal; the answer being sent; the answered cards held in place, with their heights;
 * until when Allow once waits; and how each page shows the prompts again.
 */
const perm = {
  list: [],
  denying: null,
  reason: "",
  errors: {},
  busy: null,
  holds: {},
  quietUntil: 0,
  pages: [],
  repaint: (local = true) => perm.pages.forEach((f) => f(local)),
};

/**
 * Adds how a page shows the prompts again: `local` after the person's own press, which shows at once,
 * else after a load, which waits for an open form as any refresh does. Each page's own checks it is
 * the one showing.
 */
export function onPermissions(repaint) {
  perm.pages.push(repaint);
}

/** The order and states the cards show, to tell when they changed or moved. */
const layout = (list) => list.map((p) => `${p.id}:${p.state}`).join(",");

/** A prompt's card on the page, if it shows. */
const cardOf = (id) => document.querySelector(`[data-permission="${CSS.escape(id)}"]`);

/**
 * Holds a card that is being answered or was answered elsewhere in its place, at the height it has
 * now, read before any repaint, so the next card never moves up under the pointer; it lets go after
 * HOLD_MS, or, with `later` false, when the caller says (`letGo`).
 */
function hold(id, later = true) {
  const card = cardOf(id);
  if (!card || perm.holds[id]) return;
  perm.holds[id] = card.getBoundingClientRect().height;
  if (later) letGo(id);
}

/** Lets a held card go HOLD_MS from now: from when it shows answered, not from the press. */
function letGo(id) {
  setTimeout(() => {
    delete perm.holds[id];
    perm.quietUntil = Date.now() + QUIET_MS;
    perm.repaint(false);
  }, HOLD_MS);
}

/** Loads the prompts; shows them again when they changed. A load that fails keeps what the page has. */
export async function loadPermissions() {
  const list = await peek("/api/permissions");
  if (!Array.isArray(list) || JSON.stringify(list) === JSON.stringify(perm.list)) return;
  // A card answered elsewhere, as in the terminal, keeps its place a moment too.
  const was = new Map(perm.list.map((p) => [p.id, p.state]));
  for (const p of list) if (was.get(p.id) === "waiting" && p.state !== "waiting") hold(p.id);
  // Cards that changed or moved: Allow once waits a moment, so a press aimed at one lands on no other.
  if (layout(list) !== layout(perm.list)) perm.quietUntil = Date.now() + QUIET_MS;
  perm.list = list;
  if (perm.denying && !list.some((p) => p.id === perm.denying && p.state === "waiting")) perm.denying = null;
  perm.repaint(false);
}

/** Whether a Deny box is open, which a refresh waits for, so it never drops what is typed. */
export const permissionFormOpen = () => perm.denying !== null;

/** The prompts to show, oldest first, so a new one joins below: each waiting one, and those answered in the last ten minutes. `session` keeps one session's. */
export function prompts(session, now = Date.now()) {
  return perm.list
    .filter((p) => (!session || p.session === session) && (p.state === "waiting" || p.id in perm.holds || now - Date.parse(p.settled_at ?? p.at) < SHOWN_MS))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Where a settled prompt was answered, with when. */
const ANSWERED = {
  allowed: (p) => `Allowed in hoop ${readAt(p.settled_at)}`,
  denied: (p) => `Denied in hoop ${readAt(p.settled_at)}`,
  terminal: (p) => `Answered in the terminal ${readAt(p.settled_at)}`,
  handed: () => "Answer this in the terminal.",
};

/**
 * The characters that change or hide what text shows: controls (but tab and newline), bidi marks and
 * overrides, zero widths, and the line and paragraph separators. Built from code points, so the
 * source holds none of them.
 */
function hiddenCharacters() {
  const ranges = [
    [0x00, 0x08],
    [0x0b, 0x1f],
    [0x7f, 0x9f],
    [0x61c, 0x61c],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2028, 0x2029],
    [0x2060, 0x2064],
    [0x2066, 0x2069],
    [0xfeff, 0xfeff],
  ];
  const hex = (n) => `\\u${n.toString(16).padStart(4, "0")}`;
  return new RegExp(`[${ranges.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join("")}]`, "gu");
}

/** Characters that change or hide what text shows (controls, bidi overrides, zero widths, line and paragraph separators), shown as markers. */
const HIDDEN = hiddenCharacters();
/** Text as it will run, escaped, with each hidden character as a visible marker such as ⟨U+202E⟩. */
const shown = (text) => esc(String(text ?? "").replace(HIDDEN, (c) => `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`));

/** A change's lines, each marked removed or added; an empty text has none. */
const marked = (text, cls, mark) =>
  text === undefined || text === null || text === ""
    ? []
    : String(text)
        .split("\n")
        .map((l) => `<span class="${cls}">${mark} ${shown(l)}</span>`);

/** The fields a card shows in its own way, by tool; every other field goes in its list. */
const OWN = {
  Bash: ["command", "description"],
  Edit: ["file_path", "old_string", "new_string"],
  MultiEdit: ["file_path", "edits"],
  Write: ["file_path", "content"],
};
/** Fields that widen what a call may do, which head the list. */
const WIDENS = new Set(["dangerouslyDisableSandbox", "replace_all", "run_in_background"]);

/** The call's other fields, as a key and value list, those that widen what it may do first. */
function fieldsHtml(i, own) {
  const rest = Object.keys(i)
    .filter((k) => !own.includes(k))
    .sort((a, b) => Number(WIDENS.has(b)) - Number(WIDENS.has(a)));
  if (!rest.length) return "";
  const row = (k) => `<dt${WIDENS.has(k) ? ' class="perm-widens"' : ""}>${shown(k)}</dt><dd><code>${shown(JSON.stringify(i[k]))}</code></dd>`;
  return `<dl class="perm-fields">${rest.map(row).join("")}</dl>`;
}

/** What the call will run or change, in full: a command, a file's change, its new text, or its input; then its other fields. */
function callHtml(p) {
  const i = p.input ?? {};
  const own = OWN[p.tool] ?? [];
  if (p.tool === "Bash" && typeof i.command === "string")
    return `${i.description ? `<p class="d">${shown(i.description)}</p>` : ""}<pre class="perm-call"><code>${shown(i.command)}</code></pre>${fieldsHtml(i, own)}`;
  if (p.tool === "Edit" && typeof i.file_path === "string") return `<p class="d mono">${shown(i.file_path)}</p>${editHtml(i)}${fieldsHtml(i, own)}`;
  if (p.tool === "MultiEdit" && typeof i.file_path === "string" && Array.isArray(i.edits))
    // Each edit's diff, then its own fields, such as its replace_all.
    return `<p class="d mono">${shown(i.file_path)}</p>${i.edits.map((e) => editHtml(e) + fieldsHtml(e ?? {}, EDIT_TEXT)).join("")}${fieldsHtml(i, own)}`;
  if (p.tool === "Write" && typeof i.file_path === "string")
    return `<p class="d mono">${shown(i.file_path)}</p><pre class="perm-call"><code>${shown(i.content ?? "")}</code></pre>${fieldsHtml(i, own)}`;
  return `<pre class="perm-call"><code>${shown(JSON.stringify(i, null, 2))}</code></pre>`;
}

/** An edit's own text fields, which its diff shows. */
const EDIT_TEXT = ["old_string", "new_string"];
/** One edit's change, as removed and added lines. */
const editHtml = (e) =>
  `<pre class="perm-call"><code>${[...marked(e?.old_string, "perm-del", "-"), ...marked(e?.new_string, "perm-add", "+")].join("\n")}</code></pre>`;

/** A prompt's short name for its buttons: its tool and the start of what it runs or changes. */
function shortName(p) {
  const i = p.input ?? {};
  const what = String(i.command ?? i.file_path ?? i.url ?? "")
    .replace(HIDDEN, " ")
    .replace(/\s+/g, " ")
    .trim();
  return what ? `${p.tool} ${what.length > 40 ? `${what.slice(0, 39)}…` : what}` : p.tool;
}

/** Allow once and Deny on a waiting prompt, or its Deny box with the reason Claude reads, and its error line. */
function controlsHtml(p) {
  const id = esc(p.id);
  const name = esc(shortName(p));
  const err = `<p id="${id}-err" class="rename-error" role="alert">${esc(perm.errors[p.id] ?? "")}</p>`;
  const busy = perm.busy === p.id ? " disabled" : "";
  if (perm.denying === p.id)
    return `<form class="decline" data-perm-deny-form="${id}"><label for="${id}-reason">Reason (optional; Claude reads it)</label><input id="${id}-reason" name="reason" maxlength="${REASON_MAX}" autocomplete="off" value="${esc(perm.reason)}" aria-describedby="${id}-err"><button type="submit" class="btn small" aria-label="Deny: ${name}"${busy}>Deny</button><button type="button" class="btn small" data-perm-cancel aria-label="Cancel denying: ${name}">Cancel</button>${err}</form>`;
  return `<div class="action-btns"><button type="button" class="btn small primary" data-perm-allow="${id}" aria-label="Allow once: ${name}"${busy}>Allow once</button><button type="button" class="btn small" data-perm-deny="${id}" aria-label="Deny: ${name}"${busy}>Deny</button></div>${err}`;
}

/** A prompt's element ID, as Work's counts link to it. */
const elementId = (p) => `permission-${p.session}-${p.id}`.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * One prompt's card: "Waiting on you: permission" and the tool, what it will run or change, and
 * Allow once and Deny while it waits; once answered, a note of where. An answered card held in place
 * keeps its height. `h` is its heading level; `from` names its session, on Home.
 */
export function promptHtml(p, h, from = "") {
  const id = esc(p.id);
  const tool = `<span class="tag-tool">${esc(p.tool)}</span>`;
  const note = `<p class="note perm-answered" tabindex="-1" data-permission-note="${id}">${tool} ${esc(ANSWERED[p.state]?.(p) ?? "")}</p>`;
  if (p.state !== "waiting") {
    const held = p.id in perm.holds ? ` style="min-height:${perm.holds[p.id]}px"` : "";
    const line = note.replace("<p ", `<p data-permission="${id}" `);
    return held ? `<div class="perm-held"${held}>${line}</div>` : line;
  }
  return `<article class="action permission" id="${elementId(p)}" tabindex="-1" data-permission="${id}" aria-labelledby="${id}-t"><div class="action-head"><h${h} id="${id}-t" class="t">Waiting on you: permission</h${h}>${tool}</div>${from ? `<p class="m">from ${esc(from)}</p>` : ""}${callHtml(p)}${controlsHtml(p)}</article>`;
}

/** Puts the focus on a prompt's note once it is answered, never on a button that approves. */
const focusNote = (id) => document.querySelector(`[data-permission-note="${CSS.escape(id)}"]`)?.focus();

/** Puts the focus on a prompt's card while its answer is sent: not on another card's buttons. */
const focusCard = (id) => cardOf(id)?.focus({ preventScroll: true });

/** Sends an answer; a refusal (as when the terminal answered first) shows under the buttons, and the list loads again. */
async function answer(id, body) {
  // Measured before any repaint replaces the card; it lets go once the answer shows.
  hold(id, false);
  perm.busy = id;
  perm.errors[id] = "";
  perm.quietUntil = Date.now() + QUIET_MS;
  focusCard(id);
  perm.repaint();
  focusCard(id);
  let ok = false;
  try {
    const p = await post(`/api/permissions/${encodeURIComponent(id)}`, body);
    perm.denying = null;
    perm.reason = "";
    announce(ANSWERED[p.state]?.(p) ?? "");
    ok = true;
  } catch (err) {
    perm.errors[id] = err.message;
  }
  perm.busy = null;
  perm.quietUntil = Date.now() + QUIET_MS;
  await loadPermissions();
  perm.repaint();
  if (id in perm.holds) letGo(id);
  // A prompt still waiting (the post failed) takes the focus back on its own Allow once; else its note.
  const again = document.querySelector(`[data-perm-allow="${CSS.escape(id)}"]`);
  if (!ok && again) again.focus();
  else focusNote(id);
}

document.addEventListener("click", (e) => {
  const t = e.target.closest?.("button");
  if (!t) return;
  if (t.dataset.permAllow) {
    // A double click counts once, and a press right after an answer or after the cards moved counts for nothing.
    if (e.detail > 1 || Date.now() < perm.quietUntil || perm.busy) return;
    void answer(t.dataset.permAllow, { decision: "allow" });
  } else if (t.dataset.permDeny) {
    perm.denying = t.dataset.permDeny;
    perm.reason = "";
    perm.repaint();
    document.getElementById(`${t.dataset.permDeny}-reason`)?.focus();
  } else if (t.hasAttribute("data-perm-cancel")) {
    const id = perm.denying;
    perm.denying = null;
    perm.repaint();
    document.querySelector(`[data-perm-deny="${CSS.escape(id ?? "")}"]`)?.focus();
  }
});

document.addEventListener("input", (e) => {
  if (e.target.closest?.("[data-perm-deny-form]")) perm.reason = e.target.value;
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest?.("[data-perm-deny-form]");
  if (!form) return;
  e.preventDefault();
  const reason = perm.reason.trim();
  void answer(form.dataset.permDenyForm, { decision: "deny", ...(reason ? { reason } : {}) });
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !perm.denying || !e.target.closest?.("[data-perm-deny-form]")) return;
  const id = perm.denying;
  perm.denying = null;
  perm.repaint();
  document.querySelector(`[data-perm-deny="${CSS.escape(id)}"]`)?.focus();
});
