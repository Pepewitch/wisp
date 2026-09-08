import { useMemo, useRef, useState } from "react"

import {
  UpdateCenter,
  WispUpdateControl,
} from "@/components/update-control"
import { useInstallUpdate, useRefreshUpdateStatus } from "@/hooks/mutations"
import { useUpdateStatus } from "@/hooks/queries"
import { SUPPORTED_DESKTOP_API_PROTOCOL_VERSIONS } from "@/lib/desktop-bridge"
import { useDesktopConnections } from "@/lib/desktop-connections"
import {
  desktopUpdateBlocksDaemon,
  useDesktopUpdater,
} from "@/lib/desktop-updater"
import { useDesktopUpdateCoordination } from "@/lib/desktop-update-coordination"
import { queryClient } from "@/lib/query"
import { createDaemonRuntime, useDaemonRuntime } from "@/lib/runtime"
import {
  waitForUpdatedDaemon,
  type DaemonUpdateOperation,
} from "@/lib/update"

/** Binds browser updates to one runtime and Desktop updates to app-global Local. */
export function useWispUpdateControl() {
  const runtime = useDaemonRuntime()
  const desktop = useDesktopConnections()
  const desktopUpdater = useDesktopUpdater()
  const desktopCoordination = useDesktopUpdateCoordination()
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
  const [browserUpdateError, setBrowserUpdateError] = useState<{
    connectionId: string
    message: string
  } | null>(null)
  const [browserOperation, setBrowserOperation] =
    useState<DaemonUpdateOperation | null>(null)
  const browserOperationRef = useRef<DaemonUpdateOperation | null>(null)
  const browserDesktopOperationRef = useRef(false)
  const browserCheckOperationRef = useRef(false)
  const operation =
    desktopCoordination?.daemonOperation ?? browserOperation
  const setOperation =
    desktopCoordination?.setDaemonOperation ?? setBrowserOperation
  const operationRef =
    desktopCoordination?.daemonOperationRef ?? browserOperationRef
  const desktopOperationRef =
    desktopCoordination?.desktopOperationRef ?? browserDesktopOperationRef
  const checkOperationRef =
    desktopCoordination?.checkOperationRef ?? browserCheckOperationRef
  const updateError = desktopCoordination
    ? desktopCoordination.daemonError
    : browserUpdateError?.connectionId === updateRuntime.connectionId
      ? browserUpdateError.message
      : null
  const clearUpdateError = (connectionId: string) => {
    if (desktopCoordination) desktopCoordination.setDaemonError(null)
    else
      setBrowserUpdateError((current) =>
        current?.connectionId === connectionId ? null : current
      )
  }
  const recordUpdateError = (connectionId: string, message: string) => {
    if (desktopCoordination) desktopCoordination.setDaemonError(message)
    else setBrowserUpdateError({ connectionId, message })
  }
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
    clearUpdateError(initiatingRuntime.connectionId)
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
      recordUpdateError(
        initiatingRuntime.connectionId,
        error instanceof Error ? error.message : String(error)
      )
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
    desktopCoordination?.setCheckingDaemon(true)
    clearUpdateError(updateRuntime.connectionId)
    try {
      const [, daemonResult] = await Promise.allSettled([
        desktopUpdater.check(),
        refreshUpdate.mutateAsync(),
      ])
      if (daemonResult.status === "rejected") {
        recordUpdateError(
          updateRuntime.connectionId,
          daemonResult.reason instanceof Error
            ? daemonResult.reason.message
            : String(daemonResult.reason)
        )
      }
    } finally {
      checkOperationRef.current = false
      desktopCoordination?.setCheckingDaemon(false)
    }
  }

  const checkingDaemon =
    desktopCoordination?.checkingDaemon ?? refreshUpdate.isPending
  const render = (mobile: boolean) =>
    desktop && desktopUpdater ? (
      <UpdateCenter
        desktop={desktopUpdater}
        daemonStatus={updateQuery.data}
        daemonError={updateError}
        daemonOperation={operation}
        checkingDaemon={checkingDaemon}
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
        error={updateError}
        onUpdate={(version) => void updateWisp(version)}
      />
    )
  return {
    desktop: render(false),
    mobile: render(true),
  }
}
