import type { Dispatch, SetStateAction } from "react"

import type { DesktopBridge } from "@/lib/desktop-bridge"
import type {
  ApplyBootstrap,
  ConnectionState,
} from "@/lib/desktop-connections"
import { clearForgottenConnection } from "@/lib/desktop-reset"
import { queryClient } from "@/lib/query"

/** Revoke UI routing before native cleanup, then reconcile partial failures. */
export async function removeDesktopConnection({
  connectionId,
  bridge,
  stateRef,
  setState,
  apply,
  forgetAttention,
  onBackgroundError,
}: {
  connectionId: string
  bridge: DesktopBridge
  stateRef: React.RefObject<ConnectionState>
  setState: Dispatch<SetStateAction<ConnectionState>>
  apply: ApplyBootstrap
  forgetAttention: (connectionId: string) => void
  onBackgroundError: (message: string) => void
}): Promise<void> {
  const before = stateRef.current
  const target = before.connections.find(
    (entry) => entry.metadata.id === connectionId
  )
  if (!target) throw new Error("Unknown desktop connection")
  if (target.metadata.kind === "local")
    throw new Error("The built-in Local connection cannot be removed")
  const local = before.connections.find(
    (entry) => entry.metadata.kind === "local"
  )!
  const withoutTarget = Object.freeze({
    ...before,
    connections: Object.freeze(
      before.connections.filter(
        (entry) => entry.metadata.id !== connectionId
      )
    ),
    activeId:
      before.activeId === connectionId ? local.metadata.id : before.activeId,
  })
  stateRef.current = withoutTarget
  setState(withoutTarget)
  await queryClient.cancelQueries({ queryKey: [connectionId] })
  let removalError: unknown = null
  try {
    await bridge.removeConnection(connectionId)
  } catch (error) {
    removalError = error
  }
  const bootstrap = await bridge.bootstrap()
  apply(bootstrap, stateRef.current.activeId)
  if (
    !bootstrap.connections.some(
      (connection) => connection.id === connectionId
    )
  ) {
    await clearForgottenConnection(connectionId, forgetAttention)
  }
  if (removalError) {
    onBackgroundError(
      removalError instanceof Error
        ? removalError.message
        : String(removalError)
    )
    throw removalError
  }
}
