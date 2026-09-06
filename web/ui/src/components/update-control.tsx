import { Popover } from "@base-ui/react/popover"

import { Refresh } from "@/components/icons"
import { Button, POPOVER_SURFACE } from "@/components/primitives"
import type { DesktopUpdateStatus } from "@/lib/desktop-bridge"
import {
  desktopUpdateBlocksDaemon,
  type DesktopUpdaterContextValue,
} from "@/lib/desktop-updater"
import type { UpdateStatus } from "@/lib/types"
import { daemonUpdateIsCompatible } from "@/lib/update-compatibility"
import { cn } from "@/lib/utils"

export interface DaemonUpdateOperation {
  readonly connectionId: string
  readonly connectionName: string
  readonly phase: "installing" | "restarting"
}

/** The browser's one-daemon update control. Desktop uses UpdateCenter below. */
export function WispUpdateControl({
  status,
  updating,
  error,
  onUpdate,
}: {
  status: UpdateStatus | undefined
  updating: boolean
  error: string | null
  onUpdate: (version: string) => void
}) {
  if (!status) return null

  const target = status.latestVersion
  const busy =
    !error &&
    (updating || status.state === "installing" || status.state === "restarting")
  if (target && busy) {
    return (
      <Button size="sm" disabled title={`Installing Wisp daemon ${target}`}>
        Updating daemon…
      </Button>
    )
  }

  if (
    target &&
    status.canAutoUpdate &&
    (status.state === "available" || status.state === "failed")
  ) {
    return (
      <Button
        size="sm"
        tone="outline"
        onClick={() => onUpdate(target)}
        title={
          error ?? status.message ?? `Install Wisp daemon ${target} and restart`
        }
      >
        {status.state === "failed" || error
          ? "Retry daemon update"
          : `Update daemon ${target}`}
      </Button>
    )
  }

  const title =
    error ??
    status.message ??
    (target && status.state === "available"
      ? `Wisp daemon ${target} is available; this installation updates manually`
      : `Wisp daemon ${status.currentVersion}`)
  return (
    <span
      className={cn(
        error && "text-[11.5px] text-destructive",
        !error && "font-mono text-[10.5px] text-faint"
      )}
      title={title}
    >
      {error ? "Daemon update failed" : status.currentVersion}
    </span>
  )
}

