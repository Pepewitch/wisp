/** Reserved identity of the daemon that serves the ordinary browser UI. */
export const LOCAL_CONNECTION_ID = "local"

/** JSON request options shared by browser and desktop transports. */
export interface DaemonRequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

/** An upstream daemon response that reached the transport but was not successful. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

/**
 * A server-sent event stream, as much of `EventSource` as the app uses.
 *
 * Named as an interface rather than typed as `EventSource` because the browser
 * runtime cannot use `EventSource` any more: it cannot set an Authorization
 * header, which is exactly why the daemon used to hand out an ambient
 * root-token cookie (SEC-01). The web transport now streams over `fetch` and
 * satisfies this shape; the desktop transport still returns a real
 * `EventSource`, since its native proxy injects the credential.
 */
export interface DaemonEventStream {
  onmessage: ((event: { data: string }) => void) | null
  onopen: (() => void) | null
  onerror: (() => void) | null
  readonly readyState: number
  /** named-frame subscription (the log stream's backlog/append/turn-end) */
  addEventListener(type: string, listener: (event: { data: string }) => void): void
  close(): void
}

/**
 * One immutable route to one Wisp daemon.
 *
 * The shared UI depends only on this browser-native surface. The web runtime
 * implements it with same-origin APIs; the desktop runtime can implement it
 * with connection-qualified native proxy URLs without teaching components
 * about daemon addresses or credentials.
 */
export interface DaemonTransport {
  readonly connectionId: string
  request<T>(path: string, options?: DaemonRequestOptions): Promise<T>
  openEventStream(path: string): DaemonEventStream
  openWebSocket(path: string): WebSocket
  /**
   * A URL usable directly in `<img src>`. Only meaningful for a transport
   * whose hop carries its own credential — the desktop proxy. When
   * `fetchAsset` is present it is used instead, and this is not consulted.
   */
  assetUrl(path: string): string
  /**
   * Fetch a protected asset with a credential, for a transport that has no
   * ambient authority in the browser. Present on the web transport only; see
   * `useAssetSrc`.
   */
  fetchAsset?(path: string): Promise<Blob>
  /**
   * The credential to send in a terminal socket's first frame, when this
   * transport authenticates in-band. A WebSocket handshake cannot carry a
   * header; the daemon therefore refuses to attach a browser socket until it
   * proves itself. Absent on the desktop transport, whose native proxy has
   * already authenticated the upstream handshake.
   */
  socketToken?(): string | null
  ensureReady(): Promise<void>
}
