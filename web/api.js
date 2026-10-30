// The pages' calls to hoop's API. Every page reaches the pages process through these, so a request
// that gets no answer reads the same everywhere, and every write goes as JSON, the only kind the API takes.
import { PAGES_STOPPED, setBanner } from "./frame.js";

const saysStopped = () => document.getElementById("banner")?.textContent === PAGES_STOPPED;

let probing;
/**
 * Asks whether the pages answer at all, after a request got no answer: the banner says they stopped
 * only when this fails too, so a page waking from sleep, whose first request fails, doesn't warn.
 * Requests that fail together share one probe.
 */
function confirmStopped() {
  probing ??= fetch("/api/info", { signal: AbortSignal.timeout(5000) })
    .then(
      (res) => res.ok && saysStopped() && setBanner(""),
      () => setBanner(PAGES_STOPPED),
    )
    .finally(() => (probing = undefined));
}

/**
 * `fetch` for the pages' own API. A request that gets no answer at all throws in plain words instead
 * of the browser's "Failed to fetch", flagged `pagesDown`, with the browser's error as its cause; an
 * abort or any other error keeps its own. A request that gets an answer clears the stopped banner.
 */
export async function request(path, init = {}) {
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (init.signal?.aborted || !(err instanceof TypeError)) throw err;
    confirmStopped();
    // A write may have landed before the connection dropped, so the person checks before retrying.
    const message =
      "hoop's pages didn't answer. If they stopped, any hoop command or a new session starts them again; check whether it went through before trying again.";
    throw Object.assign(new Error(message, { cause: err }), { pagesDown: true });
  }
  if (saysStopped()) setBanner("");
  return res;
}

/**
 * Calls the local API and returns the parsed reply; a reply that isn't JSON throws. A refusal throws
 * the reply's error, or the status text when it has none, with the reply as `body` and its status as
 * `status`.
 */
export async function api(path, init = {}) {
  const res = await request(path, init);
  if (res.ok) return res.json();
  const body = await res.json().catch(() => ({}));
  throw Object.assign(new Error(body?.error || res.statusText), { body, status: res.status });
}

/** Sends a JSON POST to the local API and returns the parsed reply; refusals throw as `api`'s do. */
export const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * Reads the local API for a background poll: the parsed reply, or undefined when it is refused or gets
 * no answer. It leaves the stopped banner alone, so a poll neither raises nor clears it.
 */
export const peek = (path) =>
  fetch(path)
    .then((r) => (r.ok ? r.json() : undefined))
    .catch(() => undefined);
