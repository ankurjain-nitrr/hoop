// The gate file that says a session's review may be waiting on the person: `<hoop home>/work/<session>.review`.
// The Work gate's script (plugins/hoop/scripts/gate-work.sh) asks hoop about a file write only while
// it exists, so a session with nothing waiting starts no process. hoop writes it when the session
// submits a review or a revision, and the gate removes it once it has told the session, or finds
// nothing waiting (src/review-gate.ts).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validSession } from "./owner.js";

/** The gate file of `session`'s waiting reviews in the hoop folder `home`. */
export const reviewMarkPath = (home: string, session: string) => join(home, "work", `${session}.review`);

/** Marks that `session` submitted review `id`, so the gate checks its next file write. */
export function markReviewWait(home: string, session: string, id: string): void {
  if (!validSession(session)) return;
  mkdirSync(join(home, "work"), { recursive: true });
  writeFileSync(reviewMarkPath(home, session), `${id}\n`);
}

/** Removes the mark: nothing waits, or the gate told the session about all that does. */
export function clearReviewWait(home: string, session: string): void {
  rmSync(reviewMarkPath(home, session), { force: true });
}
