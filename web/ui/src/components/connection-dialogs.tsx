import { useEffect, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { Button, POPOVER_SURFACE } from "@/components/primitives"
import { RemoteConnectionDialog } from "@/components/remote-connection-dialog"
import {
  type DesktopConnectionMetadata,
  type LocalSetupReport,
} from "@/lib/desktop-bridge"
import { useDesktopConnections } from "@/lib/desktop-connections"
import { connectionLocalData } from "@/lib/drafts"
import {
  CONNECTION_NAME_MAX,
  validateConnectionName,
} from "@/lib/connection-validation"
import { cn } from "@/lib/utils"

export type ConnectionDialogMode =
  | "add"
  | "rename"
  | "edit"
  | "remove"
  | "reset"
  | "local-setup"
  | null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ConnectionDialogs({
  dialog,
  onDialog,
  onError,
}: {
  dialog: ConnectionDialogMode
  onDialog: (mode: ConnectionDialogMode) => void
  onError: (error: string) => void
}) {
  const desktop = useDesktopConnections()!
  const active = desktop.active.metadata
  return (
    <>
      <RemoteConnectionDialog
        open={dialog === "add"}
        onClose={() => onDialog(null)}
      />
      <RenameConnectionDialog
        key={`rename:${active.id}`}
        connection={active}
        open={dialog === "rename"}
        onClose={() => onDialog(null)}
      />
      <ResetDesktopDataDialog
        open={dialog === "reset"}
        onClose={() => onDialog(null)}
      />
      {active.kind === "local" && dialog === "local-setup" && (
        <LocalSetupDialog onClose={() => onDialog(null)} />
      )}
      {active.kind === "remote" && (
        <>
          <RemoteConnectionDialog
            key={`edit:${active.id}`}
            connection={active}
            open={dialog === "edit"}
            onClose={() => onDialog(null)}
          />
          <RemoveConnectionDialog
            key={`remove:${active.id}`}
            connection={active}
            open={dialog === "remove"}
            onClose={() => onDialog(null)}
            onError={onError}
          />
        </>
      )}
    </>
  )
}

function ResetDesktopDataDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const desktop = useDesktopConnections()!
  const [error, setError] = useState<string | null>(null)
  const remoteCount = desktop.connections.filter(
    (connection) => connection.metadata.kind === "remote"
  ).length
  return (
    <DialogFrame open={open} onClose={onClose}>
      <div className="border-b border-border px-4 py-3">
        <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
          Reset Wisp Desktop data?
        </Dialog.Title>
      </div>
      <div className="space-y-2 px-4 py-3.5 text-[12px] leading-relaxed text-fg-secondary">
        <p>
          This removes {remoteCount} remote connection
          {remoteCount === 1 ? "" : "s"}, stored credentials, names, drafts,
          pending attachments, and interface preferences from this app.
        </p>
        <p>
          Local and remote daemons keep running. Their projects, tasks,
          worktrees, and Wisp profiles are not changed.
        </p>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
        <Button size="lg" onClick={onClose}>
          Keep data
        </Button>
        <button
          type="button"
          disabled={desktop.pendingAction !== null}
          onClick={() => {
            setError(null)
            void desktop
              .resetDesktopData()
              .then(onClose, (nativeError: unknown) =>
                setError(errorMessage(nativeError))
              )
          }}
          className={cn(
            "h-8 rounded-md px-3 text-[13px] font-medium text-destructive",
            "hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            "disabled:pointer-events-none disabled:opacity-45"
          )}
        >
          {desktop.pendingAction !== null ? "Resetting…" : "Reset desktop data"}
        </button>
      </div>
    </DialogFrame>
  )
}

