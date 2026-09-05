/* eslint-disable react-refresh/only-export-components -- context and its desktop root form one boundary */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { WispMark } from "@/components/icons"
import { Button } from "@/components/primitives"
import { clearConnectionStorage } from "@/lib/connection-storage"
import {
  connectionAttention,
  type ConnectionAttention,
} from "@/lib/connection-attention"
import {
  MAX_DESKTOP_CONNECTIONS,
  desktopBridge,
  type AddRemoteConnectionInput,
  type DesktopBootstrap,
  type DesktopBridge,
  type DesktopConnectionMetadata,
  type ReconnectConnectionInput,
} from "@/lib/desktop-bridge"
import { createDesktopTransport } from "@/lib/desktop-transport"
import { clearConnectionDrafts } from "@/lib/drafts"
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
  readonly pendingAction: string | null
  select(connectionId: string): void
  addRemote(input: AddRemoteConnectionInput): Promise<void>
  rename(connectionId: string, name: string): Promise<void>
  reconnect(input: ReconnectConnectionInput): Promise<void>
  remove(connectionId: string): Promise<void>
  pickLocalProject(): Promise<string | null>
  setupLocalWisp(): Promise<void>
  reportAttention(connectionId: string, attention: ConnectionAttention): void
}

const DesktopConnectionContext =
  createContext<DesktopConnectionContextValue | null>(null)

