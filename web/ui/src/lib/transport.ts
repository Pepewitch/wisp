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

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
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
  openEventStream(path: string): EventSource
  openWebSocket(path: string): WebSocket
  assetUrl(path: string): string
  ensureReady(): Promise<void>
}
