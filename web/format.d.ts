export type ToolName = "bold" | "italic" | "link" | "bullets" | "numbers" | "table" | "code";
export const TOOLS: [ToolName, string][];
export function applyTool(tool: ToolName, text: string, start: number, end: number): { text: string; start: number; end: number };
export function headingSource(level: number, words: string): string;
