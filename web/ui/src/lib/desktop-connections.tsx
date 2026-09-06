/* eslint-disable react-refresh/only-export-components -- context and its desktop root form one boundary */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"

import {
  connectionAttention,
  type ConnectionAttention,
} from "@/lib/connection-attention"
import {
  classifyConnectionError,
  type ConnectionReachability,
} from "@/lib/connection-reachability"
import {
  MAX_DESKTOP_CONNECTIONS,
  desktopBridge,
  type AddRemoteConnectionInput,
  type DesktopBootstrap,
  type DesktopBridge,
  type DesktopConnectionMetadata,
  type LocalSetupReport,
  type LocalSetupStep,
  type RemoteConnectionProbeInput,
  type RemoteDaemonPreview,
  type ReconnectConnectionInput,
} from "@/lib/desktop-bridge"
import { createDesktopTransport } from "@/lib/desktop-transport"
import { useLocalConnectionActions } from "@/lib/desktop-local-actions"
import { removeDesktopConnection } from "@/lib/desktop-remove"
import {
  clearForgottenConnection,
  resetDesktopApplication,
} from "@/lib/desktop-reset"
import { queryClient } from "@/lib/query"
import { DaemonRuntimeProvider } from "@/lib/runtime"
import type { DaemonTransport } from "@/lib/transport"
import type { ApiTask } from "@/lib/types"

export interface DesktopConnectionEntry {
  readonly metadata: DesktopConnectionMetadata
  readonly transport: Readonly<DaemonTransport>
}

export interface DesktopConnectionContextValue {
  readonly connections: readonly DesktopConnectionEntry[]
  readonly active: DesktopConnectionEntry
  readonly attention: ReadonlyMap<string, ConnectionAttention>
  readonly reachability: ReadonlyMap<string, ConnectionReachability>
  readonly pendingAction: string | null
  readonly actionError: string | null
  select(connectionId: string): Promise<void>
  probeRemote(input: RemoteConnectionProbeInput): Promise<RemoteDaemonPreview>
  probeReconnect(input: ReconnectConnectionInput): Promise<RemoteDaemonPreview>
  addRemote(input: AddRemoteConnectionInput): Promise<void>
  rename(connectionId: string, name: string): Promise<void>
  reconnect(input: ReconnectConnectionInput): Promise<void>
  remove(connectionId: string): Promise<void>
  resetDesktopData(): Promise<void>
  pickLocalProject(): Promise<string | null>
  setupLocalWisp(): Promise<LocalSetupReport>
  applyLocalWispSetup(expectedStep: LocalSetupStep): Promise<LocalSetupReport>
  reportAttention(connectionId: string, attention: ConnectionAttention): void
  reportReachability(connectionId: string, value: ConnectionReachability): void
  clearActionError(): void
}

const DesktopConnectionContext =
  createContext<DesktopConnectionContextValue | null>(null)

export interface ConnectionState {
  readonly proxyBaseUrl: string
  readonly connections: readonly DesktopConnectionEntry[]
  readonly activeId: string
}

function reconcileConnections(
  previous: ConnectionState | null,
  bootstrap: DesktopBootstrap,
  preferredActiveId?: string
): ConnectionState {
  const prior = new Map(
    previous?.connections.map((entry) => [entry.metadata.id, entry.transport])
  )
  const connections = bootstrap.connections.map((metadata) => ({
    metadata,
    transport:
      previous?.proxyBaseUrl === bootstrap.proxyBaseUrl
        ? (prior.get(metadata.id) ??
          createDesktopTransport(bootstrap.proxyBaseUrl, metadata.id))
        : createDesktopTransport(bootstrap.proxyBaseUrl, metadata.id),
  }))
  const candidate = preferredActiveId ?? bootstrap.activeConnectionId
  const activeId = connections.some((entry) => entry.metadata.id === candidate)
    ? candidate
    : bootstrap.activeConnectionId
  return Object.freeze({
    proxyBaseUrl: bootstrap.proxyBaseUrl,
    connections: Object.freeze(connections),
    activeId,
  })
}

export function useDesktopConnections(): DesktopConnectionContextValue | null {
  return useContext(DesktopConnectionContext)
}

