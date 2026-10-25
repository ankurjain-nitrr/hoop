import type { counts } from "./activity.js";

type Listed = { id: string; title: string; revisions: number; status_key: string; superseded_by?: string; summary?: string };
export function waiting<T extends Listed>(list: T[]): T[];
export function openActions<T extends { state: string }>(items: T[]): T[];
export function countedTitle(title: string, n: number): string;
export function faviconHref(n: number): string;
export function arrivals<T extends Listed>(seen: Set<string>, now: T[]): T[];
type Pr = { url: string; repo: string; number: number; title?: string; state: string; ready?: boolean; conflicts?: boolean; checks?: string };
export function prAlerts(before: Map<string, string>, now: Pr[]): { title: string; tag: string; url: string }[];
export function workAlerts(sessions: Parameters<typeof counts>[0], now: number): { key: string; title: string; body: string }[];
export function notifying(): boolean;
export function notifyHtml(): string;
export function watchPending(opts?: {
  every?: number;
  prsEvery?: number;
  workEvery?: number;
  onList?: (list: unknown[]) => void;
  onActions?: (items: unknown[]) => void;
  checkActions?: boolean;
}): void;
export function waitingNow(): number | undefined;
