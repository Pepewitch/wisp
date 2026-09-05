import { useRef, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { Button, POPOVER_SURFACE } from "@/components/primitives"
import {
  normalizeRemoteUrl,
  type AddRemoteConnectionInput,
  type DesktopConnectionMetadata,
} from "@/lib/desktop-bridge"
import { useDesktopConnections } from "@/lib/desktop-connections"
import {
  CONNECTION_NAME_MAX,
  validateConnectionName,
} from "@/lib/connection-validation"
import { cn } from "@/lib/utils"

export type ConnectionDialogMode = "add" | "rename" | "edit" | "remove" | null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ConnectionDialogs({
  dialog,
  onDialog,
}: {
  dialog: ConnectionDialogMode
  onDialog: (mode: ConnectionDialogMode) => void
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
          />
        </>
      )}
    </>
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

function RemoteConnectionDialog({
  connection,
  open,
  onClose,
}: {
  connection?: DesktopConnectionMetadata
  open: boolean
  onClose: () => void
}) {
  const desktop = useDesktopConnections()!
  const editing = connection?.kind === "remote"
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const tokenRef = useRef<HTMLInputElement>(null)

  const [seed, setSeed] = useState(open)
  if (seed !== open) {
    setSeed(open)
    if (open) {
      setName(editing ? connection.name : "")
      setUrl(editing ? (connection.url ?? "") : "")
      setToken("")
      setError(null)
    }
  }

  const submit = async () => {
    const nameError = editing
      ? null
      : validateConnectionName(name, desktop.connections)
    if (nameError) {
      setError(nameError)
      return
    }
    let normalizedUrl: string
    try {
      normalizedUrl = normalizeRemoteUrl(url)
    } catch (validationError) {
      setError(errorMessage(validationError))
      return
    }
    if (!editing && !token) {
      setError("Token is required")
      tokenRef.current?.focus()
      return
    }

    const submittedToken = token
    const pending = editing
      ? desktop.reconnect({
          connectionId: connection.id,
          url: normalizedUrl,
          ...(submittedToken ? { token: submittedToken } : {}),
        })
      : desktop.addRemote({
          name: name.trim(),
          url: normalizedUrl,
          token: submittedToken,
        } satisfies AddRemoteConnectionInput)
    // The bridge captured its arguments; do not retain a credential while native work runs.
    setToken("")
    try {
      await pending
      onClose()
    } catch (nativeError) {
      setError(errorMessage(nativeError))
    }
  }

  return (
    <DialogFrame open={open} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="border-b border-border px-4 py-3">
          <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
            {editing ? "Edit remote connection" : "Add remote connection"}
          </Dialog.Title>
        </div>
        <div className="flex flex-col gap-3.5 px-4 py-3.5">
          {!editing && (
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
          )}
          <Field
            label="Daemon URL"
            hint="HTTPS is required, except literal 127.0.0.1 or ::1 HTTP tunnels."
          >
            <input
              aria-label="Daemon URL"
              type="url"
              inputMode="url"
              value={url}
              placeholder="https://wisp.example.net"
              onChange={(event) => setUrl(event.target.value)}
              className={INPUT}
              spellCheck={false}
            />
          </Field>
          <Field
            label={editing ? "New token (optional)" : "Token"}
            hint={
              editing
                ? "Leave blank to keep the credential already stored by Wisp Desktop."
                : "Stored by native credential services, never by this webview."
            }
          >
            <input
              ref={tokenRef}
              aria-label={editing ? "New token (optional)" : "Token"}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className={INPUT}
              spellCheck={false}
            />
          </Field>
        </div>
        {error && (
          <p role="alert" className="px-4 pb-2 text-[11.5px] text-destructive">
            {error}
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
            disabled={desktop.pendingAction !== null}
          >
            {desktop.pendingAction !== null
              ? "Connecting…"
              : editing
                ? "Reconnect"
                : "Add connection"}
          </Button>
        </div>
      </form>
    </DialogFrame>
  )
}

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
}: {
  connection: DesktopConnectionMetadata
  open: boolean
  onClose: () => void
}) {
  const desktop = useDesktopConnections()!
  const [error, setError] = useState<string | null>(null)
  return (
    <DialogFrame open={open} onClose={onClose}>
      <div className="border-b border-border px-4 py-3">
        <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
          Remove {connection.name}?
        </Dialog.Title>
      </div>
      <p className="px-4 py-3.5 text-[12px] leading-relaxed text-fg-secondary">
        Tasks and data on the daemon keep running. This removes only Wisp
        Desktop’s local connection state and stored credential.
      </p>
      {error && (
        <p role="alert" className="px-4 pb-2 text-[11.5px] text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
        <Button size="lg" onClick={onClose}>
          Keep connection
        </Button>
        <button
          type="button"
          disabled={desktop.pendingAction !== null}
          onClick={() =>
            void desktop
              .remove(connection.id)
              .then(onClose, (nativeError: unknown) =>
                setError(errorMessage(nativeError))
              )
          }
          className={cn(
            "h-8 rounded-md px-3 text-[13px] font-medium text-destructive",
            "hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            "disabled:pointer-events-none disabled:opacity-45"
          )}
        >
          {desktop.pendingAction !== null ? "Removing…" : "Remove connection"}
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