export type ApplyBootstrap = (
  bootstrap: DesktopBootstrap,
  preferredActiveId?: string
) => void

function useConnectionActions({
  bridge,
  stateRef,
  setState,
  apply,
  forgetAttention,
  onBackgroundError,
}: {
  bridge: DesktopBridge
  stateRef: React.RefObject<ConnectionState>
  setState: Dispatch<SetStateAction<ConnectionState>>
  apply: ApplyBootstrap
  forgetAttention: (connectionId: string) => void
  onBackgroundError: (message: string) => void
}) {
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const pendingActionRef = useRef<string | null>(null)
  const transact = useCallback(
    async <T,>(label: string, action: () => Promise<T>): Promise<T> => {
      if (pendingActionRef.current !== null)
        throw new Error("Another connection action is still running")
      pendingActionRef.current = label
      setPendingAction(label)
      try {
        return await action()
      } finally {
        pendingActionRef.current = null
        setPendingAction(null)
      }
    },
    []
  )
  const addRemote = useCallback(
    (input: AddRemoteConnectionInput) =>
      transact("add", async () => {
        if (stateRef.current.connections.length >= MAX_DESKTOP_CONNECTIONS) {
          throw new Error(
            `Desktop supports at most ${MAX_DESKTOP_CONNECTIONS} connections`
          )
        }
        const added = await bridge.addRemoteConnection(input)
        await bridge.selectConnection(added.id)
        apply(await bridge.bootstrap(), added.id)
      }),
    [apply, bridge, stateRef, transact]
  )
  const probeRemote = useCallback(
    (input: RemoteConnectionProbeInput) =>
      transact("probe", () => bridge.probeRemoteConnection(input)),
    [bridge, transact]
  )
  const rename = useCallback(
    (connectionId: string, name: string) =>
      transact(`rename:${connectionId}`, async () => {
        await bridge.renameConnection(connectionId, name)
        apply(await bridge.bootstrap(), stateRef.current.activeId)
      }),
    [apply, bridge, stateRef, transact]
  )
  const probeReconnect = useCallback(
    (input: ReconnectConnectionInput) =>
      transact(`probe-reconnect:${input.connectionId}`, () =>
        bridge.probeSavedConnection(input)
      ),
    [bridge, transact]
  )
  const reconnect = useCallback(
    (input: ReconnectConnectionInput) =>
      transact(`reconnect:${input.connectionId}`, async () => {
        const before = stateRef.current
        const activeBefore = before.activeId
        const targetName = before.connections.find(
          (entry) => entry.metadata.id === input.connectionId
        )?.metadata.name
        try {
          const reconnected = await bridge.reconnectConnection(input)
          apply(
            await bridge.bootstrap(),
            activeBefore === input.connectionId ? reconnected.id : activeBefore
          )
          if (reconnected.id !== input.connectionId) {
            await clearForgottenConnection(input.connectionId, forgetAttention)
          }
          void queryClient.invalidateQueries({ queryKey: [reconnected.id] })
        } catch (error) {
          // Native replacement can commit before a deferred Keychain cleanup
          // reports failure. Reconcile the authoritative registry on every
          // refusal so the UI never keeps routing a revoked ID.
          const bootstrap = await bridge.bootstrap()
          const oldStillExists = bootstrap.connections.some(
            (connection) => connection.id === input.connectionId
          )
          const replacement = bootstrap.connections.find(
            (connection) =>
              connection.id !== input.connectionId &&
              connection.name === targetName
          )
          if (
            activeBefore === input.connectionId &&
            !oldStillExists &&
            replacement
          ) {
            await bridge.selectConnection(replacement.id)
          }
          apply(
            bootstrap,
            activeBefore === input.connectionId && !oldStillExists
              ? replacement?.id
              : activeBefore
          )
          if (!oldStillExists) {
            await clearForgottenConnection(input.connectionId, forgetAttention)
          }
          onBackgroundError(
            error instanceof Error ? error.message : String(error)
          )
          throw error
        }
      }),
    [
      apply,
      bridge,
      forgetAttention,
      onBackgroundError,
      stateRef,
      transact,
    ]
  )
  const remove = useCallback(
    (connectionId: string) =>
      transact(`remove:${connectionId}`, () =>
        removeDesktopConnection({
          connectionId,
          bridge,
          stateRef,
          setState,
          apply,
          forgetAttention,
          onBackgroundError,
        })
      ),
    [
      apply,
      bridge,
      forgetAttention,
      onBackgroundError,
      setState,
      stateRef,
      transact,
    ]
  )
  const resetDesktopData = useCallback(
    () =>
      transact("reset-desktop-data", async () => {
        try {
          await resetDesktopApplication({
            bridge,
            connections: stateRef.current.connections,
            apply,
            forgetAttention,
          })
        } catch (error) {
          onBackgroundError(
            error instanceof Error ? error.message : String(error)
          )
          throw error
        }
      }),
    [
      apply,
      bridge,
      forgetAttention,
      onBackgroundError,
      stateRef,
      transact,
    ]
  )
  const { pickLocalProject, setupLocalWisp, applyLocalWispSetup } =
    useLocalConnectionActions({ bridge, stateRef, apply, transact })
  return {
    pendingAction,
    probeRemote,
    probeReconnect,
    addRemote,
    rename,
    reconnect,
    remove,
    resetDesktopData,
    pickLocalProject,
    setupLocalWisp,
    applyLocalWispSetup,
  }
}

