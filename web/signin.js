// The GitHub sign-in that approving and requesting changes need. The page starts GitHub's device sign-in, shows the code
// and each state with its next step, and keeps the sign-in's ID in this page's own storage, which
// belongs to this address and port. Every request sends it in a header.
import { $, api, esc, post, state } from "/app.js";

const KEY = "hoop:signin";

/** The sign-in this browser holds for these pages, if any. */
export function signinId() {
  try {
    return localStorage.getItem(KEY) || undefined;
  } catch {
    return undefined;
  }
}
function keep(id) {
  try {
    localStorage.setItem(KEY, id);
  } catch {}
}

const flow = { state: "idle", code: null, copied: false, uri: null, next: "", id: null, timer: null };

/** Who is signed in, whether the sign-in is on, and whether it is set up. */
export async function refreshWhoami() {
  state.whoami = await api("/api/whoami").catch(() => null);
  return state.whoami;
}

/** The panel's HTML for the chosen verdict, or "" when the verdict needs no sign-in. */
function panelHtml(verdict) {
  const who = state.whoami;
  if (verdict === "comment" || !who) return "";
  if (!who.signin) return `<p class="signin-note">The sign-in is off in your hoop settings, so this verdict needs no sign-in.</p>`;
  if (who.login) return `<p class="signin-note ok">Signed in with GitHub as <b>${esc(who.login)}</b>.</p>`;
  const lead = `<p class="signin-note"><b>${verdict === "approved" ? "Sign in with GitHub to approve." : "Sign in with GitHub to request changes."}</b></p>`;
  if (flow.state === "idle") return `${lead}<button class="btn small primary" id="signinStart" type="button">Sign in with GitHub</button>`;
  if (flow.state === "starting") return `${lead}<p class="signin-note">Asking GitHub for a code…</p>`;
  if (flow.state === "waiting")
    return `${lead}<p class="signin-note">Enter this code on GitHub: <code class="signin-code">${esc(flow.code)}</code> <button class="btn small" id="signinCopy" type="button">${flow.copied ? "Copied" : "Copy code"}</button></p>
      <p><a class="btn small" href="${esc(flow.uri)}" target="_blank" rel="noopener noreferrer">Open GitHub</a> <span class="signin-note">${esc(flow.next)}</span></p>`;
  return `${lead}<p class="signin-note warn" role="alert">${esc(flow.next)}</p>${flow.state === "not_set_up" || flow.state === "off" ? "" : `<button class="btn small" id="signinStart" type="button">Start again</button>`}`;
}

const chosen = () => document.querySelector('input[name="verdict"]:checked')?.value ?? "comment";

/** Shows the panel for the chosen verdict, and holds Submit until a needed sign-in is done. */
export function updatePanel() {
  const panel = $("#signinPanel");
  if (!panel) return;
  const html = panelHtml(chosen());
  panel.innerHTML = html;
  panel.hidden = !html;
  const who = state.whoami;
  const needs = chosen() !== "comment" && who?.signin && !who.login;
  const submit = $("#submitReview");
  if (submit) submit.disabled = Boolean(needs);
}

async function start() {
  clearTimeout(flow.timer);
  Object.assign(flow, { state: "starting" });
  updatePanel();
  try {
    const started = await post("/api/signin", {});
    Object.assign(flow, {
      state: "waiting",
      copied: false,
      code: started.user_code,
      uri: started.verification_uri,
      next: "Waiting for you to enter the code on GitHub.",
    });
    poll(started.flow);
  } catch (err) {
    Object.assign(flow, { state: err.body?.state ?? "offline", next: err.body?.next ?? err.message });
  }
  updatePanel();
}

function poll(id) {
  flow.timer = setTimeout(async () => {
    const s = await api(`/api/signin/${id}`).catch(() => ({ state: "offline", next: "The pages stopped answering. Start the sign-in again." }));
    if (s.state === "waiting") return poll(id);
    if (s.state === "signed_in" && s.signin) {
      keep(s.signin);
      await refreshWhoami();
      flow.state = "idle";
    } else Object.assign(flow, { state: s.state, next: s.next });
    updatePanel();
    $("#signinPanel")?.focus();
  }, 2000);
}

document.addEventListener("change", (e) => {
  if (e.target.name === "verdict") updatePanel();
});
document.addEventListener("click", (e) => {
  if (e.target.closest?.("#signinStart")) start();
  if (e.target.closest?.("#signinCopy"))
    navigator.clipboard?.writeText(flow.code).then(
      () => {
        flow.copied = true;
        updatePanel();
        $("#signinCopy")?.focus();
      },
      () => {},
    );
});
