import { clearRememberedAttachments } from "@/lib/attachments"
import {
  clearConnectionStorage,
  synchronizeLocalRouteRevision,
} from "@/lib/connection-storage"
import type {
  DesktopBootstrap,
  DesktopBridge,
  DesktopConnectionMetadata,
} from "@/lib/desktop-bridge"
import { clearConnectionDrafts } from "@/lib/drafts"
import { queryClient } from "@/lib/query"

export async function clearForgottenConnection(
  connectionId: string,
  forgetAttention: (connectionId: string) => void,
  includeBuiltInLocal = false
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: [connectionId] })
  queryClient.removeQueries({ queryKey: [connectionId] })
  clearConnectionStorage(connectionId, undefined, includeBuiltInLocal)
  clearConnectionDrafts(connectionId)
  clearRememberedAttachments(connectionId)
  forgetAttention(connectionId)
}

function clearDesktopWebviewData(): void {
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    // Native credentials and routes are already gone; blocked convenience
    // storage must not make a successful reset look reversible.
  }
}

export async function resetDesktopApplication({
  bridge,
  connections,
  apply,
  forgetAttention,
}: {
  bridge: DesktopBridge
  connections: readonly { metadata: DesktopConnectionMetadata }[]
  apply: (bootstrap: DesktopBootstrap, preferredActiveId?: string) => void
  forgetAttention: (connectionId: string) => void
}): Promise<void> {
  let resetError: unknown = null
  try {
    await bridge.resetDesktopData()
  } catch (error) {
    // Reset is a revocation-first transaction. Reconcile even when a deferred
    // Keychain cleanup reports an error after routes have disappeared.
    resetError = error
  }
  const bootstrap = await bridge.bootstrap()
  apply(bootstrap, "local")
  const resetEffective = bootstrap.connections.every(
    (connection) => connection.kind === "local"
  )
  if (resetEffective) {
    for (const entry of connections) {
      await clearForgottenConnection(entry.metadata.id, forgetAttention)
    }
    clearDesktopWebviewData()
    const localRevision = bootstrap.connections.find(
      (connection) => connection.id === "local"
    )?.routeRevision
    if (localRevision !== undefined)
      synchronizeLocalRouteRevision(localRevision)
  }
  if (resetError) throw resetError
}