function LocalSetupDialog({ onClose }: { onClose: () => void }) {
  const desktop = useDesktopConnections()!
  const [report, setReport] = useState<LocalSetupReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const diagnose = desktop.setupLocalWisp
  useEffect(() => {
    let live = true
    void diagnose().then(
      (next) => live && setReport(next),
      (nativeError: unknown) => live && setError(errorMessage(nativeError))
    )
    return () => {
      live = false
    }
  }, [diagnose])

  const apply = () => {
    setError(null)
    void desktop
      .applyLocalWispSetup(report!.nextStep)
      .then(setReport, (nativeError: unknown) =>
        setError(errorMessage(nativeError))
      )
  }
  const action = report?.nextStep
  const canApply = action === "run-init" || action === "start-daemon"
  const actionLabel =
    action === "run-init" ? "Initialize and start Wisp" : "Start local Wisp"

  return (
    <DialogFrame open onClose={onClose}>
      <div className="border-b border-border px-4 py-3">
        <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
          Local Wisp
        </Dialog.Title>
      </div>
      <div className="space-y-3 px-4 py-3.5 text-[12px] leading-relaxed text-fg-secondary">
        {!report && !error && <p>Checking this Mac…</p>}
        {report && <p>{report.message}</p>}
        {action === "run-init" && (
          <p>
            With your confirmation, Wisp Desktop will create the standard local
            profile with <code>wisp init</code>, then start the Homebrew
            service.
          </p>
        )}
        {action === "start-daemon" && (
          <p>
            With your confirmation, Wisp Desktop will start the existing Wisp
            Homebrew service. It will not replace or reinitialize your profile.
          </p>
        )}
        {action === "install-cli" && (
          <p>
            The desktop Cask normally installs Wisp automatically. Repair it
            with
            <code className="ml-1 text-foreground select-all">
              brew install Pepewitch/tap/wisp
            </code>
            , then diagnose again.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
        <Button size="lg" onClick={onClose}>
          {action === "ready" ? "Done" : "Close"}
        </Button>
        {canApply && (
          <Button
            size="lg"
            tone="primary"
            disabled={desktop.pendingAction !== null}
            onClick={apply}
          >
            {desktop.pendingAction !== null ? "Setting up…" : actionLabel}
          </Button>
        )}
      </div>
    </DialogFrame>
  )
}

function DialogFrame({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-black/60" />
        <Dialog.Popup
          className={cn(
            "fixed top-[18vh] left-1/2 z-(--z-modal) w-[min(480px,calc(100vw-2rem))] -translate-x-1/2",
            POPOVER_SURFACE,
            "rounded-xl shadow-modal outline-none"
          )}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: React.ReactNode
  hint?: string
}) {
  return (
    <label className="flex flex-col gap-1.5 text-[11.5px] font-medium text-fg-secondary">
      {label}
      {children}
      {hint && (
        <span className="leading-relaxed font-normal text-faint">{hint}</span>
      )}
    </label>
  )
}

const INPUT = cn(
  "h-8 rounded-md border border-input bg-surface px-2.5 text-[12.5px] font-normal text-foreground",
  "placeholder:text-faint focus:border-accent-dim focus:ring-2 focus:ring-ring/15 focus:outline-none"
)

function RenameConnectionDialog({
  connection,
  open,
  onClose,
}: {
  connection: DesktopConnectionMetadata
  open: boolean
  onClose: () => void
}) {
  const desktop = useDesktopConnections()!
  const [name, setName] = useState(connection.name)
  const [error, setError] = useState<string | null>(null)
  const cleaned = name.trim()
  const validation = validateConnectionName(
    name,
    desktop.connections,
    connection.id
  )
  return (
    <DialogFrame open={open} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (validation || cleaned === connection.name) return
          void desktop
            .rename(connection.id, cleaned)
            .then(onClose, (nativeError: unknown) =>
              setError(errorMessage(nativeError))
            )
        }}
      >
        <div className="border-b border-border px-4 py-3">
          <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
            Rename connection
          </Dialog.Title>
        </div>
        <div className="px-4 py-3.5">
          <Field label="Connection name">
            <input
              autoFocus
              aria-label="Connection name"
              value={name}
              maxLength={CONNECTION_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              className={INPUT}
            />
          </Field>
        </div>
        {(error || validation) && (
          <p role="alert" className="px-4 pb-2 text-[11.5px] text-destructive">
            {error ?? validation}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
          <Button size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="lg"
            tone="primary"
            disabled={
              Boolean(validation) ||
              cleaned === connection.name ||
              desktop.pendingAction !== null
            }
          >
            {desktop.pendingAction !== null ? "Renaming…" : "Rename"}
          </Button>
        </div>
      </form>
    </DialogFrame>
  )
}

function RemoveConnectionDialog({
  connection,
  open,
  onClose,
  onError,
}: {
  connection: DesktopConnectionMetadata
  open: boolean
  onClose: () => void
  onError: (error: string) => void
}) {
  const desktop = useDesktopConnections()!
  const [confirmedDataLoss, setConfirmedDataLoss] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setConfirmedDataLoss(false)
    }
  }
  const localData = connectionLocalData(connection.id)
  const hasLocalData = localData.drafts > 0 || localData.pendingAttachments > 0
  const remove = () => {
    if (hasLocalData && !confirmedDataLoss) {
      setConfirmedDataLoss(true)
      return
    }
    void desktop
      .remove(connection.id)
      .then(onClose, (nativeError: unknown) => {
        onClose()
        onError(errorMessage(nativeError))
      })
  }
  return (
    <DialogFrame open={open} onClose={onClose}>
      <div className="border-b border-border px-4 py-3">
        <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
          Remove {connection.name}?
        </Dialog.Title>
      </div>
      <div className="space-y-2 px-4 py-3.5 text-[12px] leading-relaxed text-fg-secondary">
        <p>
          Tasks and data on the daemon keep running. This removes only Wisp
          Desktop’s local connection state and stored credential.
        </p>
        {hasLocalData && (
          <p
            className={
              confirmedDataLoss ? "text-destructive" : "text-foreground"
            }
          >
            This also discards{" "}
            {localData.drafts > 0
              ? `${localData.drafts} unsent draft${localData.drafts === 1 ? "" : "s"}`
              : ""}
            {localData.drafts > 0 && localData.pendingAttachments > 0
              ? " and "
              : ""}
            {localData.pendingAttachments > 0
              ? `${localData.pendingAttachments} pending attachment${localData.pendingAttachments === 1 ? "" : "s"}`
              : ""}{" "}
            on this computer.
            {confirmedDataLoss
              ? " Confirm removal once more to discard them."
              : ""}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
        <Button size="lg" onClick={onClose}>
          Keep connection
        </Button>
        <button
          type="button"
          disabled={desktop.pendingAction !== null}
          onClick={remove}
          className={cn(
            "h-8 rounded-md px-3 text-[13px] font-medium text-destructive",
            "hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            "disabled:pointer-events-none disabled:opacity-45"
          )}
        >
          {desktop.pendingAction !== null
            ? "Removing…"
            : hasLocalData && !confirmedDataLoss
              ? "Review local data"
              : hasLocalData
                ? "Discard data and remove"
                : "Remove connection"}
        </button>
      </div>
    </DialogFrame>
  )
}

export function ConnectionErrorDialog({
  error,
  onClose,
}: {
  error: string | null
  onClose: () => void
}) {
  return (
    <DialogFrame open={error !== null} onClose={onClose}>
      <div className="p-5">
        <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
          Connection action failed
        </Dialog.Title>
        <p
          role="alert"
          className="mt-2 text-[12px] leading-relaxed text-fg-secondary"
        >
          {error}
        </p>
        <div className="mt-4 flex justify-end">
          <Button size="lg" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </DialogFrame>
  )
}
