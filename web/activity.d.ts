import type { WorkSession, WorkTodo, ViewAgent } from "../src/work.js";

type Health = { state: "running" | "waiting" | "stalled" | "notrunning"; note?: string };
type TodoState = {
  state: "done" | "waiting" | "inreview" | "blocked" | "running" | "stalled" | "notrunning";
  note: string;
  since?: string;
  link?: { href: string; text: string };
};
type Row = { session: string; kind: "todo" | "agent"; id: string };
type Sess = Pick<WorkSession, "id" | "state" | "activity" | "doing" | "todos" | "agents"> & { updated?: string };

export const STALE_MS: number;
export const ENDED_COUNT_MS: number;
export function span(ms: number): string;
export function sortSessions<T extends Pick<WorkSession, "state">>(sessions: T[]): T[];
export function sortTodos<T extends Pick<WorkTodo, "status">>(todos: T[]): T[];
export function sortAgents<T extends Pick<ViewAgent, "status">>(agents: T[]): T[];
export function todoState(
  s: Pick<WorkSession, "state" | "activity" | "doing" | "agents"> & { todos: Partial<WorkTodo>[] },
  t: Partial<WorkTodo> & Pick<WorkTodo, "status">,
  now: number,
): TodoState | undefined;
export function agentHealth(a: Pick<ViewAgent, "status" | "activity" | "doing">, now: number): Health | undefined;
export function clockText(started: string | undefined, activity: string | undefined, now: number, left?: boolean): string;
export function counts(sessions: Sess[], now: number): { running: Row[]; waiting: Row[]; stalled: Row[]; notrunning: Row[] };
