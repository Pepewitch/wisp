import { useCallback } from "react"

import type {
  DesktopBootstrap,
  DesktopBridge,
  DesktopConnectionMetadata,
  LocalSetupReport,
  LocalSetupStep,
} from "@/lib/desktop-bridge"
import { clearForgottenConnection } from "@/lib/desktop-reset"
import { queryClient } from "@/lib/query"

type Transaction = <T>(label: string, action: () => Promise<T>) => Promise<T>

export function useLocalConnectionActions({
  bridge,
  stateRef,
  apply,
  transact,
  forgetAttention,
}: {
  bridge: DesktopBridge
  stateRef: React.RefObject<{
    readonly activeId: string
    readonly connections: readonly { metadata: DesktopConnectionMetadata }[]
  }>
  apply: (bootstrap: DesktopBootstrap, preferredActiveId?: string) => void
  transact: Transaction
  forgetAttention: (connectionId: string) => void
}) {
  const refreshLocal = useCallback(
    async (command: () => Promise<LocalSetupReport>) => {
      const previousRevision = stateRef.current.connections.find(
        (entry) => entry.metadata.id === "local"
      )?.metadata.routeRevision
      const report = await command()
      const bootstrap = await bridge.bootstrap()
      const nextRevision = bootstrap.connections.find(
        (connection) => connection.id === "local"
      )?.routeRevision
      if (previousRevision !== nextRevision) {
        await clearForgottenConnection("local", forgetAttention, true)
      }
      apply(bootstrap, stateRef.current.activeId)
      void queryClient.invalidateQueries({ queryKey: ["local"] })
      return report
    },
    [apply, bridge, forgetAttention, stateRef]
  )
  const pickLocalProject = useCallback(async () => {
    if (stateRef.current.activeId !== "local")
      throw new Error("The native folder picker is only available for Local")
    const picked = await bridge.pickLocalProject()
    if (stateRef.current.activeId !== "local")
      throw new Error(
        "Project selection was cancelled after changing connections"
      )
    return picked
  }, [bridge, stateRef])
  const setupLocalWisp = useCallback(
    () => refreshLocal(() => bridge.setupLocalWisp()),
    [bridge, refreshLocal]
  )
  const applyLocalWispSetup = useCallback(
    (expectedStep: LocalSetupStep) =>
      transact("apply-setup:local", () =>
        refreshLocal(() => bridge.applyLocalWispSetup(expectedStep))
      ),
    [bridge, refreshLocal, transact]
  )
  return { pickLocalProject, setupLocalWisp, applyLocalWispSetup }
}
