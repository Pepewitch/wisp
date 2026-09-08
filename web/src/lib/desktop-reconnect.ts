import type {
  DesktopBridge,
  ReconnectConnectionInput,
} from "@/lib/desktop-bridge"
import type {
  ApplyBootstrap,
  ConnectionState,
} from "@/lib/desktop-connections"
import { clearForgottenConnection } from "@/lib/desktop-reset"
import { queryClient } from "@/lib/query"

/** Reconcile both immutable remote replacement and stable-ID Local retargets. */
export async function reconnectDesktopConnection({
  input,
  bridge,
  stateRef,
  apply,
  forgetAttention,
  onBackgroundError,
}: {
  input: ReconnectConnectionInput
  bridge: DesktopBridge
  stateRef: React.RefObject<ConnectionState>
  apply: ApplyBootstrap
  forgetAttention: (connectionId: string) => void
  onBackgroundError: (message: string) => void
}): Promise<void> {
  const before = stateRef.current
  const activeBefore = before.activeId
  const target = before.connections.find(
    (entry) => entry.metadata.id === input.connectionId
  )?.metadata
  try {
    const reconnected = await bridge.reconnectConnection(input)
    if (
      input.connectionId === "local" &&
      target?.routeRevision !== reconnected.routeRevision
    ) {
      await clearForgottenConnection(input.connectionId, forgetAttention, true)
    }
    apply(
      await bridge.bootstrap(),
      activeBefore === input.connectionId ? reconnected.id : activeBefore
    )
    if (reconnected.id !== input.connectionId) {
      await clearForgottenConnection(input.connectionId, forgetAttention)
    }
    void queryClient.invalidateQueries({ queryKey: [reconnected.id] })
  } catch (error) {
    // Native remote replacement can commit before deferred Keychain cleanup
    // reports failure. Always reconcile so no revoked ID remains routable.
    const bootstrap = await bridge.bootstrap()
    const oldStillExists = bootstrap.connections.some(
      (connection) => connection.id === input.connectionId
    )
    const replacement = bootstrap.connections.find(
      (connection) =>
        connection.id !== input.connectionId && connection.name === target?.name
    )
    if (activeBefore === input.connectionId && !oldStillExists && replacement) {
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
    onBackgroundError(error instanceof Error ? error.message : String(error))
    throw error
  }
}