export function UpdateCenter({
  desktop,
  daemonStatus,
  daemonError,
  daemonOperation,
  connectionId,
  connectionName,
  supportedApiProtocols,
  onUpdateDesktop,
  onUpdateDaemon,
  mobile = false,
  defaultOpen = false,
}: {
  desktop: DesktopUpdaterContextValue
  daemonStatus: UpdateStatus | undefined
  daemonError: string | null
  daemonOperation: DaemonUpdateOperation | null
  connectionId: string
  connectionName: string
  supportedApiProtocols: readonly number[]
  onUpdateDesktop: (version: string) => void
  onUpdateDaemon: (version: string) => void
  mobile?: boolean
  /** Gallery/test seam. Production leaves the surface closed initially. */
  defaultOpen?: boolean
}) {
  const desktopAvailable =
    desktop.status?.latestVersion !== null &&
    desktop.status?.latestVersion !== undefined &&
    ["available", "failed", "ready-to-relaunch"].includes(desktop.status.phase)
  const compatible = daemonUpdateIsCompatible(
    daemonStatus,
    supportedApiProtocols
  )
  const daemonAvailable =
    daemonStatus?.latestVersion !== null &&
    daemonStatus?.latestVersion !== undefined &&
    daemonStatus.canAutoUpdate &&
    compatible &&
    (daemonStatus.state === "available" || daemonStatus.state === "failed")
  const availableCount = Number(desktopAvailable) + Number(daemonAvailable)
  const hasFailure =
    desktop.error !== null ||
    desktop.status?.phase === "failed" ||
    daemonError !== null ||
    daemonStatus?.state === "failed"
  const activeDaemonBusy = daemonOperation?.connectionId === connectionId
  const desktopBlocksDaemon = desktopUpdateBlocksDaemon(
    desktop.status,
    desktop.pending
  )

  return (
    <Popover.Root defaultOpen={defaultOpen}>
      <Popover.Trigger
        render={<Button size={mobile ? "lg" : "sm"} />}
        className={mobile ? "max-w-24 px-2" : undefined}
        title={
          hasFailure
            ? "An update needs attention"
            : "Application and daemon updates"
        }
      >
        <span className="truncate">Updates</span>
        {availableCount > 0 && (
          <span className="font-mono text-[10.5px] text-muted-foreground">
            · {availableCount}
          </span>
        )}
        {hasFailure && (
          <span
            aria-label="Update needs attention"
            className="text-destructive"
          >
            !
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="z-(--z-menu)"
        >
          <Popover.Popup
            className={cn(
              POPOVER_SURFACE,
              "w-[360px] max-w-[calc(100vw-24px)] rounded-xl p-3 outline-none"
            )}
          >
            <Popover.Title className="text-[13px] font-semibold">
              Updates
            </Popover.Title>
            <div className="mt-2 divide-y divide-border">
              <DesktopUpdateRow
                status={desktop.status}
                pending={desktop.pending}
                error={desktop.error}
                daemonOperation={daemonOperation}
                onInstall={onUpdateDesktop}
                onRelaunch={() =>
                  void desktop.relaunch().catch(() => undefined)
                }
              />
              <DaemonUpdateRow
                status={daemonStatus}
                error={daemonError}
                operation={daemonOperation}
                activeOperation={activeDaemonBusy}
                connectionName={connectionName}
                compatible={compatible}
                desktopBlocksDaemon={desktopBlocksDaemon}
                supportedApiProtocols={supportedApiProtocols}
                onUpdate={onUpdateDaemon}
              />
            </div>
            {daemonOperation && !activeDaemonBusy && (
              <p className="mt-2 text-[11px] leading-normal text-muted-foreground">
                {daemonOperation.connectionName} daemon is{" "}
                {daemonOperation.phase}. Desktop relaunch stays disabled until
                it recovers.
              </p>
            )}
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2">
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={desktop.checkAfterLaunch}
                  onChange={(event) =>
                    desktop.setCheckAfterLaunch(event.currentTarget.checked)
                  }
                  className="accent-primary"
                />
                Check after launch
              </label>
              <Button
                size="sm"
                disabled={
                  desktop.pending ||
                  desktop.status?.phase === "ready-to-relaunch"
                }
                onClick={() => void desktop.check().catch(() => undefined)}
              >
                <Refresh />
                Check now
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function DesktopUpdateRow({
  status,
  pending,
  error,
  daemonOperation,
  onInstall,
  onRelaunch,
}: {
  status: DesktopUpdateStatus | null
  pending: boolean
  error: string | null
  daemonOperation: DaemonUpdateOperation | null
  onInstall: (version: string) => void
  onRelaunch: () => void
}) {
  const target = status?.latestVersion
  const busy =
    pending ||
    status?.phase === "checking" ||
    status?.phase === "downloading" ||
    status?.phase === "installing"
  const canInstall =
    target !== null &&
    target !== undefined &&
    (status?.phase === "available" || status?.phase === "failed")
  const progress =
    status?.totalBytes && status.totalBytes > 0
      ? Math.min(100, (status.downloadedBytes / status.totalBytes) * 100)
      : null
  return (
    <section aria-label="Wisp Desktop update" className="pb-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[12.5px] font-medium">Wisp Desktop</h3>
        <VersionLine current={status?.currentVersion} latest={target} />
      </div>
      {(error ?? status?.message) && (
        <p
          className={cn(
            "mt-1 text-[11px] leading-normal",
            error || status?.phase === "failed"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          {error ?? status?.message}
        </p>
      )}
      {status?.releaseNotes && (
        <p className="mt-1 max-h-20 overflow-y-auto text-[11px] leading-normal whitespace-pre-wrap text-muted-foreground">
          {status.releaseNotes}
        </p>
      )}
      {progress !== null && status?.phase === "downloading" && (
        <div
          role="progressbar"
          aria-label="Desktop update download"
          aria-valuenow={Math.round(progress)}
          className="mt-2 h-1 overflow-hidden rounded-full bg-border-strong"
        >
          <div
            className="h-full bg-primary"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
      <DesktopUpdateAction
        status={status}
        pending={pending}
        busy={busy}
        canInstall={canInstall}
        target={target}
        daemonOperation={daemonOperation}
        onInstall={onInstall}
        onRelaunch={onRelaunch}
      />
    </section>
  )
}

function DesktopUpdateAction({
  status,
  pending,
  busy,
  canInstall,
  target,
  daemonOperation,
  onInstall,
  onRelaunch,
}: {
  status: DesktopUpdateStatus | null
  pending: boolean
  busy: boolean
  canInstall: boolean
  target: string | null | undefined
  daemonOperation: DaemonUpdateOperation | null
  onInstall: (version: string) => void
  onRelaunch: () => void
}) {
  if (status?.phase === "ready-to-relaunch") {
    return (
      <div className="mt-2 flex justify-end">
        <Button
          size="sm"
          tone="primary"
          disabled={daemonOperation !== null || pending}
          title={
            daemonOperation
              ? `Wait for ${daemonOperation.connectionName} daemon to recover`
              : "Relaunch Wisp Desktop"
          }
          onClick={onRelaunch}
        >
          Relaunch Desktop
        </Button>
      </div>
    )
  }
  if (canInstall && target) {
    return (
      <div className="mt-2 flex justify-end">
        <Button
          size="sm"
          tone="primary"
          disabled={daemonOperation !== null || busy}
          title={
            daemonOperation
              ? `Wait for ${daemonOperation.connectionName} daemon to recover`
              : `Install Wisp Desktop ${target} and relaunch`
          }
          onClick={() => onInstall(target)}
        >
          {status?.phase === "failed"
            ? "Retry Desktop update"
            : "Update Desktop and relaunch"}
        </Button>
      </div>
    )
  }
  if (!busy) return null
  const label =
    status?.phase === "checking"
      ? "Checking Desktop…"
      : status?.phase === "installing"
        ? "Installing Desktop…"
        : "Downloading Desktop…"
  return (
    <div className="mt-2 flex justify-end">
      <Button size="sm" disabled>
        {label}
      </Button>
    </div>
  )
}

function DaemonUpdateRow({
  status,
  error,
  operation,
  activeOperation,
  connectionName,
  compatible,
  desktopBlocksDaemon,
  supportedApiProtocols,
  onUpdate,
}: {
  status: UpdateStatus | undefined
  error: string | null
  operation: DaemonUpdateOperation | null
  activeOperation: boolean
  connectionName: string
  compatible: boolean
  desktopBlocksDaemon: boolean
  supportedApiProtocols: readonly number[]
  onUpdate: (version: string) => void
}) {
  const target = status?.latestVersion
  const actionBlock = daemonUpdateActionBlock(
    operation !== null,
    desktopBlocksDaemon
  )
  const available =
    target !== null &&
    target !== undefined &&
    status?.canAutoUpdate &&
    compatible &&
    (status.state === "available" || status.state === "failed")
  const blockedMessage =
    target && !compatible
      ? `Wisp ${target} uses daemon API protocol ${status?.latestApiProtocolVersion ?? "unknown"}; this Desktop supports ${supportedApiProtocols.join(", ")}. Update Desktop first for a newer protocol, or update this daemon out of band for an older one.`
      : null
  return (
    <section aria-label={`${connectionName} daemon update`} className="pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="truncate text-[12.5px] font-medium">
          {connectionName} daemon
        </h3>
        <VersionLine current={status?.currentVersion} latest={target} />
      </div>
      {(error ?? blockedMessage ?? status?.message) && (
        <p
          className={cn(
            "mt-1 text-[11px] leading-normal",
            error || blockedMessage || status?.state === "failed"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          {error ?? blockedMessage ?? status?.message}
        </p>
      )}
      <div className="mt-2 flex justify-end">
        {activeOperation ? (
          <Button size="sm" disabled>
            {operation?.phase === "restarting"
              ? `Restarting ${connectionName} daemon…`
              : `Updating ${connectionName} daemon…`}
          </Button>
        ) : available ? (
          <Button
            size="sm"
            tone="outline"
            disabled={actionBlock.disabled}
            title={actionBlock.title}
            onClick={() => onUpdate(target)}
          >
            {status.state === "failed" || error
              ? `Retry ${connectionName} daemon update`
              : `Update ${connectionName} daemon`}
          </Button>
        ) : null}
      </div>
    </section>
  )
}

function daemonUpdateActionBlock(
  daemonBusy: boolean,
  desktopBusy: boolean
): { disabled: boolean; title: string | undefined } {
  if (desktopBusy) {
    return {
      disabled: true,
      title: "Wait for the Wisp Desktop update to finish",
    }
  }
  return { disabled: daemonBusy, title: undefined }
}

function VersionLine({
  current,
  latest,
}: {
  current: string | undefined
  latest: string | null | undefined
}) {
  return (
    <span className="shrink-0 font-mono text-[10.5px] text-faint">
      {current ?? "Checking…"}
      {latest && latest !== current ? ` → ${latest}` : ""}
    </span>
  )
}
