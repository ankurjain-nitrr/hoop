export type Draft = {
  key: string;
  item: string;
  line: number;
  text?: string;
  thread?: string;
  range?: { start: number; end: number; quote: string };
  body?: string;
  suggestion?: string;
};
export type Stale = Draft & { revision: number; answer?: { choice: string; title?: string; label?: string } };
export type Drafts = {
  revision?: number;
  pending?: Draft[];
  answers?: Record<string, string>;
  labels?: Record<string, { title?: string; label?: string }>;
  resolved?: string[];
  summary?: string;
  composer?: (Draft & Record<string, unknown>) | null;
  stale?: Stale[];
};
export type Now = {
  revision: number;
  lineAt(item: string, line: number): string | undefined;
  linesOf(item: string): string[] | undefined;
  choiceLabel(item: string, choice: string): string | undefined;
};
export function readDrafts(id: string): Drafts | undefined;
export function writeDrafts(id: string, drafts: Drafts): void;
export function rebase(drafts: Drafts, now: Now): Required<Omit<Drafts, "composer">> & { composer: Drafts["composer"] };
