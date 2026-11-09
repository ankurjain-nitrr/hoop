// Claude Code's permission prompts on Work and in Home's Waiting on you (decided in rv_mw7wkyez20853f):
// "Waiting on you: permission", the tool, the command or change in full, then Allow once and Deny,
// whose box asks for an optional reason Claude reads. An answered prompt says where it was answered.
// The terminal still asks, and the first answer wins: an answer that comes second shows how the
// first went. The answers go to the pages process only from these pages (src/web.ts).
import { esc } from "/esc.js";
import { readAt } from "/activity.js";
import { peek, post } from "/api.js";
import { announce } from "/frame.js";

/** How long an answered prompt keeps its line on the pages. */
const SHOWN_MS = 10 * 60 * 1000;

/** What the pages know of the prompts, the Deny box open on one, and the last refusal, by prompt. */
const perm = { list: [], denying: null, reason: "", errors: {}, busy: null, pages: [], repaint: (local = true) => perm.pages.forEach((f) => f(local)) };

/**
 * Adds how a page shows the prompts again: `local` after the person's own press, which shows at once,
 * else after a load, which waits for an open form as any refresh does. Each page's own checks it is
 * the one showing.
 */
export function onPermissions(repaint) {
  perm.pages.push(repaint);
}

/** Loads the prompts; shows them again when they changed. A load that fails keeps what the page has. */
export async function loadPermissions() {
  const list = await peek("/api/permissions");
  if (!Array.isArray(list) || JSON.stringify(list) === JSON.stringify(perm.list)) return;
  perm.list = list;
  if (perm.denying && !list.some((p) => p.id === perm.denying && p.state === "waiting")) perm.denying = null;
  perm.repaint(false);
}

/** Whether a Deny box is open, which a refresh waits for, so it never drops what is typed. */
export const permissionFormOpen = () => perm.denying !== null;

/** The prompts to show, newest first: each waiting one, and those answered in the last ten minutes. `session` keeps one session's. */
export function prompts(session, now = Date.now()) {
  return perm.list.filter((p) => (!session || p.session === session) && (p.state === "waiting" || now - Date.parse(p.settled_at ?? p.at) < SHOWN_MS));
}

/** Where a settled prompt was answered, with when. */
const ANSWERED = {
  allowed: (p) => `Allowed in hoop ${readAt(p.settled_at)}`,
  denied: (p) => `Denied in hoop ${readAt(p.settled_at)}`,
  terminal: (p) => `Answered in the terminal ${readAt(p.settled_at)}`,
  handed: () => "Answer this in the terminal.",
};

/** The lines a change's text is: one each. */
const lines = (text) => String(text ?? "").split("\n");

/** What the call will run or change, in full: a command, a file's change, its new text, or its input. */
function callHtml(p) {
  const i = p.input ?? {};
  if (p.tool === "Bash" && typeof i.command === "string")
    return `${i.description ? `<p class="d">${esc(i.description)}</p>` : ""}<pre class="perm-call"><code>${esc(i.command)}</code></pre>`;
  if ((p.tool === "Edit" || p.tool === "MultiEdit") && typeof i.file_path === "string") {
    const edits = Array.isArray(i.edits) ? i.edits : [{ old_string: i.old_string, new_string: i.new_string }];
    const diff = edits
      .map(
        (e) =>
          lines(e.old_string)
            .map((l) => `<span class="perm-del">- ${esc(l)}</span>`)
            .join("\n") +
          "\n" +
          lines(e.new_string)
            .map((l) => `<span class="perm-add">+ ${esc(l)}</span>`)
            .join("\n"),
      )
      .join("\n");
    return `<p class="d mono">${esc(i.file_path)}</p><pre class="perm-call"><code>${diff}</code></pre>`;
  }
  if (p.tool === "Write" && typeof i.file_path === "string")
    return `<p class="d mono">${esc(i.file_path)}</p><pre class="perm-call"><code>${esc(i.content ?? "")}</code></pre>`;
  return `<pre class="perm-call"><code>${esc(JSON.stringify(i, null, 2))}</code></pre>`;
}

/** Allow once and Deny on a waiting prompt, or its Deny box with the reason Claude reads, and its error line. */
function controlsHtml(p) {
  const id = esc(p.id);
  const err = `<p id="${id}-err" class="rename-error" role="alert">${esc(perm.errors[p.id] ?? "")}</p>`;
  const busy = perm.busy === p.id ? " disabled" : "";
  if (perm.denying === p.id)
    return `<form class="decline" data-perm-deny-form="${id}"><label for="${id}-reason">Reason (optional; Claude reads it)</label><input id="${id}-reason" name="reason" maxlength="500" autocomplete="off" value="${esc(perm.reason)}" aria-describedby="${id}-err"><button type="submit" class="btn small danger"${busy}>Deny</button><button type="button" class="btn small" data-perm-cancel>Cancel</button>${err}</form>`;
  return `<div class="action-btns"><button type="button" class="btn small primary" data-perm-allow="${id}"${busy}>Allow once</button><button type="button" class="btn small" data-perm-deny="${id}"${busy}>Deny</button></div>${err}`;
}

/**
 * One prompt's card: "Waiting on you: permission" and the tool, what it will run or change, and
 * Allow once and Deny while it waits; once answered, where. `h` is its heading level; `from` names
 * its session, on Home.
 */
export function promptHtml(p, h, from = "") {
  const id = esc(p.id);
  const tool = `<span class="tag">${esc(p.tool)}</span>`;
  // Once answered, a note: the tool and where it was answered.
  if (p.state !== "waiting") return `<p class="note perm-answered" data-permission="${id}">${tool} ${esc(ANSWERED[p.state]?.(p) ?? "")}</p>`;
  return `<article class="action permission" data-permission="${id}" aria-labelledby="${id}-t"><div class="action-head"><h${h} id="${id}-t" class="t">Waiting on you: permission</h${h}>${tool}</div>${from ? `<p class="m">from ${esc(from)}</p>` : ""}${callHtml(p)}${controlsHtml(p)}</article>`;
}

/** Sends an answer; a refusal (as when the terminal answered first) shows under the buttons, and the list loads again. */
async function answer(id, body) {
  perm.busy = id;
  perm.errors[id] = "";
  perm.repaint();
  try {
    const p = await post(`/api/permissions/${encodeURIComponent(id)}`, body);
    perm.denying = null;
    perm.reason = "";
    announce(ANSWERED[p.state]?.(p) ?? "");
  } catch (err) {
    perm.errors[id] = err.message;
  }
  perm.busy = null;
  await loadPermissions();
  perm.repaint();
}

document.addEventListener("click", (e) => {
  const t = e.target.closest?.("button");
  if (!t) return;
  if (t.dataset.permAllow) void answer(t.dataset.permAllow, { decision: "allow" });
  else if (t.dataset.permDeny) {
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
