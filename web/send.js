// Sending from a text box, as the design language's "Writing and sending" asks, on every page. A
// box for long text (`data-send="long"`) sends with Ctrl+Enter, or ⌘+Enter on a Mac, and plain
// Enter starts a new line; any other box (`data-send="short"`) sends with Enter, and Shift+Enter
// starts a new line. Neither sends while an input method is composing. A box sends by pressing the
// button its `data-send-to` names, else by submitting its form; Escape presses the button its
// `data-cancel-to` names, where it has one, after a "sendcancel" event on the box that lets the page
// keep what was typed.

/** Whether the page runs on a Mac, where ⌘ takes the place of Ctrl in shortcuts. */
export const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** The modifier the pages name in their hints and titles: ⌘ on a Mac, else Ctrl. */
export const MOD = MAC ? "⌘" : "Ctrl";

/** Whether an input method is still composing this key press (Safari reports it only as key code 229). */
export const composing = (e) => e.isComposing || e.keyCode === 229;

/** Whether a key press sends from a box for long text (`long`), else from any other box, where Ctrl+Enter sends too. A held key's repeats match as well: the caller sends on the first press only. */
export function sendKey(e, long) {
  if (e.key !== "Enter" || composing(e) || e.altKey || e.shiftKey) return false;
  return !long || e.metaKey || e.ctrlKey;
}

/**
 * The line under a box for long text, naming the key and what it does: `verb` is "sends", "saves" or
 * "adds". `tag` is "span" where the box sits inside a paragraph, which can't hold another one.
 */
export const longHint = (id, verb, tag = "p") => `<${tag} class="hint" id="${id}">${MOD}+Enter ${verb}; Escape cancels.</${tag}>`;

/** The words under a box where Enter sends. */
export const SHORT_HINT = "Enter sends; Shift+Enter starts a new line.";

document.addEventListener("keydown", (e) => {
  const box = e.target.closest?.("[data-send]");
  if (!box) return;
  const cancel = box.dataset.cancelTo;
  if (e.key === "Escape" && cancel && !composing(e)) {
    e.preventDefault();
    box.dispatchEvent(new CustomEvent("sendcancel", { bubbles: true }));
    document.getElementById(cancel)?.click();
  } else if (sendKey(e, box.dataset.send === "long")) {
    e.preventDefault();
    // A held key repeats the press; it sends once.
    if (e.repeat) return;
    const to = box.dataset.sendTo;
    if (to) document.getElementById(to)?.click();
    else box.form?.requestSubmit();
  }
});
