export function frame(current: "home" | "work" | "", body: string, info?: { release?: string; code?: string; login?: string }): string;
export function announce(text: string): void;
export const PAGES_STOPPED: string;
export function request(path: string, init?: RequestInit): Promise<Response>;
