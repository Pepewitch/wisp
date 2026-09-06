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
  readonly instanceId: string
  readonly ready: boolean
}

export interface LocalStatus {
  readonly available: boolean
  readonly configPath: string
  readonly baseUrl: string | null
  readonly instanceId: string | null
  readonly hasToken: boolean
  readonly reason: string | null
}

export type LocalSetupStep =
  "ready" | "install-cli" | "run-init" | "start-daemon"

export interface LocalSetupReport {
  readonly status: LocalStatus
  readonly cliPath: string | null
  readonly daemonReachable: boolean
  readonly nextStep: LocalSetupStep
  readonly message: string
}

export interface DesktopBootstrap {
  readonly connections: readonly DesktopConnectionMetadata[]
  readonly activeConnectionId: string
  /** Per-launch native proxy root. The transport appends /connections/:id/api/… */
  readonly proxyBaseUrl: string
  readonly local: LocalStatus
}

export interface AddRemoteConnectionInput {
  name: string
  url: string
  token: string
  expectedInstanceId: string
}

export interface RemoteConnectionProbeInput {
  url: string
  token: string
}

export interface RemoteDaemonPreview {
  readonly instanceId: string
  readonly apiProtocolVersion: number
  readonly version: string
}

export interface ReconnectConnectionInput {
  connectionId: string
  /** Omitted to keep the saved URL. */
  url?: string
  /** Omitted to keep the credential already held by native code. */
  token?: string
  /** The daemon identity the person explicitly reviewed before reconnecting. */
  expectedInstanceId?: string
}

export type NativeInvoke = <T>(
  command: string,
  args?: Record<string, unknown>
) => Promise<T>

/** The complete TypeScript/native boundary. No React component calls invoke. */
export interface DesktopBridge {
  bootstrap(): Promise<DesktopBootstrap>
  probeRemoteConnection(
    input: RemoteConnectionProbeInput
  ): Promise<RemoteDaemonPreview>
  addRemoteConnection(
    input: AddRemoteConnectionInput
  ): Promise<DesktopConnectionMetadata>
  renameConnection(
    connectionId: string,
    name: string
  ): Promise<DesktopConnectionMetadata>
  reconnectConnection(
    input: ReconnectConnectionInput
  ): Promise<DesktopConnectionMetadata>
  probeSavedConnection(
    input: ReconnectConnectionInput
  ): Promise<RemoteDaemonPreview>
  removeConnection(connectionId: string): Promise<void>
  resetDesktopData(): Promise<void>
  pickLocalProject(): Promise<string | null>
  setupLocalWisp(): Promise<LocalSetupReport>
  applyLocalWispSetup(expectedStep: LocalSetupStep): Promise<LocalSetupReport>
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
    if (typeof value.ready !== "boolean")
      throw new Error(
        "The local desktop connection has invalid readiness metadata"
      )
    return Object.freeze({
      id: value.id,
      kind: value.kind,
      name,
      url: null,
      instanceId: typeof value.instanceId === "string" ? value.instanceId : "",
      ready: value.ready,
    })
  }
  if (value.id === LOCAL_CONNECTION_ID)
    throw new Error("A remote connection cannot use the reserved id local")
  if (
    value.kind !== "remote" ||
    typeof value.url !== "string" ||
    typeof value.instanceId !== "string" ||
    !value.instanceId ||
    typeof value.ready !== "boolean"
  ) {
    throw new Error(`Desktop connection ${value.id} has invalid metadata`)
  }
  return Object.freeze({
    id: value.id,
    kind: value.kind,
    name,
    url: normalizeRemoteUrl(value.url),
    instanceId: value.instanceId,
    ready: value.ready,
  })
}

function normalizeLocalStatus(value: LocalStatus): Readonly<LocalStatus> {
  if (
    typeof value.available !== "boolean" ||
    typeof value.configPath !== "string" ||
    !value.configPath ||
    (value.baseUrl !== null && typeof value.baseUrl !== "string") ||
    (value.instanceId !== null && typeof value.instanceId !== "string") ||
    typeof value.hasToken !== "boolean" ||
    (value.reason !== null && typeof value.reason !== "string")
  ) {
    throw new Error("Desktop returned invalid local Wisp status")
  }
  const baseUrl =
    value.baseUrl === null ? null : normalizeRemoteUrl(value.baseUrl)
  if (
    value.available !==
    (baseUrl !== null && value.instanceId !== null && value.hasToken)
  ) {
    throw new Error("Desktop returned inconsistent local Wisp status")
  }
  return Object.freeze({
    available: value.available,
    configPath: value.configPath,
    baseUrl,
    instanceId: value.instanceId,
    hasToken: value.hasToken,
    reason: value.reason,
  })
}

