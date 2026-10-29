export function request(path: string, init?: RequestInit): Promise<Response>;
export function api(path: string, init?: RequestInit): Promise<any>;
export function post(path: string, body: unknown): Promise<any>;
export function peek(path: string): Promise<any>;
