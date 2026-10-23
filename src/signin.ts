import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hoopConfig, writeAtomic } from "./util.js";

/**
 * hoop's GitHub OAuth App, which runs GitHub's device sign-in. A device sign-in needs no secret.
 * A person can name their own app as `github_client_id` in their settings.
 */
export const CLIENT_ID = "Ov23li0jID8GekaEpcRP";

/** How long a sign-in lasts in one browser. */
export const SIGNIN_MS = 24 * 60 * 60 * 1000;

/** The file in the hoop folder that keeps live sign-ins across restarts of the pages process. */
export const SIGNINS_FILE = "signins.json";

export type FlowState = "waiting" | "signed_in" | "expired" | "denied" | "offline";

/** What the sign-in reads from the person's own settings; a repository can't set any of it. */
export type SignInSettings = { enabled: boolean; clientId: string; githubUrl: string; apiUrl: string };

export function signInSettings(home: string): SignInSettings {
  const c = hoopConfig(home);
  const clientId = typeof c.github_client_id === "string" && c.github_client_id ? c.github_client_id : CLIENT_ID;
  return {
    enabled: c.signin !== false,
    clientId,
    githubUrl: typeof c.github_url === "string" ? c.github_url.replace(/\/$/, "") : "https://github.com",
    apiUrl: typeof c.github_api_url === "string" ? c.github_api_url.replace(/\/$/, "") : "https://api.github.com",
  };
}

/** A sign-in that can't start, with the state the page shows and what to do next. */
export class SignInError extends Error {
  constructor(
    readonly state: "not_set_up" | "offline" | "off",
    message: string,
  ) {
    super(message);
  }
}

/** What to do next in each state, as the page says it. */
export const NEXT_STEP: Record<FlowState | "not_set_up" | "off", string> = {
  waiting: "Enter the code on GitHub, then come back here.",
  signed_in: "You're signed in. Submit your review.",
  expired: "The code expired before it was entered. Start the sign-in again.",
  denied:
    "GitHub said no. Start again, or set your own GitHub OAuth App as github_client_id in your hoop settings, or turn the sign-in off there with signin: false.",
  offline:
    "hoop couldn't reach GitHub. Check your connection and start again, or set your own GitHub OAuth App as github_client_id in your hoop settings, or turn the sign-in off there with signin: false.",
  not_set_up:
    "Sign-in isn't set up in this hoop. Set your own GitHub OAuth App as github_client_id in your hoop settings, or turn the sign-in off there with signin: false.",
  off: "The sign-in is off in your hoop settings, so a verdict needs no sign-in.",
};

type Flow = { device: string; expires: number; interval: number; state: FlowState; id?: string; handed: boolean; login?: string };

const token = (bytes: number) => randomBytes(bytes).toString("hex");
const hash = (id: string) => createHash("sha256").update(id).digest("hex");

/**
 * GitHub device sign-ins for the pages process. Each finished sign-in keeps only the person's login
 * for 24 hours, under the SHA-256 hash of a random ID that only the browser holds; the GitHub token
 * is dropped once the login is read. Sign-ins are kept in `signins.json` in the hoop folder, so a
 * restart of the pages process keeps them, and the file alone can't be used as a sign-in.
 */
export class SignIns {
  private flows = new Map<string, Flow>();
  /** Live sign-ins by the hash of their ID. */
  private signins = new Map<string, { login: string; expires: number }>();

  constructor(
    private readonly home: string,
    private readonly opts: { fetch?: typeof fetch; now?: () => number; pollMs?: number; timeoutMs?: number } = {},
  ) {
    this.load();
  }

  private get file() {
    return join(this.home, SIGNINS_FILE);
  }
  /** Reads the kept sign-ins, and drops expired or malformed ones from the file; an unreadable file counts as none. */
  private load() {
    let entries: unknown;
    try {
      entries = (JSON.parse(readFileSync(this.file, "utf8")) as { signins?: unknown }).signins;
    } catch {
      return;
    }
    if (!Array.isArray(entries)) return;
    for (const e of entries as Record<string, unknown>[]) {
      if (typeof e?.hash !== "string" || !/^[a-f0-9]{64}$/.test(e.hash)) continue;
      if (typeof e.login !== "string" || !e.login || typeof e.expires !== "number") continue;
      if (this.now < e.expires) this.signins.set(e.hash, { login: e.login, expires: e.expires });
    }
    if (this.signins.size !== entries.length) this.save();
  }
  /** Writes the live sign-ins, readable only by the person. A failed write keeps them in memory only. */
  private save() {
    const signins = [...this.signins].map(([h, s]) => ({ hash: h, login: s.login, expires: s.expires }));
    try {
      mkdirSync(this.home, { recursive: true });
      writeAtomic(this.file, `${JSON.stringify({ signins }, null, 2)}\n`, 0o600);
    } catch {
      /* the sign-ins stay in memory until the next write */
    }
  }

