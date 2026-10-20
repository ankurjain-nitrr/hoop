import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hoopHome } from "./util.js";

/** One audit event: what happened, to which review, by whom, and whether it failed. */
export type AuditEvent = {
  at: string;
  event: string;
  review_id?: string;
  revision?: number;
  actor?: string;
  ok?: boolean;
  error?: string;
  errors?: string[];
  ms?: number;
  [key: string]: unknown;
};

export const auditPath = () => join(hoopHome(), "audit.jsonl");

/** Appends an event to ~/.hoop/audit.jsonl. Never throws: logging must not break a review. HOOP_AUDIT=0 turns it off. */
export function audit(event: string, data: Omit<AuditEvent, "at" | "event"> = {}): void {
  if (process.env.HOOP_AUDIT === "0") return;
  try {
    const path = auditPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + "\n");
  } catch {
    // best effort
  }
}

export function readAudit(path = auditPath()): AuditEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as AuditEvent];
      } catch {
        return [];
      }
    });
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** The numbers an improvement loop needs: where reviews stall, and what Claude gets wrong. */
export function summarize(events: AuditEvent[], sinceDays?: number) {
  const since = sinceDays ? Date.now() - sinceDays * 86400000 : 0;
  const ev = events.filter((e) => Date.parse(e.at) >= since);
  const submits = ev.filter((e) => e.event === "submit" && e.ok !== false);
  const firstSubmit = new Map<string, number>();
  for (const e of submits) if (e.review_id && !firstSubmit.has(e.review_id)) firstSubmit.set(e.review_id, Date.parse(e.at));
  const verdicts = ev.filter((e) => e.event === "review" && e.ok !== false);
  const firstVerdict = new Map<string, number>();
  for (const e of verdicts) if (e.review_id && !firstVerdict.has(e.review_id)) firstVerdict.set(e.review_id, Date.parse(e.at));
  const toVerdict = [...firstVerdict].flatMap(([id, t]) => (firstSubmit.has(id) ? [(t - firstSubmit.get(id)!) / 60000] : []));
  const revisions = new Map<string, number>();
  for (const e of submits) if (e.review_id) revisions.set(e.review_id, Math.max(revisions.get(e.review_id) ?? 0, e.revision ?? 1));
  const decided = ev.filter((e) => e.event === "decide_edit" && e.ok !== false);
  const proposed = ev.filter((e) => e.event === "propose_edits" && e.ok !== false).reduce((n, e) => n + Number(e.count ?? 0), 0);
  const large = ev.filter((e) => e.event === "propose_edits" && e.ok !== false).reduce((n, e) => n + Number(e.large ?? 0), 0);
  const failures = ev.filter((e) => e.ok === false);
  const reasons = new Map<string, number>();
  for (const f of failures)
    for (const r of f.errors?.length ? f.errors : [f.error ?? "unknown"]) {
      const key = `${f.event}: ${String(r)
        .replace(/"[^"]*"/g, '"…"')
        .replace(/\b(rv|th|ed)_[a-z0-9_]+/g, "$1_…")}`;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  const accepted = decided.filter((e) => e.action === "accept").length;
  return {
    events: ev.length,
    reviews: firstSubmit.size,
    approved: ev.filter((e) => e.event === "review" && e.verdict === "approved").length,
    median_minutes_to_first_verdict: median(toVerdict),
    mean_revisions_per_review: revisions.size ? [...revisions.values()].reduce((a, b) => a + b, 0) / revisions.size : null,
    suggestions_applied: ev.filter((e) => e.event === "apply_suggestion" && e.ok !== false).length,
    edits: {
      proposed,
      accepted,
      rejected: decided.length - accepted,
      acceptance_rate: decided.length ? accepted / decided.length : null,
      large_rewrites: large,
    },
    checks: {
      run: ev.filter((e) => e.event === "check" && e.ran === true).length,
      findings: ev.filter((e) => e.event === "check" && e.ran === true).reduce((n, e) => n + Number(e.findings ?? 0), 0),
      failed: ev.filter((e) => e.event === "check" && e.ran === false && e.reason !== "not_allowed").length,
    },
    failures: failures.length,
    top_failures: [...reasons]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count })),
  };
}