function normalizeLocalSetupReport(
  value: LocalSetupReport
): Readonly<LocalSetupReport> {
  const steps: readonly LocalSetupStep[] = [
    "ready",
    "install-cli",
    "run-init",
    "start-daemon",
  ]
  if (
    (value.cliPath !== null && typeof value.cliPath !== "string") ||
    typeof value.daemonReachable !== "boolean" ||
    !steps.includes(value.nextStep) ||
    typeof value.message !== "string" ||
    !value.message
  ) {
    throw new Error("Desktop returned an invalid local setup report")
  }
  return Object.freeze({
    status: normalizeLocalStatus(value.status),
    cliPath: value.cliPath,
    daemonReachable: value.daemonReachable,
    nextStep: value.nextStep,
    message: value.message,
  })
}

function normalizeRemotePreview(
  value: RemoteDaemonPreview
): Readonly<RemoteDaemonPreview> {
  if (
    typeof value.instanceId !== "string" ||
    !value.instanceId ||
    !Number.isSafeInteger(value.apiProtocolVersion) ||
    value.apiProtocolVersion < 1 ||
    typeof value.version !== "string" ||
    !value.version
  ) {
    throw new Error("Desktop returned an invalid daemon identity")
  }
  return Object.freeze({
    instanceId: value.instanceId,
    apiProtocolVersion: value.apiProtocolVersion,
    version: value.version,
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
  const ordered = [...connections].sort((a, b) => {
    if (a.kind === "local") return -1
    if (b.kind === "local") return 1
    return 0
  })
  return Object.freeze({
    connections: Object.freeze(ordered),
    activeConnectionId: value.activeConnectionId,
    proxyBaseUrl,
    local: normalizeLocalStatus(value.local),
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
    probeRemoteConnection: async (input) =>
      normalizeRemotePreview(
        await nativeInvoke<RemoteDaemonPreview>("probe_remote_connection", {
          url: input.url,
          token: input.token,
        })
      ),
    addRemoteConnection: async (input) =>
      normalizeConnection(
        await nativeInvoke<DesktopConnectionMetadata>("add_remote_connection", {
          name: input.name,
          url: input.url,
          token: input.token,
          expectedInstanceId: input.expectedInstanceId,
        })
      ),
    renameConnection: async (connectionId, name) =>
      normalizeConnection(
        await nativeInvoke<DesktopConnectionMetadata>("rename_connection", {
          connectionId,
          name,
        })
      ),
    reconnectConnection: async (input) =>
      normalizeConnection(
        await nativeInvoke<DesktopConnectionMetadata>("reconnect_connection", {
          connectionId: input.connectionId,
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.token === undefined ? {} : { token: input.token }),
          ...(input.expectedInstanceId === undefined
            ? {}
            : { expectedInstanceId: input.expectedInstanceId }),
        })
      ),
    probeSavedConnection: async (input) =>
      normalizeRemotePreview(
        await nativeInvoke<RemoteDaemonPreview>("probe_saved_connection", {
          connectionId: input.connectionId,
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.token === undefined ? {} : { token: input.token }),
        })
      ),
    removeConnection: (connectionId) =>
      nativeInvoke<void>("remove_connection", { connectionId }),
    resetDesktopData: () => nativeInvoke<void>("reset_desktop_data"),
    pickLocalProject: () =>
      nativeInvoke<string | null>("pick_local_project", {
        connectionId: LOCAL_CONNECTION_ID,
      }),
    setupLocalWisp: async () =>
      normalizeLocalSetupReport(
        await nativeInvoke<LocalSetupReport>("setup_local_wisp")
      ),
    applyLocalWispSetup: async (expectedStep) =>
      normalizeLocalSetupReport(
        await nativeInvoke<LocalSetupReport>("apply_local_wisp_setup", {
          expectedStep,
        })
      ),
  }
  return Object.freeze(bridge)
}

export const desktopBridge = createDesktopBridge()
