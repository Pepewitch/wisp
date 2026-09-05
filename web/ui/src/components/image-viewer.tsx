import { Dialog } from "@base-ui/react/dialog"
import { useEffect } from "react"

import { formatBytes } from "@/lib/attachments"
import type { TurnAttachment } from "@/lib/types"

/**
 * The presentation view for a turn's images (A1a / Q2): a centred popup at
 * roughly 80vw/80vh, NOT fullscreen — the owner asked to see the image large
 * without leaving the task, and the surrounding app staying visible is what
 * makes it a look rather than a mode.
 *
 * Escape and backdrop dismiss come from the primitive, on the same
 * `z-(--z-backdrop)` / `z-(--z-modal)` pair the create-task and
 * project-settings dialogs already use — a third instance of a settled pattern,
 * not a new one. Left and right step through the rest of the turn's images.
 * Filename and size are one muted caption line: no chip, no badge.
 *
 * Fully controlled. `index` lives with whoever opened it, so the clicked image
 * is the one that shows without this component syncing state in an effect.
 */
export function ImageViewer({
  images,
  index,
  onIndex,
  onClose,
  urlFor,
}: {
  images: TurnAttachment[]
  /** which image is showing; null = closed */
  index: number | null
  onIndex: (next: number) => void
  onClose: () => void
  urlFor: (name: string) => string
}) {
  const open = index !== null && index >= 0 && index < images.length

  useEffect(() => {
    if (!open || images.length < 2) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
      e.preventDefault()
      onIndex((index! + (e.key === "ArrowRight" ? 1 : images.length - 1)) % images.length)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, index, images.length, onIndex])

  const current = open ? images[index!]! : null

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-black/70" />
        <Dialog.Popup
          data-testid="image-viewer"
          className="fixed top-1/2 left-1/2 z-(--z-modal) flex max-h-[80vh] w-[80vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-2 outline-none"
        >
          {current && (
            <>
              <Dialog.Title className="sr-only">{current.name}</Dialog.Title>
              <img
                src={urlFor(current.name)}
                alt={current.name}
                className="max-h-[calc(80vh-2rem)] w-full rounded-md object-contain"
              />
              <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                <span className="truncate font-mono">{current.name}</span>
                <span className="shrink-0 text-faint">·</span>
                <span className="shrink-0">{formatBytes(current.size)}</span>
                {images.length > 1 && (
                  <span className="ml-auto shrink-0 text-faint">
                    {index! + 1} of {images.length}
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
