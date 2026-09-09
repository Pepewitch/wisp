import { openFetchEventStream } from "./fetch-event-source"
import {
  ApiError,
  LOCAL_CONNECTION_ID,
  type DaemonRequestOptions,
  type DaemonTransport,
} from "./transport"

export { ApiError } from "./transport"

/**
 * Same-origin authentication used only by the daemon-served browser runtime.
 * Desktop transports keep credentials in native code and do not use this key.
 *
 * This token is the browser's ONLY credential now. The daemon used to also
 * mint an HttpOnly `wisp_token` cookie, because `EventSource`, `WebSocket`,
 * and `<img>` cannot send headers — but a cookie is scoped to host and path,
 * never to port (RFC 6265 §8.5), so any other HTTP service on 127.0.0.1
 * received the daemon's full-control token in its Cookie header (SEC-01).
 * Every one of those three channels is now explicit instead: `fetch`
 * streaming for SSE, an in-band first frame for the terminal socket, and an
 * authenticated fetch to a blob URL for media.
 */
const TOKEN_KEY = "wisp_token"

/**
 * What to show when a write fails. The daemon names its own refusals (an
 * archive's 409 is the whole decision), so its sentence wins; anything without
 * one never reached the daemon at all.
 */
export function failureReason(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "Could not reach the daemon"
}

/** Common display policy for task-action failures. */
export function failureDisplay(error: unknown): {
  tone: "muted" | "error"
  text: string
} {
  return {
    tone: error instanceof ApiError && error.status === 409 ? "muted" : "error",
    text: failureReason(error),
  }
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ""
}

/** The bearer header, or nothing when this browser has no token yet. */
function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}

/* ---------------- auth gate (drives AuthDialog) ---------------- */

export interface AuthState {
  open: boolean
}

let authState: AuthState = { open: false }
const authListeners = new Set<() => void>()
let gate: Promise<void> | null = null
let resolveGate: (() => void) | null = null

function setAuthState(next: Partial<AuthState>): void {
  authState = { ...authState, ...next }
  for (const fn of authListeners) fn()
}

export const authStore = {
  subscribe(fn: () => void): () => void {
    authListeners.add(fn)
    return () => {
      authListeners.delete(fn)
    }
  },
  snapshot(): AuthState {
    return authState
  },
}

/** 401 path: show the token modal once; every queued request resumes after a successful submit. */
export function requireAuth(): Promise<void> {
  if (!gate) gate = new Promise((resolve) => (resolveGate = resolve))
  if (!authState.open) setAuthState({ open: true })
  return gate
}

/**
 * POST /api/session — ask the daemon whether this token is the right one.
 *
 * It mints nothing. The dialog calls it so a wrong token is refused before it
 * is stored, and an upgraded daemon answers it by expiring the pre-0.4
 * root-token cookie a browser may still be holding.
 */
export async function verifyToken(token: string): Promise<void> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => null)
  if (!response)
    throw new ApiError("daemon unreachable — is wisp serve running?", 0)
  if (!response.ok) {
    throw new ApiError(
      response.status === 401
        ? "unauthorized — check `wisp token` on the daemon host"
        : `session error: ${response.status}`,
      response.status
    )
  }
}

/** A minted session: remember the token, close the modal, and release parked requests. */
export function completeAuth(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
  setAuthState({ open: false })
  const done = resolveGate
  gate = null
  resolveGate = null
  done?.()
}

async function request<T>(
  path: string,
  options: DaemonRequestOptions = {}
): Promise<T> {
  for (;;) {
    const headers: Record<string, string> = { ...authHeaders() }

    let body: string | undefined
    if (options.body !== undefined) {
      headers["content-type"] = "application/json"
      body = JSON.stringify(options.body)
    }

    const response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body,
      signal: options.signal,
    })
    if (response.status === 401) {
      await requireAuth()
      continue
    }

    const data = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >
    if (!response.ok) {
      throw new ApiError(
        typeof data.error === "string"
          ? data.error
          : `${response.status} ${response.statusText}`,
        response.status
      )
    }
    return data as T
  }
}

async function ensureReady(): Promise<void> {
  const token = getToken()
  if (token) {
    try {
      await verifyToken(token)
      return
    } catch (error) {
      // the stored token is stale — drop it before the modal asks again
      if (error instanceof ApiError && error.status === 401)
        localStorage.removeItem(TOKEN_KEY)
    }
  }
  await requireAuth()
}

/**
 * Fetch a protected asset for display. There is no ambient credential a
 * `<img src>` could inherit, so media is fetched with the bearer header and
 * shown from a blob URL (`useAssetSrc` owns the caching and revocation).
 */
async function fetchAsset(path: string): Promise<Blob> {
  const response = await fetch(path, {
    headers: authHeaders(),
    cache: "no-store",
    // Explicit about both, the way the desktop transport already is: nothing
    // ambient may travel with this request, and a redirect must not carry the
    // Authorization header somewhere we did not choose (a review's note).
    credentials: "omit",
    redirect: "error",
  }).catch(() => null)
  if (!response) throw new ApiError("Could not reach the daemon", 0)
  if (!response.ok) {
    if (response.status === 401) void requireAuth()
    throw new ApiError(`asset error: ${response.status}`, response.status)
  }
  return await response.blob()
}

function webSocketUrl(path: string): string {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.href
}

/** Frozen single-daemon transport used by the existing daemon-served web UI. */
export const sameOriginWebTransport: Readonly<DaemonTransport> = Object.freeze({
  connectionId: LOCAL_CONNECTION_ID,
  request,
  openEventStream: (path: string) =>
    openFetchEventStream(path, { headers: authHeaders }),
  openWebSocket: (path: string) => new WebSocket(webSocketUrl(path)),
  // Same-origin path, kept for a caller that only needs to name the asset;
  // fetchAsset is what actually loads one, because this URL carries no
  // credential.
  assetUrl: (path: string) => path,
  fetchAsset,
  socketToken: () => getToken() || null,
  ensureReady,
})
