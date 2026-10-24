type Listed = { id: string; title: string; revisions: number; status_key: string; superseded_by?: string; summary?: string };
export function waiting<T extends Listed>(list: T[]): T[];
export function openActions<T extends { state: string }>(items: T[]): T[];
export function countedTitle(title: string, n: number): string;
export function faviconHref(n: number): string;
export function arrivals<T extends Listed>(seen: Set<string>, now: T[]): T[];
export function notifying(): boolean;
export function notifyHtml(): string;
export function watchPending(opts?: {
  every?: number;
  onList?: (list: unknown[]) => void;
  onActions?: (items: unknown[]) => void;
  checkActions?: boolean;
}): void;
