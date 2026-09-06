import { useRef, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { Button, POPOVER_SURFACE } from "@/components/primitives"
import {
  normalizeRemoteUrl,
  type AddRemoteConnectionInput,
  type DesktopConnectionMetadata,
  type RemoteDaemonPreview,
} from "@/lib/desktop-bridge"
import { useDesktopConnections } from "@/lib/desktop-connections"
import { connectionLocalData } from "@/lib/drafts"
import {
  CONNECTION_NAME_MAX,
  validateConnectionName,
} from "@/lib/connection-validation"
import { cn } from "@/lib/utils"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const INPUT = cn(
  "h-8 rounded-md border border-input bg-surface px-2.5 text-[12.5px] font-normal text-foreground",
  "placeholder:text-faint focus:border-accent-dim focus:ring-2 focus:ring-ring/15 focus:outline-none"
)

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

function IdentityPreview({
  preview,
  connection,
}: {
  preview: RemoteDaemonPreview
  connection?: DesktopConnectionMetadata
}) {
  const changed = connection && preview.instanceId !== connection.instanceId
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 text-[11.5px] text-fg-secondary">
      <p className="font-medium text-foreground">
        Reached Wisp {preview.version}
      </p>
      <p>API protocol {preview.apiProtocolVersion}</p>
      {changed && (
        <p className="mt-1 text-destructive">
          This is a different daemon. Review its identity before trusting it.
        </p>
      )}
      {connection && (
        <p className="mt-1 break-all font-mono text-faint">
          Saved: {connection.instanceId}
        </p>
      )}
      <p className="mt-1 break-all font-mono text-faint">
        {connection ? "Reached" : "Identity"}: {preview.instanceId}
      </p>
    </div>
  )
}

function RemoteConnectionFields({
  editing,
  connection,
  name,
  url,
  token,
  preview,
  tokenRef,
  onName,
  onUrl,
  onToken,
}: {
  editing: boolean
  connection?: DesktopConnectionMetadata
  name: string
  url: string
  token: string
  preview: RemoteDaemonPreview | null
  tokenRef: React.RefObject<HTMLInputElement | null>
  onName: (value: string) => void
  onUrl: (value: string) => void
  onToken: (value: string) => void
}) {
  return (
    <div className="flex flex-col gap-3.5 px-4 py-3.5">
      {!editing && (
        <Field label="Connection name">
          <input
            autoFocus
            aria-label="Connection name"
            value={name}
            maxLength={CONNECTION_NAME_MAX}
            onChange={(event) => onName(event.target.value)}
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
          onChange={(event) => onUrl(event.target.value)}
          className={INPUT}
          spellCheck={false}
        />
      </Field>
      <Field
        label={editing ? "New token (optional)" : "Token"}
        hint={
          editing
            ? "Leave blank to keep the credential already stored by Wisp Desktop."
            : "Held only until you confirm the checked daemon, then stored by native credential services."
        }
      >
        <input
          ref={tokenRef}
          aria-label={editing ? "New token (optional)" : "Token"}
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => onToken(event.target.value)}
          className={INPUT}
          spellCheck={false}
        />
      </Field>
      {preview && (
        <IdentityPreview preview={preview} connection={connection} />
      )}
    </div>
  )
}

export function RemoteConnectionDialog({
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
  const [confirmedRetarget, setConfirmedRetarget] = useState(false)
  const [preview, setPreview] = useState<{
    url: string
    identity: RemoteDaemonPreview
  } | null>(null)
  const tokenRef = useRef<HTMLInputElement>(null)

  const [seed, setSeed] = useState(open)
  if (seed !== open) {
    setSeed(open)
    if (open) {
      setName(editing ? connection.name : "")
      setUrl(editing ? (connection.url ?? "") : "")
      setToken("")
      setError(null)
      setConfirmedRetarget(false)
      setPreview(null)
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
    if (preview?.url !== normalizedUrl) {
      setError(null)
      try {
        const identity = editing
          ? await desktop.probeReconnect({
              connectionId: connection.id,
              url: normalizedUrl,
              ...(token ? { token } : {}),
            })
          : await desktop.probeRemote({ url: normalizedUrl, token })
        setPreview({ url: normalizedUrl, identity })
      } catch (nativeError) {
        setError(errorMessage(nativeError))
      }
      return
    }
    const localData = editing ? connectionLocalData(connection.id) : null
    const retargets = editing && normalizedUrl !== connection.url
    if (
      retargets &&
      localData &&
      (localData.drafts > 0 || localData.pendingAttachments > 0) &&
      !confirmedRetarget
    ) {
      setConfirmedRetarget(true)
      setError(
        `Changing the daemon URL will discard ${localData.drafts} unsent draft${localData.drafts === 1 ? "" : "s"} and ${localData.pendingAttachments} pending attachment${localData.pendingAttachments === 1 ? "" : "s"} on this computer. Confirm once more to reconnect.`
      )
      return
    }

    const submittedToken = token
    const pending = editing
      ? desktop.reconnect({
          connectionId: connection.id,
          url: normalizedUrl,
          ...(submittedToken ? { token: submittedToken } : {}),
          expectedInstanceId: preview.identity.instanceId,
        })
      : desktop.addRemote({
          name: name.trim(),
          url: normalizedUrl,
          token: submittedToken,
          expectedInstanceId: preview.identity.instanceId,
        } satisfies AddRemoteConnectionInput)
    // The bridge captured its arguments; do not retain a credential while native work runs.
    setToken("")
    try {
      await pending
      onClose()
    } catch (nativeError) {
      setPreview(null)
      setError(errorMessage(nativeError))
    }
  }

  const actionLabel =
    desktop.pendingAction !== null
      ? "Connecting…"
      : editing
        ? confirmedRetarget
          ? "Reconnect and discard local data"
          : preview
            ? preview.identity.instanceId === connection.instanceId
              ? "Reconnect"
              : "Trust new daemon and reconnect"
            : "Check connection"
        : preview
          ? "Save connection"
          : "Check connection"

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
            <RemoteConnectionFields
              editing={editing}
              connection={editing ? connection : undefined}
              name={name}
              url={url}
              token={token}
              preview={preview?.identity ?? null}
              tokenRef={tokenRef}
              onName={setName}
              onUrl={(next) => {
                setUrl(next)
                setConfirmedRetarget(false)
                setPreview(null)
              }}
              onToken={(next) => {
                setToken(next)
                setPreview(null)
              }}
            />
            {error && (
              <p
                role="alert"
                className="px-4 pb-2 text-[11.5px] text-destructive"
              >
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
                {actionLabel}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