export function DesktopApplicationProvider({
  initial,
  bridge = desktopBridge,
  children,
}: {
  initial: DesktopBootstrap
  bridge?: DesktopBridge
  children: ReactNode
}) {
  const [state, setState] = useState<ConnectionState>(() =>
    reconcileConnections(null, initial)
  )
  const stateRef = useRef(state)
  const [attention, setAttention] = useState<
    ReadonlyMap<string, ConnectionAttention>
  >(() => new Map())
  const [reachability, setReachability] = useState<
    ReadonlyMap<string, ConnectionReachability>
  >(
    () =>
      new Map(
        initial.connections.map((connection) => [
          connection.id,
          connection.ready ? "unknown" : "offline",
        ])
      )
  )
  const [actionError, setActionError] = useState<string | null>(
    initial.cleanupIssues?.[0]?.message ?? null
  )
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const apply = useCallback(
    (bootstrap: DesktopBootstrap, preferredActiveId?: string) => {
      setState((previous) => {
        const next = reconcileConnections(
          previous,
          bootstrap,
          preferredActiveId
        )
        stateRef.current = next
        return next
      })
      setReachability((previous) => {
        const next = new Map<string, ConnectionReachability>()
        for (const connection of bootstrap.connections) {
          next.set(
            connection.id,
            connection.ready
              ? (previous.get(connection.id) ?? "unknown")
              : "offline"
          )
        }
        return next
      })
      if (bootstrap.cleanupIssues?.[0]) {
        setActionError(bootstrap.cleanupIssues[0].message)
      }
    },
    []
  )

  const select = useCallback(async (connectionId: string) => {
    if (
      !stateRef.current.connections.some(
        (entry) => entry.metadata.id === connectionId
      )
      )
      return
    const previousId = stateRef.current.activeId
    setState((previous) => {
      const next = { ...previous, activeId: connectionId }
      stateRef.current = next
      return next
    })
    try {
      await bridge.selectConnection(connectionId)
    } catch (error) {
      if (stateRef.current.activeId === connectionId) {
        setState((previous) => {
          const next = { ...previous, activeId: previousId }
          stateRef.current = next
          return next
        })
      }
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }, [bridge, stateRef])

  const reportAttention = useCallback(
    (connectionId: string, value: ConnectionAttention) => {
      setAttention((previous) => {
        if ((previous.get(connectionId) ?? null) === value) return previous
        const next = new Map(previous)
        if (value) next.set(connectionId, value)
        else next.delete(connectionId)
        return next
      })
    },
    []
  )
  const reportReachability = useCallback(
    (connectionId: string, value: ConnectionReachability) => {
      setReachability((previous) => {
        if (previous.get(connectionId) === value) return previous
        const next = new Map(previous)
        next.set(connectionId, value)
        return next
      })
    },
    []
  )
  const forgetAttention = useCallback((connectionId: string) => {
    setAttention((previous) => {
      const next = new Map(previous)
      next.delete(connectionId)
      return next
    })
  }, [])
  const {
    pendingAction,
    probeRemote,
    probeReconnect,
    addRemote,
    rename,
    reconnect,
    remove,
    resetDesktopData,
    pickLocalProject,
    setupLocalWisp,
    applyLocalWispSetup,
  } = useConnectionActions({
    bridge,
    stateRef,
    setState,
    apply,
    forgetAttention,
    onBackgroundError: setActionError,
  })

  const active =
    state.connections.find((entry) => entry.metadata.id === state.activeId) ??
    state.connections[0]!
  const context = useMemo<DesktopConnectionContextValue>(
    () => ({
      connections: state.connections,
      active,
      attention,
      reachability,
      pendingAction,
      actionError,
      probeRemote,
      probeReconnect,
      select,
      addRemote,
      rename,
      reconnect,
      remove,
      resetDesktopData,
      pickLocalProject,
      setupLocalWisp,
      applyLocalWispSetup,
      reportAttention,
      reportReachability,
      clearActionError: () => setActionError(null),
    }),
    [
      state.connections,
      active,
      attention,
      reachability,
      pendingAction,
      actionError,
      probeRemote,
      probeReconnect,
      select,
      addRemote,
      rename,
      reconnect,
      remove,
      resetDesktopData,
      pickLocalProject,
      setupLocalWisp,
      applyLocalWispSetup,
      reportAttention,
      reportReachability,
    ]
  )

  return (
    <DesktopConnectionContext.Provider value={context}>
      <DesktopConnectionRuntime
        connections={state.connections}
        active={active}
        onAttention={reportAttention}
        onReachability={reportReachability}
      >
        {children}
      </DesktopConnectionRuntime>
    </DesktopConnectionContext.Provider>
  )
}

function DesktopConnectionRuntime({
  connections,
  active,
  onAttention,
  onReachability,
  children,
}: {
  connections: readonly DesktopConnectionEntry[]
  active: DesktopConnectionEntry
  onAttention: (connectionId: string, attention: ConnectionAttention) => void
  onReachability: (connectionId: string, value: ConnectionReachability) => void
  children: ReactNode
}) {
  return (
    <>
      {connections.map(
        (entry) =>
          entry.metadata.id !== active.metadata.id && (
            <InactiveConnectionMonitor
              key={entry.metadata.id}
              entry={entry}
              onAttention={onAttention}
              onReachability={onReachability}
            />
          )
      )}
      <DaemonRuntimeProvider
        key={active.metadata.id}
        transport={active.transport}
        recoverAfterUpdate={() =>
          queryClient.invalidateQueries({ queryKey: [active.metadata.id] })
        }
      >
        {children}
      </DaemonRuntimeProvider>
    </>
  )
}

function InactiveConnectionMonitor({
  entry,
  onAttention,
  onReachability,
}: {
  entry: DesktopConnectionEntry
  onAttention: (connectionId: string, attention: ConnectionAttention) => void
  onReachability: (connectionId: string, value: ConnectionReachability) => void
}) {
  useEffect(() => {
    if (!entry.metadata.ready) {
      onAttention(entry.metadata.id, null)
      onReachability(entry.metadata.id, "offline")
      return
    }
    let closed = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refresh = () => {
      void entry.transport.request<ApiTask[]>("/api/tasks").then(
        (tasks) => {
          if (!closed) {
            onAttention(entry.metadata.id, connectionAttention(tasks))
            onReachability(entry.metadata.id, "online")
          }
        },
        (error: unknown) => {
          if (!closed)
            onReachability(entry.metadata.id, classifyConnectionError(error))
        }
      )
    }
    const schedule = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(refresh, 250)
    }

    refresh()
    let events: EventSource | null = null
    try {
      events = entry.transport.openEventStream("/api/events")
      events.onopen = () => {
        onReachability(entry.metadata.id, "online")
        refresh()
      }
      events.onmessage = schedule
      // EventSource does not expose its HTTP refusal. Re-run the JSON probe so
      // authentication and identity failures are not mislabeled as offline.
      events.onerror = refresh
    } catch {
      // The next time this connection becomes active, the normal bridge owns recovery.
    }
    return () => {
      closed = true
      if (timer !== null) clearTimeout(timer)
      events?.close()
    }
  }, [entry, onAttention, onReachability])
  return null
}
