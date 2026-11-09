export const DOC_LINES: readonly { field: "title" | "tldr" | "subtitle"; name: string }[];
export function docLineText(doc: { title: string; tldr: string; subtitle?: string }, line: number): string | undefined;
export function docLineName(line: number): string;
export const RECOMMENDED: string;
export function choiceLine(c: { id: string; label: string; recommended?: boolean }): string;