interface ConnectionState {
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
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const pendingActionRef = useRef<string | null>(null)

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
    },
    []
  )

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

  const select = useCallback((connectionId: string) => {
    if (
      !stateRef.current.connections.some(
        (entry) => entry.metadata.id === connectionId
      )
    )
      return
    setState((previous) => {
      const next = { ...previous, activeId: connectionId }
      stateRef.current = next
      return next
    })
  }, [])

  const addRemote = useCallback(
    (input: AddRemoteConnectionInput) =>
      transact("add", async () => {
        if (stateRef.current.connections.length >= MAX_DESKTOP_CONNECTIONS) {
          throw new Error(
            `Desktop supports at most ${MAX_DESKTOP_CONNECTIONS} connections`
          )
        }
        const previousIds = new Set(
          stateRef.current.connections.map((entry) => entry.metadata.id)
        )
        await bridge.addRemoteConnection(input)
        const bootstrap = await bridge.bootstrap()
        const added = bootstrap.connections.find(
          (connection) => !previousIds.has(connection.id)
        )
        apply(bootstrap, added?.id ?? stateRef.current.activeId)
      }),
    [apply, bridge, transact]
  )

  const rename = useCallback(
    (connectionId: string, name: string) =>
      transact(`rename:${connectionId}`, async () => {
        await bridge.renameConnection(connectionId, name)
        apply(await bridge.bootstrap(), stateRef.current.activeId)
      }),
    [apply, bridge, transact]
  )

  const reconnect = useCallback(
    (input: ReconnectConnectionInput) =>
      transact(`reconnect:${input.connectionId}`, async () => {
        await bridge.reconnectConnection(input)
        apply(await bridge.bootstrap(), stateRef.current.activeId)
        void queryClient.invalidateQueries({ queryKey: [input.connectionId] })
      }),
    [apply, bridge, transact]
  )

  const remove = useCallback(
    (connectionId: string) =>
      transact(`remove:${connectionId}`, async () => {
        const target = stateRef.current.connections.find(
          (entry) => entry.metadata.id === connectionId
        )
        if (!target) throw new Error("Unknown desktop connection")
        if (target.metadata.kind === "local") {
          throw new Error("The built-in Local connection cannot be removed")
        }
        const removedActive = stateRef.current.activeId === connectionId
        await bridge.removeConnection(connectionId)
        const bootstrap = await bridge.bootstrap()
        apply(
          bootstrap,
          removedActive
            ? bootstrap.activeConnectionId
            : stateRef.current.activeId
        )
        queryClient.removeQueries({ queryKey: [connectionId] })
        clearConnectionStorage(connectionId)
        clearConnectionDrafts(connectionId)
        setAttention((previous) => {
          const next = new Map(previous)
          next.delete(connectionId)
          return next
        })
      }),
    [apply, bridge, transact]
  )

  const pickLocalProject = useCallback(
    () => bridge.pickLocalProject(),
    [bridge]
  )

  const setupLocalWisp = useCallback(
    () =>
      transact("setup:local", async () => {
        await bridge.setupLocalWisp()
        apply(await bridge.bootstrap(), stateRef.current.activeId)
        void queryClient.invalidateQueries({ queryKey: ["local"] })
      }),
    [apply, bridge, transact]
  )

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

  const active =
    state.connections.find((entry) => entry.metadata.id === state.activeId) ??
    state.connections[0]!
  const context = useMemo<DesktopConnectionContextValue>(
    () => ({
      connections: state.connections,
      active,
      attention,
      pendingAction,
      select,
      addRemote,
      rename,
      reconnect,
      remove,
      pickLocalProject,
      setupLocalWisp,
      reportAttention,
    }),
    [
      state.connections,
      active,
      attention,
      pendingAction,
      select,
      addRemote,
      rename,
      reconnect,
      remove,
      pickLocalProject,
      setupLocalWisp,
      reportAttention,
    ]
  )

  return (
    <DesktopConnectionContext.Provider value={context}>
      <DesktopConnectionRuntime
        connections={state.connections}
        active={active}
        onAttention={reportAttention}
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
  children,
}: {
  connections: readonly DesktopConnectionEntry[]
  active: DesktopConnectionEntry
  onAttention: (connectionId: string, attention: ConnectionAttention) => void
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
}: {
  entry: DesktopConnectionEntry
  onAttention: (connectionId: string, attention: ConnectionAttention) => void
}) {
  useEffect(() => {
    let closed = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refresh = () => {
      void entry.transport.request<ApiTask[]>("/api/tasks").then(
        (tasks) => {
          if (!closed)
            onAttention(entry.metadata.id, connectionAttention(tasks))
        },
        () => undefined
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
      events.onopen = refresh
      events.onmessage = schedule
    } catch {
      // The next time this connection becomes active, the normal bridge owns recovery.
    }
    return () => {
      closed = true
      if (timer !== null) clearTimeout(timer)
      events?.close()
    }
  }, [entry, onAttention])
  return null
}

export function DesktopBootstrapScreen({
  promise,
  children,
}: {
  promise: Promise<DesktopBootstrap>
  children: (bootstrap: DesktopBootstrap) => ReactNode
}) {
  const [result, setResult] = useState<{
    bootstrap?: DesktopBootstrap
    error?: string
  }>({})
  useEffect(() => {
    let live = true
    void promise.then(
      (bootstrap) => live && setResult({ bootstrap }),
      (error: unknown) =>
        live &&
        setResult({
          error: error instanceof Error ? error.message : String(error),
        })
    )
    return () => {
      live = false
    }
  }, [promise])

  if (result.bootstrap) return children(result.bootstrap)
  return (
    <div className="flex h-dvh items-center justify-center bg-background text-foreground">
      <div className="flex max-w-sm flex-col items-center px-6 text-center">
        <span role="img" aria-label="Wisp">
          <WispMark className="size-7" />
        </span>
        {result.error ? (
          <>
            <h1 className="mt-4 text-[14.5px] font-semibold">
              Could not start Wisp Desktop
            </h1>
            <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
              {result.error}
            </p>
            <Button
              size="lg"
              className="mt-4"
              onClick={() => window.location.reload()}
            >
              Retry
            </Button>
          </>
        ) : (
          <p className="mt-3 text-[12px] text-muted-foreground">
            Starting desktop connections…
          </p>
        )}
      </div>
    </div>
  )
}
