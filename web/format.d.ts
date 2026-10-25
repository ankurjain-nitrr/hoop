export type ToolName = "bold" | "italic" | "link" | "bullets" | "numbers" | "table" | "code";
export const TOOLS: [ToolName, string, string?][];
export const TABLE_TOOLS: ToolName[];
export function applyTool(tool: ToolName, text: string, start: number, end: number, opts?: { inline?: boolean }): { text: string; start: number; end: number };
export function headingSource(level: number, words: string): string;
