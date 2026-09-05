import {
  ApiError,
  type DaemonRequestOptions,
  type DaemonTransport,
} from "./transport"

const CONNECTION_ID = /^[A-Za-z0-9_-]+$/

function daemonPath(path: string): void {
  if (
    !path.startsWith("/api") ||
    (path.length > 4 && path[4] !== "/" && path[4] !== "?")
  ) {
    throw new Error(`Desktop daemon paths must begin with /api: ${path}`)
  }
}

function socketUrl(url: string): string {
  const parsed = new URL(url)
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:"
  return parsed.href
}

/**
 * A frozen connection route through the per-launch native proxy.
 *
 * The daemon URL and token are deliberately absent: native code resolves both
 * from connectionId and injects credentials on every HTTP/SSE/WS/media hop.
 */
export function createDesktopTransport(
  proxyBaseUrl: string,
  connectionId: string
): Readonly<DaemonTransport> {
  if (!CONNECTION_ID.test(connectionId))
    throw new Error(`Invalid desktop connection id: ${connectionId}`)
  const base = proxyBaseUrl.replace(/\/+$/, "")
  const qualify = (path: string): string => {
    daemonPath(path)
    return `${base}/${connectionId}${path}`
  }

  const request = async <T>(
    path: string,
    options: DaemonRequestOptions = {}
  ): Promise<T> => {
    const headers: Record<string, string> = {}
    let body: string | undefined
    if (options.body !== undefined) {
      headers["content-type"] = "application/json"
      body = JSON.stringify(options.body)
    }
    const response = await fetch(qualify(path), {
      method: options.method ?? "GET",
      headers,
      body,
      signal: options.signal,
      credentials: "omit",
      redirect: "error",
    })
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

  const transport: DaemonTransport = {
    connectionId,
    request,
    openEventStream: (path) => new EventSource(qualify(path)),
    openWebSocket: (path) => new WebSocket(socketUrl(qualify(path))),
    assetUrl: qualify,
    ensureReady: () => request("/api/health"),
  }
  return Object.freeze(transport)
}
