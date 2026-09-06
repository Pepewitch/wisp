import { useRef, useState } from "react"

import {
  UpdateCenter,
  WispUpdateControl,
  type DaemonUpdateOperation,
} from "@/components/update-control"
import { useInstallUpdate } from "@/hooks/mutations"
import { useUpdateStatus } from "@/hooks/queries"
import { SUPPORTED_DESKTOP_API_PROTOCOL_VERSIONS } from "@/lib/desktop-bridge"
import { useDesktopConnections } from "@/lib/desktop-connections"
import { useDesktopUpdater } from "@/lib/desktop-updater"
import { queryClient } from "@/lib/query"
import { useDaemonRuntime } from "@/lib/runtime"
import { waitForUpdatedDaemon } from "@/lib/update"

/** Keeps daemon-update ownership above connection-keyed application remounts. */
export function useWispUpdateControl() {
  const runtime = useDaemonRuntime()
  const desktop = useDesktopConnections()
  const desktopUpdater = useDesktopUpdater()
  const updateQuery = useUpdateStatus()
  const installUpdate = useInstallUpdate()
  const [updateError, setUpdateError] = useState<{
    connectionId: string
    message: string
  } | null>(null)
  const [operation, setOperation] = useState<DaemonUpdateOperation | null>(null)
  const operationRef = useRef<DaemonUpdateOperation | null>(null)

  const updateWisp = async (version: string) => {
    if (operationRef.current) return
    const initiatingRuntime = runtime
    const connectionName = desktop?.active.metadata.name ?? "Wisp"
    const installing: DaemonUpdateOperation = {
      connectionId: initiatingRuntime.connectionId,
      connectionName,
      phase: "installing",
    }
    operationRef.current = installing
    setOperation(installing)
    setUpdateError((current) =>
      current?.connectionId === initiatingRuntime.connectionId ? null : current
    )
    try {
      await installUpdate.mutateAsync(version)
      const restarting = { ...installing, phase: "restarting" as const }
      operationRef.current = restarting
      setOperation(restarting)
      await waitForUpdatedDaemon(version, {
        transport: initiatingRuntime.transport,
      })
      await initiatingRuntime.recoverAfterUpdate()
    } catch (error) {
      setUpdateError({
        connectionId: initiatingRuntime.connectionId,
        message: error instanceof Error ? error.message : String(error),
      })
      void queryClient.invalidateQueries({
        queryKey: initiatingRuntime.qk.update,
      })
    } finally {
      operationRef.current = null
      setOperation(null)
    }
  }

  const activeError =
    updateError?.connectionId === runtime.connectionId
      ? updateError.message
      : null
  const render = (mobile: boolean) =>
    desktop && desktopUpdater ? (
      <UpdateCenter
        desktop={desktopUpdater}
        daemonStatus={updateQuery.data}
        daemonError={activeError}
        daemonOperation={operation}
        connectionId={runtime.connectionId}
        connectionName={desktop.active.metadata.name}
        supportedApiProtocols={SUPPORTED_DESKTOP_API_PROTOCOL_VERSIONS}
        onUpdateDaemon={(version) => void updateWisp(version)}
        mobile={mobile}
      />
    ) : (
      <WispUpdateControl
        status={updateQuery.data}
        updating={operation?.connectionId === runtime.connectionId}
        error={activeError}
        onUpdate={(version) => void updateWisp(version)}
      />
    )
  return {
    desktop: render(false),
    mobile: render(true),
  }
}
