import { createConnection } from "node:net";
import { usesHome } from "./sessions.js";
import type { ClaudeSession } from "./work.js";

// The one way hoop puts a message into a Claude Code session: the session's messaging socket, when it
// runs, has one and uses this hoop home. The pages process sends; each caller records how it went in
// its own place (a review's deliveries, a work record's changes).

/** Sends a message into a Claude Code session over its messaging socket: one line of JSON. */
export type Sender = (socket: string, text: string) => Promise<void>;

/** How long a send may take before it counts as failed. */
const SEND_MS = 3000;

/** Writes one user message line to a session's messaging socket, and resolves once it is written. */
export const sendToSession: Sender = (socket, text) =>
  new Promise((resolve, reject) => {
    const c = createConnection(socket);
    const timer = setTimeout(() => {
      c.destroy();
      reject(new Error("the session didn't take the message in time"));
    }, SEND_MS);
    c.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    c.on("connect", () =>
      c.end(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`, () => {
        clearTimeout(timer);
        // The session may keep its end open; the line is written, so close ours.
        setTimeout(() => c.destroy(), 500).unref();
        resolve();
      }),
    );
  });

/** Where a message to a session can go: its socket, or why it can't go. */
export type Channel = { socket: string } | { none: "no_session" | "other_home" };

/**
 * Whether the live session uses the hoop home `home` (`usesHome`), under its ID now and under
 * `owner`'s when it took over from an earlier one (`/clear`), so it can read back what a message
 * names. The session a throwaway hoop on a home of its own was started from uses another home.
 */
export function sharesHome(home: string, live: ClaudeSession, owner = live.session): boolean {
  const proc = () => (live.start ? { pid: live.pid, start: live.start } : undefined);
  return usesHome(home, live.session, proc) && (owner === live.session || usesHome(home, owner, proc));
}

/**
 * The live session's messaging socket, when it has one and shares the hoop home `home`
 * (`sharesHome`). `no_session` when it isn't running or takes no messages, `other_home` when it
 * uses another hoop home, which never reads what the message names.
 */
export function channel(home: string, live: ClaudeSession | undefined, owner?: string): Channel {
  if (!live?.socket) return { none: "no_session" };
  return sharesHome(home, live, owner) ? { socket: live.socket } : { none: "other_home" };
}

/** Sends `text` to `socket`, and says whether it went, with the error when it didn't. */
export async function sendText(socket: string, text: string, send: Sender = sendToSession): Promise<{ sent: true } | { sent: false; error: string }> {
  try {
    await send(socket, text);
    return { sent: true };
  } catch (err) {
    return { sent: false, error: (err as Error).message || String(err) };
  }
}
