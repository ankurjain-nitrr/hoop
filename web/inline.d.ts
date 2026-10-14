import type { Block } from "./blocks.js";
export type Decoration = { start: number; end: number; mark?: boolean; insert?: string };
export function renderLine(text: string, decorations?: Decoration[], block?: Block): string;
export function shownText(text: string, block?: Block): string;
export function widen(text: string, block: Block | undefined, start: number, end: number): { start: number; end: number };
export function sourceOffset(container: Element, node: Node, offset: number): number | null;
