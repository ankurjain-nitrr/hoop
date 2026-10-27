export const REVIEW: Record<string, { label: string; tone: string; icon: string }>;
export function statusBadge(key: string): string;
export type Verdict = "approved" | "changes_requested";
export const VERDICT: Record<Verdict, string>;
export function verdictNow(state: { comments?: number; answers?: number; threads?: number; questions?: number; unanswered?: number }): {
  verdict: Verdict;
  reason: string;
};
