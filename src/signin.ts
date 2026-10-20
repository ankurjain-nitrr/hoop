import { randomBytes } from "node:crypto";
import { audit } from "./audit.js";
import { hoopConfig } from "./util.js";

/**
 * hoop's GitHub OAuth App, which runs GitHub's device sign-in. A device sign-in needs no secret.
 * A person can name their own app as `github_client_id` in their settings.
 */
export const CLIENT_ID = "";

/** How long a sign-in lasts in one browser. */
export const SIGNIN_MS = 8 * 60 * 60 * 1000;

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
  off: "The sign-in is off in your hoop settings, so approvals are marked unverified.",
};

type Flow = { device: string; expires: number; interval: number; state: FlowState; id?: string; handed: boolean; login?: string };

const token = (bytes: number) => randomBytes(bytes).toString("hex");

/**
 * GitHub device sign-ins for the pages process. Each finished sign-in keeps only the person's login
 * under a random ID, in memory, for eight hours; the GitHub token is dropped once the login is read.
 * A restart forgets every sign-in.
 */
export class SignIns {
  private flows = new Map<string, Flow>();
  private signins = new Map<string, { login: string; expires: number }>();

  constructor(
    private readonly home: string,
    private readonly opts: { fetch?: typeof fetch; now?: () => number; pollMs?: number } = {},
  ) {}

  private get now() {
    return (this.opts.now ?? Date.now)();
  }
  private get fetch() {
    return this.opts.fetch ?? fetch;
  }
  settings() {
    return signInSettings(this.home);
  }

  /** Starts a device sign-in, and polls GitHub in the background until it ends. */
  async start(): Promise<{ flow: string; user_code: string; verification_uri: string; expires_at: string }> {
    const s = this.settings();
    if (!s.enabled) throw new SignInError("off", NEXT_STEP.off);
    if (!s.clientId) throw new SignInError("not_set_up", NEXT_STEP.not_set_up);
    let code: { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string };
    try {
      const res = await this.fetch(`${s.githubUrl}/login/device/code`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: s.clientId, scope: "" }).toString(),
      });
      code = (await res.json()) as typeof code;
    } catch {
      audit("signin_failed", { state: "offline" });
      throw new SignInError("offline", NEXT_STEP.offline);
    }
    if (!code.device_code || !code.user_code || !code.verification_uri) {
      audit("signin_failed", { state: "not_set_up", error: code.error });
      throw new SignInError("not_set_up", NEXT_STEP.not_set_up);
    }
    const flow = token(16);
    const expires = this.now + (code.expires_in ?? 900) * 1000;
    this.flows.set(flow, { device: code.device_code, expires, interval: (code.interval ?? 5) * 1000, state: "waiting", handed: false });
    audit("signin_start", {});
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
        this.signins.set(id, { login, expires: this.now + SIGNIN_MS });
        Object.assign(f, { state: "signed_in", id, login });
        audit("signin_done", { actor: login });
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
    audit("signin_failed", { state });
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
    const s = this.signins.get(id);
    if (!s) return undefined;
    if (this.now >= s.expires) {
      this.signins.delete(id);
      return undefined;
    }
    return s.login;
  }
}
