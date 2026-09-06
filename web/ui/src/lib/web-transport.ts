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

/** POST /api/session — trade a token for the HttpOnly same-origin cookie. */
export async function mintSession(token: string): Promise<void> {
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
    const headers: Record<string, string> = {}
    const token = getToken()
    if (token) headers.authorization = `Bearer ${token}`

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
      await mintSession(token)
      return
    } catch (error) {
      // the stored token is stale — drop it before the modal asks again
      if (error instanceof ApiError && error.status === 401)
        localStorage.removeItem(TOKEN_KEY)
    }
  } else {
    // the HttpOnly cookie can outlive localStorage: a successful headerless
    // request proves EventSource and media requests are already authenticated
    const probe = await fetch("/api/outbox").catch(() => null)
    if (probe?.ok) return
  }
  await requireAuth()
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
  openEventStream: (path: string) => new EventSource(path),
  openWebSocket: (path: string) => new WebSocket(webSocketUrl(path)),
  assetUrl: (path: string) => path,
  ensureReady,
})
