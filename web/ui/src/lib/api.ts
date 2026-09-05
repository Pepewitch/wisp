/**
 * Thin client of the wisp HTTP API (D1) — the same contract as the classic
 * web/index.html: the bearer token lives in localStorage under the SAME key
 * (one login covers both UIs), POST /api/session mints the HttpOnly cookie
 * EventSource needs, and the token NEVER goes in a URL (a prior audit).
 *
 * Any 401 opens the token modal once; every in-flight request awaits the same
 * gate and retries after a successful submit, so callers never handle 401.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const TOKEN_KEY = "wisp_token";

/**
 * What to show when a write fails. The daemon names its own refusals (an
 * archive's 409 is the whole decision), so its sentence wins; anything without
 * one never reached the daemon at all.
 */
export function failureReason(e: unknown): string {
  return e instanceof ApiError ? e.message : "Could not reach the daemon";
}

/** Common display policy for task-action failures. */
export function failureDisplay(e: unknown): { tone: "muted" | "error"; text: string } {
  return {
    tone: e instanceof ApiError && e.status === 409 ? "muted" : "error",
    text: failureReason(e),
  };
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

/* ---------------- auth gate (drives AuthDialog) ---------------- */

export interface AuthState {
  open: boolean;
}

let authState: AuthState = { open: false };
const authListeners = new Set<() => void>();
let gate: Promise<void> | null = null;
let resolveGate: (() => void) | null = null;

function setAuthState(next: Partial<AuthState>): void {
  authState = { ...authState, ...next };
  for (const fn of authListeners) fn();
}

export const authStore = {
  subscribe(fn: () => void): () => void {
    authListeners.add(fn);
    return () => {
      authListeners.delete(fn);
    };
  },
  snapshot(): AuthState {
    return authState;
  },
};

/** 401 path: show the token modal once; every queued request resumes after a successful submit. */
export function requireAuth(): Promise<void> {
  if (!gate) gate = new Promise((resolve) => (resolveGate = resolve));
  if (!authState.open) setAuthState({ open: true });
  return gate;
}

/**
 * POST /api/session — trade a token for the HttpOnly cookie. Throws an
 * ApiError whose MESSAGE is the sentence a person should read; status 0 means
 * the daemon never answered at all. Busy and error state belong to whoever
 * called this (useMintSession), not to the store: `ensureSession` below calls
 * it too, from outside React, and there is no dialog to put them in.
 */
export async function mintSession(token: string): Promise<void> {
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => null);
  if (!res) throw new ApiError("daemon unreachable — is wisp serve running?", 0);
  if (!res.ok) {
    throw new ApiError(
      res.status === 401 ? "unauthorized — check `wisp token` on the daemon host" : `session error: ${res.status}`,
      res.status,
    );
  }
}

/** A minted session: remember the token, close the modal, release every parked request. */
export function completeAuth(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  setAuthState({ open: false });
  const done = resolveGate;
  gate = null;
  resolveGate = null;
  done?.();
}

/**
 * Thin client of the HTTP API. On 401: mint the cookie via the modal, then
 * retry — the loop is the classic UI's, transplanted.
 */
export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  for (;;) {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`; // fallback; the wisp_token cookie is primary
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, { method: opts.method ?? "GET", headers, body });
    if (res.status === 401) {
      await requireAuth();
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new ApiError(typeof data.error === "string" ? data.error : `${res.status} ${res.statusText}`, res.status);
    }
    return data as T;
  }
}

/**
 * Ensure EventSource-grade authentication (it can't send the bearer header):
 * mint/refresh the wisp_token cookie, awaiting the token modal if needed.
 * Resolves once a cookie-bearing request would authenticate.
 */
export async function ensureSession(): Promise<void> {
  const token = getToken();
  if (token) {
    try {
      await mintSession(token);
      return;
    } catch (e) {
      // the stored token is stale — drop it before the modal asks again
      if (e instanceof ApiError && e.status === 401) localStorage.removeItem(TOKEN_KEY);
    }
  } else {
    // the wisp_token cookie outlives localStorage: probe an authed endpoint
    // headerless — a 200 means the cookie alone authenticates, nothing to mint
    const probe = await fetch("/api/outbox").catch(() => null);
    if (probe?.ok) return;
  }
  await requireAuth();
}
