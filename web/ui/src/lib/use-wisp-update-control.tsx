import { useMemo, useRef, useState } from "react"

import {
  UpdateCenter,
  WispUpdateControl,
  type DaemonUpdateOperation,
} from "@/components/update-control"
import { useInstallUpdate, useRefreshUpdateStatus } from "@/hooks/mutations"
import { useUpdateStatus } from "@/hooks/queries"
import { SUPPORTED_DESKTOP_API_PROTOCOL_VERSIONS } from "@/lib/desktop-bridge"
import { useDesktopConnections } from "@/lib/desktop-connections"
import {
  desktopUpdateBlocksDaemon,
  useDesktopUpdater,
} from "@/lib/desktop-updater"
import { queryClient } from "@/lib/query"
import { createDaemonRuntime, useDaemonRuntime } from "@/lib/runtime"
import { waitForUpdatedDaemon } from "@/lib/update"

/** Keeps daemon-update ownership above connection-keyed application remounts. */
export function useWispUpdateControl() {
  const runtime = useDaemonRuntime()
  const desktop = useDesktopConnections()
  const desktopUpdater = useDesktopUpdater()
  const localConnection = desktop?.connections.find(
    (connection) => connection.metadata.kind === "local"
  )
  const updateRuntime = useMemo(() => {
    if (!localConnection) return runtime
    return createDaemonRuntime(localConnection.transport, {
      recoverAfterUpdate: () =>
        queryClient.invalidateQueries({
          queryKey: [localConnection.metadata.id],
        }),
    })
  }, [localConnection, runtime])
  const updateQuery = useUpdateStatus(updateRuntime)
  const installUpdate = useInstallUpdate(updateRuntime)
  const refreshUpdate = useRefreshUpdateStatus(updateRuntime)
  const [updateError, setUpdateError] = useState<{
    connectionId: string
    message: string
  } | null>(null)
  const [operation, setOperation] = useState<DaemonUpdateOperation | null>(null)
  const operationRef = useRef<DaemonUpdateOperation | null>(null)
  const desktopOperationRef = useRef(false)
  const checkOperationRef = useRef(false)
  const desktopBlocksDaemon = desktopUpdater
    ? desktopUpdateBlocksDaemon(desktopUpdater.status, desktopUpdater.pending)
    : false

  const updateWisp = async (version: string) => {
    if (
      operationRef.current ||
      desktopOperationRef.current ||
      checkOperationRef.current ||
      desktopBlocksDaemon
    )
      return
    const initiatingRuntime = updateRuntime
    const connectionName = desktop ? "Local" : "Wisp"
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

  const updateDesktop = async (version: string) => {
    if (
      !desktopUpdater ||
      operationRef.current ||
      desktopOperationRef.current ||
      checkOperationRef.current
    )
      return
    desktopOperationRef.current = true
    try {
      await desktopUpdater.install(version)
      if (!operationRef.current) await desktopUpdater.relaunch()
    } finally {
      desktopOperationRef.current = false
    }
  }

  const checkUpdates = async () => {
    if (
      !desktopUpdater ||
      operationRef.current ||
      desktopOperationRef.current ||
      checkOperationRef.current ||
      desktopBlocksDaemon
    )
      return
    checkOperationRef.current = true
    setUpdateError((current) =>
      current?.connectionId === updateRuntime.connectionId ? null : current
    )
    try {
      const [, daemonResult] = await Promise.allSettled([
        desktopUpdater.check(),
        refreshUpdate.mutateAsync(),
      ])
      if (daemonResult.status === "rejected") {
        setUpdateError({
          connectionId: updateRuntime.connectionId,
          message:
            daemonResult.reason instanceof Error
              ? daemonResult.reason.message
              : String(daemonResult.reason),
        })
      }
    } finally {
      checkOperationRef.current = false
    }
  }

  const activeError =
    updateError?.connectionId === updateRuntime.connectionId
      ? updateError.message
      : null
  const render = (mobile: boolean) =>
    desktop && desktopUpdater ? (
      <UpdateCenter
        desktop={desktopUpdater}
        daemonStatus={updateQuery.data}
        daemonError={activeError}
        daemonOperation={operation}
        checkingDaemon={refreshUpdate.isPending}
        supportedApiProtocols={SUPPORTED_DESKTOP_API_PROTOCOL_VERSIONS}
        onUpdateDesktop={(version) =>
          void updateDesktop(version).catch(() => undefined)
        }
        onUpdateDaemon={(version) => void updateWisp(version)}
        onCheck={() => void checkUpdates()}
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
