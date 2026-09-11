import { useState } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { Button } from "@/components/primitives"
import { cn } from "@/lib/utils"

/**
 * Register a project by typing the path the DAEMON will resolve.
 *
 * Two callers, one dialog. A remote desktop tab has always used it; the
 * browser now does too, because a browser cannot produce an absolute path
 * (showDirectoryPicker() hands back a folder NAME with no parent) and the
 * alternative was a disabled button that sent someone to a terminal — on a
 * phone, the surface where a terminal costs the most. `hint` carries the one
 * sentence that differs: whose filesystem this path is on.
 */
export function AddProjectDialog({
  open,
  connectionName,
  hint = "This path is resolved by the remote daemon, not on this computer.",
  pending,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean
  /** named in the field's label, so it is also the accessible name */
  connectionName: string
  hint?: string
  pending: boolean
  error: unknown
  onClose: () => void
  onSubmit: (path: string) => Promise<void>
}) {
  const [path, setPath] = useState("")
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) setPath("")
  }
  const cleaned = path.trim()
  const validation = cleaned && !cleaned.startsWith("/")
    ? "Enter an absolute path beginning with /"
    : null
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup
          className={cn(
            "fixed top-[20vh] left-1/2 z-(--z-modal) w-[min(500px,calc(100vw-2rem))] -translate-x-1/2",
            "rounded-xl border border-border-strong bg-popover shadow-modal outline-none"
          )}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (cleaned && !validation && !pending) void onSubmit(cleaned)
            }}
          >
            <div className="border-b border-border px-4 py-3">
              <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
                Add project
              </Dialog.Title>
            </div>
            <div className="px-4 py-3.5">
              <label className="flex flex-col gap-1.5 text-[11.5px] font-medium text-fg-secondary">
                Absolute path on {connectionName}
                <input
                  autoFocus
                  aria-label={`Absolute path on ${connectionName}`}
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="/srv/projects/example"
                  spellCheck={false}
                  className={cn(
                    "h-8 rounded-md border border-input bg-surface px-2.5 font-mono text-[11.5px] font-normal text-foreground",
                    "placeholder:text-faint focus:border-accent-dim focus:ring-2 focus:ring-ring/15 focus:outline-none"
                  )}
                />
                <span className="leading-relaxed font-normal text-faint">
                  {hint}
                </span>
              </label>
            </div>
            {Boolean(validation ?? error) && (
              <p
                role="alert"
                className="px-4 pb-2 text-[11.5px] text-destructive"
              >
                {validation ??
                  (error instanceof Error ? error.message : String(error))}
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
                disabled={!cleaned || Boolean(validation) || pending}
              >
                {pending ? "Adding…" : "Add project"}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function ProjectPickerErrorDialog({
  error,
  onClose,
}: {
  error: string | null
  onClose: () => void
}) {
  return (
    <Dialog.Root
      open={error !== null}
      onOpenChange={(next) => !next && onClose()}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup
          className={cn(
            "fixed top-[24vh] left-1/2 z-(--z-modal) w-[min(460px,calc(100vw-2rem))] -translate-x-1/2",
            "rounded-xl border border-border-strong bg-popover p-5 shadow-modal outline-none"
          )}
        >
          <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
            Could not add project
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
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
