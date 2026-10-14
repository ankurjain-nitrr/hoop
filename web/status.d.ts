export const REVIEW: Record<string, { label: string; tone: string; icon: string }>;
export const TRACKER: Record<string, string>;
export function statusBadge(key: string, note?: string): string;
export function statusChip(value: string): string;
