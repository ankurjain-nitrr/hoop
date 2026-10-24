export type At = { item: string; line: number; revision: number };
export function showsBelow(at: Pick<At, "item" | "line">, item: string, idx: number, count: number): boolean;
export function isOutdated(at: At, latest: number, then: string | undefined, now: string | undefined): boolean;
