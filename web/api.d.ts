export function request(path: string, init?: RequestInit): Promise<Response>;
export function api(path: string, init?: RequestInit): Promise<unknown>;
export function post(path: string, body: unknown): Promise<unknown>;
export function peek(path: string): Promise<unknown>;
