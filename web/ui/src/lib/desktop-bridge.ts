import { invoke } from "@tauri-apps/api/core"

import { LOCAL_CONNECTION_ID } from "./transport"

export const MAX_DESKTOP_CONNECTIONS = 8

export type DesktopConnectionKind = "local" | "remote"

/** Secret-free connection data returned by the native desktop process. */
export interface DesktopConnectionMetadata {
  readonly id: string
  readonly kind: DesktopConnectionKind
  readonly name: string
  /** The daemon base URL is editable metadata; credentials never cross bootstrap. */
  readonly url: string | null
}

export interface DesktopBootstrap {
  readonly connections: readonly DesktopConnectionMetadata[]
  readonly activeConnectionId: string
  /** Per-launch native proxy root. The transport appends /:connectionId/api/… */
  readonly proxyBaseUrl: string
}

export interface AddRemoteConnectionInput {
  name: string
  url: string
  token: string
}

export interface ReconnectConnectionInput {
  connectionId: string
  /** Omitted to keep the saved URL. */
  url?: string
  /** Omitted to keep the credential already held by native code. */
  token?: string
}

export type NativeInvoke = <T>(
  command: string,
  args?: Record<string, unknown>
) => Promise<T>

/** The complete TypeScript/native boundary. No React component calls invoke. */
export interface DesktopBridge {
  bootstrap(): Promise<DesktopBootstrap>
  addRemoteConnection(input: AddRemoteConnectionInput): Promise<void>
  renameConnection(connectionId: string, name: string): Promise<void>
  reconnectConnection(input: ReconnectConnectionInput): Promise<void>
  removeConnection(connectionId: string): Promise<void>
  pickLocalProject(): Promise<string | null>
  setupLocalWisp(): Promise<void>
}

const CONNECTION_ID = /^[A-Za-z0-9_-]+$/

function loopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
}

function parseUrl(value: string, label: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid URL`)
  }
  if (parsed.username || parsed.password)
    throw new Error(`${label} cannot include a username or password`)
  if (parsed.search || parsed.hash)
    throw new Error(`${label} cannot include a query or fragment`)
  return parsed
}

/** HTTPS everywhere, with literal IP loopback HTTP only for an explicit tunnel. */
export function normalizeRemoteUrl(value: string): string {
  const parsed = parseUrl(value.trim(), "Daemon URL")
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && loopbackHostname(parsed.hostname))
  ) {
    throw new Error(
      "Use HTTPS, or HTTP with the exact loopback address 127.0.0.1 or ::1"
    )
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/"
  return parsed.href.replace(/\/$/, "")
}

/** The per-launch proxy is native-owned and must remain on a literal loopback IP. */
export function normalizeProxyBaseUrl(value: string): string {
  const parsed = parseUrl(value.trim(), "Desktop proxy URL")
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !loopbackHostname(parsed.hostname)
  ) {
    throw new Error("Desktop proxy URL must use a literal loopback address")
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "")
  return parsed.href.replace(/\/$/, "")
}

function normalizeConnection(
  value: DesktopConnectionMetadata
): Readonly<DesktopConnectionMetadata> {
  if (!CONNECTION_ID.test(value.id))
    throw new Error(`Invalid desktop connection id: ${value.id}`)
  const name = value.name.trim()
  if (!name) throw new Error(`Desktop connection ${value.id} has no name`)
  if (value.kind === "local") {
    if (value.id !== LOCAL_CONNECTION_ID)
      throw new Error(
        "The local desktop connection must use the reserved id local"
      )
    return Object.freeze({ id: value.id, kind: value.kind, name, url: null })
  }
  if (value.id === LOCAL_CONNECTION_ID)
    throw new Error("A remote connection cannot use the reserved id local")
  if (value.kind !== "remote" || typeof value.url !== "string") {
    throw new Error(`Desktop connection ${value.id} has invalid metadata`)
  }
  return Object.freeze({
    id: value.id,
    kind: value.kind,
    name,
    url: normalizeRemoteUrl(value.url),
  })
}

/** Validate native data once, before it becomes routing or cache identity. */
export function normalizeDesktopBootstrap(
  value: DesktopBootstrap
): Readonly<DesktopBootstrap> {
  const proxyBaseUrl = normalizeProxyBaseUrl(value.proxyBaseUrl)
  const connections = value.connections.map(normalizeConnection)
  if (connections.length > MAX_DESKTOP_CONNECTIONS) {
    throw new Error(
      `Desktop supports at most ${MAX_DESKTOP_CONNECTIONS} connections`
    )
  }
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const connection of connections) {
    if (ids.has(connection.id))
      throw new Error(`Duplicate desktop connection id: ${connection.id}`)
    const nameKey = connection.name.toLowerCase()
    if (names.has(nameKey))
      throw new Error(`Duplicate desktop connection name: ${connection.name}`)
    ids.add(connection.id)
    names.add(nameKey)
  }
  if (!ids.has(LOCAL_CONNECTION_ID))
    throw new Error("Desktop bootstrap did not include the local connection")
  if (!ids.has(value.activeConnectionId))
    throw new Error("Desktop bootstrap selected an unknown connection")
  const ordered = connections.toSorted((a, b) => {
    if (a.kind === "local") return -1
    if (b.kind === "local") return 1
    return 0
  })
  return Object.freeze({
    connections: Object.freeze(ordered),
    activeConnectionId: value.activeConnectionId,
    proxyBaseUrl,
  })
}

export function createDesktopBridge(
  nativeInvoke: NativeInvoke = invoke
): Readonly<DesktopBridge> {
  const bridge: DesktopBridge = {
    bootstrap: async () =>
      normalizeDesktopBootstrap(
        await nativeInvoke<DesktopBootstrap>("desktop_bootstrap")
      ),
    addRemoteConnection: (input) =>
      nativeInvoke<void>("add_remote_connection", {
        name: input.name,
        url: input.url,
        token: input.token,
      }),
    renameConnection: (connectionId, name) =>
      nativeInvoke<void>("rename_connection", { connectionId, name }),
    reconnectConnection: (input) =>
      nativeInvoke<void>("reconnect_connection", {
        connectionId: input.connectionId,
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.token === undefined ? {} : { token: input.token }),
      }),
    removeConnection: (connectionId) =>
      nativeInvoke<void>("remove_connection", { connectionId }),
    pickLocalProject: () => nativeInvoke<string | null>("pick_local_project"),
    setupLocalWisp: () => nativeInvoke<void>("setup_local_wisp"),
  }
  return Object.freeze(bridge)
}

export const desktopBridge = createDesktopBridge()