  private get now() {
    return (this.opts.now ?? Date.now)();
  }
  /** A request to GitHub that gives up after ten seconds, so a GitHub that never answers reads as offline. */
  private fetch(url: string, init: RequestInit = {}) {
    return (this.opts.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000) });
  }

  /** Forgets flows that ended and every sign-in past its 24 hours. */
  private sweep() {
    for (const [id, f] of this.flows) if (f.state !== "waiting" || this.now >= f.expires) this.flows.delete(id);
    const before = this.signins.size;
    for (const [h, s] of this.signins) if (this.now >= s.expires) this.signins.delete(h);
    if (this.signins.size !== before) this.save();
  }
  settings() {
    return signInSettings(this.home);
  }

  /** Starts a device sign-in, and polls GitHub in the background until it ends. */
  async start(): Promise<{ flow: string; user_code: string; verification_uri: string; expires_at: string }> {
    const s = this.settings();
    if (!s.enabled) throw new SignInError("off", NEXT_STEP.off);
    if (!s.clientId) throw new SignInError("not_set_up", NEXT_STEP.not_set_up);
    this.sweep();
    let code: { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string };
    try {
      const res = await this.fetch(`${s.githubUrl}/login/device/code`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: s.clientId, scope: "" }).toString(),
      });
      code = (await res.json()) as typeof code;
    } catch {
      throw new SignInError("offline", NEXT_STEP.offline);
    }
    if (!code.device_code || !code.user_code || !code.verification_uri) {
      throw new SignInError("not_set_up", NEXT_STEP.not_set_up);
    }
    const flow = token(16);
    const expires = this.now + (code.expires_in ?? 900) * 1000;
    this.flows.set(flow, { device: code.device_code, expires, interval: (code.interval ?? 5) * 1000, state: "waiting", handed: false });
    this.poll(flow);
    return { flow, user_code: code.user_code, verification_uri: code.verification_uri, expires_at: new Date(expires).toISOString() };
  }

  private poll(flow: string) {
    const f = this.flows.get(flow);
    if (f?.state !== "waiting") return;
    const timer = setTimeout(() => void this.check(flow), this.opts.pollMs ?? f.interval);
    timer.unref?.();
  }

  /** Asks GitHub once whether the person entered the code. */
  async check(flow: string): Promise<void> {
    const f = this.flows.get(flow);
    if (f?.state !== "waiting") return;
    if (this.now >= f.expires) return this.end(f, "expired");
    const s = this.settings();
    try {
      const res = await this.fetch(`${s.githubUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: s.clientId, device_code: f.device, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }).toString(),
      });
      const body = (await res.json()) as { access_token?: string; error?: string; interval?: number };
      if (body.access_token) {
        const user = await this.fetch(`${s.apiUrl}/user`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${body.access_token}` } });
        const login = ((await user.json()) as { login?: unknown }).login;
        if (typeof login !== "string" || !login) return this.end(f, "denied");
        const id = token(32);
        this.signins.set(hash(id), { login, expires: this.now + SIGNIN_MS });
        this.save();
        Object.assign(f, { state: "signed_in", id, login });
        return;
      }
      if (body.error === "authorization_pending") return this.poll(flow);
      if (body.error === "slow_down") {
        f.interval = (body.interval ?? f.interval / 1000 + 5) * 1000;
        return this.poll(flow);
      }
      return this.end(f, body.error === "expired_token" ? "expired" : "denied");
    } catch {
      return this.end(f, "offline");
    }
  }

  private end(f: Flow, state: FlowState) {
    f.state = state;
  }

  /**
   * A flow's state, with what to do next. Once signed in, the first answer hands over the sign-in's
   * ID for the browser to keep; later answers never repeat it.
   */
  status(flow: string): { state: FlowState; next: string; login?: string; signin?: string } | undefined {
    const f = this.flows.get(flow);
    if (!f) return undefined;
    if (f.state === "waiting" && this.now >= f.expires) this.end(f, "expired");
    const out = { state: f.state, next: NEXT_STEP[f.state], ...(f.login ? { login: f.login } : {}) };
    if (f.state !== "signed_in" || f.handed) return out;
    f.handed = true;
    return { ...out, signin: f.id };
  }

  /** The login of a live sign-in, or undefined. */
  who(id: string | undefined): string | undefined {
    if (!id) return undefined;
    const h = hash(id);
    const s = this.signins.get(h);
    if (!s) return undefined;
    if (this.now >= s.expires) {
      this.signins.delete(h);
      this.save();
      return undefined;
    }
    return s.login;
  }
}
