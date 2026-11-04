export function frame(current: "home" | "work" | "", body: string, info?: { release?: string; code?: string; login?: string; work?: boolean }): string;
export function updateNav(info?: { work?: boolean }): void;
export function announce(text: string): void;
export const PAGES_STOPPED: string;
export function setBanner(text: string): void;
