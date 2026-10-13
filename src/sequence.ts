import { Changes, type ChangeRecord, type DocKind } from "./changes.js";
import { HoopError, repoDir as defaultRepo } from "./util.js";
import type { ReviewMeta, Store } from "./store.js";
import { trackChange } from "./tracker.js";
import { audit } from "./audit.js";
import { join } from "node:path";

export const DOCS: DocKind[] = ["prd", "hld", "lld"];
const NAME: Record<DocKind, string> = { prd: "PRD", hld: "HLD", lld: "LLD" };
const before = (doc: DocKind): DocKind | undefined => DOCS[DOCS.indexOf(doc) - 1];

export type DocState = { doc: DocKind; review?: string; status?: ReviewMeta["status"]; approved_at?: string; stale: boolean };

/**
 * Holds a change's documents to the order PRD → HLD → LLD. A document's current review is the last
 * one linked to it. Staleness is computed: an approval is stale when the document before it isn't
 * approved, is itself stale, or was approved after it.
 */
export class Sequencer {
  constructor(readonly store: Store, readonly changes: Changes) {}

  private approvedAt(meta: ReviewMeta): string | undefined {
    if (meta.status !== "approved") return undefined;
    return meta.approved_at ?? this.store.allFeedback(meta.id).filter((f) => f.verdict === "approved").at(-1)?.at ?? meta.updated;
  }

  state(cr: string | ChangeRecord): DocState[] {
    const rec = typeof cr === "string" ? this.changes.get(cr) : cr;
    const out: DocState[] = [];
    for (const doc of DOCS) {
      const review = rec.reviews[doc]?.at(-1);
      const meta = review ? this.store.meta(review) : undefined;
      const approved_at = meta && this.approvedAt(meta);
      const prev = out.at(-1);
      const stale = Boolean(approved_at && prev && (!prev.approved_at || prev.stale || prev.approved_at > approved_at));
      out.push({ doc, review, status: meta?.status, approved_at, stale });
    }
    return out;
  }

  /** What stops a review of `doc` from opening: the document before it must be approved and current (FR-4). */
  blockers(cr: string, doc: DocKind): string[] {
    const prev = before(doc);
    if (!prev) return [];
    const s = this.state(cr).find((x) => x.doc === prev)!;
    return problem(cr, s) ? [problem(cr, s)!] : [];
  }

  /** Records a review as the document's current one and moves the change's step up to it. */
  async link(cr: string, doc: DocKind, reviewId: string): Promise<void> {
    const rec = this.changes.get(cr);
    if (rec.reviews[doc]?.at(-1) !== reviewId) this.changes.addReview(cr, doc, reviewId);
    // A change from before the registry has no step history; it is at intake.
    const at = this.changes.step(cr) ?? "intake";
    const order = ["intake", "prd", "hld", "lld"];
    if (order.includes(at) && order.indexOf(at) < order.indexOf(doc)) await this.changes.moveStep(cr, doc, { by: "claude" });
  }

  /** Whether the change can be built: PRD, HLD and LLD approved and none stale (FR-5, FR-7). */
  ready(cr: string | ChangeRecord): { ok: boolean; missing: string[] } {
    const rec = typeof cr === "string" ? this.changes.get(cr) : cr;
    const missing = this.state(rec).flatMap((s) => problem(rec.id, s) ?? []);
    return { ok: !missing.length, missing };
  }
}

/** Why a document doesn't count as approved, with the command that fixes it (NFR-1). */
function problem(cr: string, s: DocState): string | undefined {
  const name = NAME[s.doc];
  if (!s.review) return `${cr} has no ${name} review; run hoop submit ${name}.md --cr ${cr} --doc ${s.doc}`;
  if (s.status === "closed") return `${name} review ${s.review} is closed; start a new one with hoop submit ${name}.md --cr ${cr} --doc ${s.doc}`;
  if (s.status !== "approved") return `${name} review ${s.review} is not approved; run hoop feedback ${s.review}`;
  if (s.stale) return `${name} review ${s.review} is stale (an earlier document changed); resubmit it with hoop submit ${name}.md --review ${s.review}`;
  return undefined;
}

/** A registry whose build step is gated by the sequencer and whose records show on `docs/TRACKER.md`. */
export function gatedChanges(store: Store, repoDir = defaultRepo(), hooks: ConstructorParameters<typeof Changes>[1] = {}): { changes: Changes; sequencer: Sequencer } {
  let sequencer!: Sequencer;
  // The record is already saved when this runs, so a tracker that can't be updated is logged, not thrown.
  const onRecord = hooks.onRecord ?? ((rec: ChangeRecord) => {
    try {
      trackChange(join(repoDir, "docs", "TRACKER.md"), rec);
    } catch (err) {
      audit("tracker_sync", { ok: false, cr: rec.id, error: (err as Error).message });
    }
  });
  const changes = new Changes(repoDir, { ...hooks, onRecord, gate: async (rec, step) => [...((await hooks.gate?.(rec, step)) ?? []), ...(step === "build" ? sequencer.ready(rec).missing : [])] });
  sequencer = new Sequencer(store, changes);
  return { changes, sequencer };
}

export function checkDoc(doc: unknown): DocKind {
  if (!DOCS.includes(doc as DocKind)) throw new HoopError(`unknown document ${String(doc)}; one of prd, hld, lld`, [{ path: "change.doc", message: "expected prd, hld or lld" }]);
  return doc as DocKind;
}
