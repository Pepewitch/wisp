import { Dialog } from "@base-ui/react/dialog"
import { useEffect } from "react"

import { useAssetSrc } from "@/lib/asset-src"
import { attachmentKind, formatBytes } from "@/lib/attachments"
import type { TurnAttachment } from "@/lib/types"

/**
 * The presentation view for a turn's images and videos (A1a / Q2 / A1d): a
 * centred popup at roughly 80vw/80vh, NOT fullscreen — the owner asked to see
 * the image large without leaving the task, and the surrounding app staying
 * visible is what makes it a look rather than a mode.
 *
 * Escape and backdrop dismiss come from the primitive, on the same
 * `z-(--z-backdrop)` / `z-(--z-modal)` pair the create-task and
 * project-settings dialogs already use — a third instance of a settled pattern,
 * not a new one. Left and right step through the rest of the turn's media.
 * Filename and size are one muted caption line: no chip, no badge.
 *
 * Only the kinds with something to SHOW come here. A pdf or a text file is a
 * download in the row it sits in — an app that renders a person's pasted file
 * inline on the daemon's own origin would be doing something the daemon's
 * `content-disposition: attachment` deliberately refuses.
 *
 * Fully controlled. `index` lives with whoever opened it, so the clicked file
 * is the one that shows without this component syncing state in an effect.
 */
export function AttachmentViewer({
  files,
  index,
  onIndex,
  onClose,
  pathFor,
}: {
  files: TurnAttachment[]
  /** which file is showing; null = closed */
  index: number | null
  onIndex: (next: number) => void
  onClose: () => void
  /** The daemon API path for one attachment; the transport supplies the credential. */
  pathFor: (name: string) => string
}) {
  const open = index !== null && index >= 0 && index < files.length

  useEffect(() => {
    if (!open || files.length < 2) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
      e.preventDefault()
      onIndex((index! + (e.key === "ArrowRight" ? 1 : files.length - 1)) % files.length)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, index, files.length, onIndex])

  const current = open ? files[index!]! : null
  const src = useAssetSrc(current ? pathFor(current.name) : null)

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup
          data-testid="attachment-viewer"
          className="fixed top-1/2 left-1/2 z-(--z-modal) flex max-h-[80vh] w-[80vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-2 outline-none"
        >
          {current && (
            <>
              <Dialog.Title className="sr-only">{current.name}</Dialog.Title>
              {attachmentKind(current.mediaType) === "video" ? (
                <video
                  src={src ?? undefined}
                  controls
                  data-testid="attachment-video"
                  className="max-h-[calc(80vh-2rem)] w-full rounded-md bg-black object-contain"
                />
              ) : (
                <img
                  src={src ?? undefined}
                  alt={current.name}
                  className="max-h-[calc(80vh-2rem)] w-full rounded-md object-contain"
                />
              )}
              <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                <span className="truncate font-mono">{current.name}</span>
                <span className="shrink-0 text-faint">·</span>
                <span className="shrink-0">{formatBytes(current.size)}</span>
                {files.length > 1 && (
                  <span className="ml-auto shrink-0 text-faint">
                    {index! + 1} of {files.length}
                  </span>
                )}
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
