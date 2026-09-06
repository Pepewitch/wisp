import { useCallback } from "react"

import type {
  DesktopBootstrap,
  DesktopBridge,
  LocalSetupReport,
  LocalSetupStep,
} from "@/lib/desktop-bridge"
import { queryClient } from "@/lib/query"

type Transaction = <T>(label: string, action: () => Promise<T>) => Promise<T>

export function useLocalConnectionActions({
  bridge,
  stateRef,
  apply,
  transact,
}: {
  bridge: DesktopBridge
  stateRef: React.RefObject<{ readonly activeId: string }>
  apply: (bootstrap: DesktopBootstrap, preferredActiveId?: string) => void
  transact: Transaction
}) {
  const refreshLocal = useCallback(
    async (command: () => Promise<LocalSetupReport>) => {
      const report = await command()
      apply(await bridge.bootstrap(), stateRef.current.activeId)
      void queryClient.invalidateQueries({ queryKey: ["local"] })
      return report
    },
    [apply, bridge, stateRef]
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
