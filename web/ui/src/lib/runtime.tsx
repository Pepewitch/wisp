/* eslint-disable react-refresh/only-export-components -- the provider and its runtime hooks are one public seam */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react"

import { createConnectionQueryKeys, type ConnectionQueryKeys } from "./query"
import type { DaemonTransport } from "./transport"

/** Stable connection-bound services consumed by the shared React tree. */
export interface DaemonRuntime {
  readonly connectionId: string
  readonly transport: DaemonTransport
  readonly qk: Readonly<ConnectionQueryKeys>
  /** Runtime policy after this daemon proves an installed update is live. */
  recoverAfterUpdate(): Promise<void> | void
}

export function createDaemonRuntime(
  transport: DaemonTransport,
  options: { recoverAfterUpdate?: () => Promise<void> | void } = {}
): Readonly<DaemonRuntime> {
  return Object.freeze({
    connectionId: transport.connectionId,
    transport,
    qk: createConnectionQueryKeys(transport.connectionId),
    recoverAfterUpdate: options.recoverAfterUpdate ?? (() => undefined),
  })
}

const RuntimeContext = createContext<Readonly<DaemonRuntime> | null>(null)

export function DaemonRuntimeProvider({
  transport,
  recoverAfterUpdate,
  children,
}: {
  transport: DaemonTransport
  recoverAfterUpdate?: () => Promise<void> | void
  children: ReactNode
}) {
  // The keyed scope makes a connection change a hard lifecycle boundary.
  // Pending observers and recovery callbacks from the old daemon keep their
  // old scope instead of adopting the newly selected connection.
  return (
    <DaemonRuntimeScope
      key={transport.connectionId}
      transport={transport}
      recoverAfterUpdate={recoverAfterUpdate}
    >
      {children}
    </DaemonRuntimeScope>
  )
}

function DaemonRuntimeScope({
  transport,
  recoverAfterUpdate,
  children,
}: {
  transport: DaemonTransport
  recoverAfterUpdate?: () => Promise<void> | void
  children: ReactNode
}) {
  const recoverRef = useRef(recoverAfterUpdate)
  useEffect(() => {
    recoverRef.current = recoverAfterUpdate
  }, [recoverAfterUpdate])
  const recoverLatest = useCallback(() => recoverRef.current?.(), [])
  const runtime = useMemo(
    // recoverLatest reads the ref only after an update finishes, never during render.
    // eslint-disable-next-line react-hooks/refs
    () => createDaemonRuntime(transport, { recoverAfterUpdate: recoverLatest }),
    [transport, recoverLatest]
  )
  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
    </RuntimeContext.Provider>
  )
}

export function useDaemonRuntime(): Readonly<DaemonRuntime> {
  const runtime = useContext(RuntimeContext)
  if (!runtime)
    throw new Error(
      "useDaemonRuntime must be used inside DaemonRuntimeProvider"
    )
  return runtime
}

export function useDaemonTransport(): DaemonTransport {
  return useDaemonRuntime().transport
}

export function useDaemonQueryKeys(): Readonly<ConnectionQueryKeys> {
  return useDaemonRuntime().qk
}
