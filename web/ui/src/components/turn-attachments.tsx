import { useState } from "react"

import { ImageViewer } from "@/components/image-viewer"
import { attachmentUrl, formatBytes } from "@/lib/attachments"
import type { TurnAttachment } from "@/lib/types"

/**
 * A past turn's images, under its prompt bubble (A1a). Right-aligned with the
 * bubble, because these were part of what the person sent.
 *
 * The thumbnails are content, not status, so they render as bare images — no
 * chip, no frame, no count badge. Clicking one opens the presentation view.
 *
 * The archived case is the honest half. Archive deletes the bytes (Q4) but the
 * manifest survives on the turn row, so this component knows an image was here
 * and can say it is gone, in the register the removed-worktree placeholders use.
 * Rendering a thumbnail that 410s, or rendering nothing at all, are both the
 * quiet lie the manifest exists to prevent.
 */
export function AttachmentGallery({
  attachments,
  archived,
  urlFor,
  testId,
  removedReason,
}: {
  attachments: TurnAttachment[]
  archived: boolean
  urlFor: (name: string) => string
  testId?: string
  removedReason?: string
}) {
  // the open image lives here rather than inside the viewer, so clicking a
  // thumbnail sets it once instead of the viewer syncing to a prop
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  if (attachments.length === 0) return null

  if (archived || removedReason) {
    const names = attachments.map((a) => a.name).join(", ")
    return (
      <div data-testid={testId ? `${testId}-removed` : undefined} className="mt-1.5 flex justify-end">
        <span className="max-w-[76%] truncate text-[11.5px] text-faint">
          {names} — {archived ? "removed when this task was archived" : removedReason}
        </span>
      </div>
    )
  }

  return (
    <>
      <div data-testid={testId} className="mt-1.5 flex flex-wrap justify-end gap-1.5">
        {attachments.map((a, i) => (
          <button
            key={a.name}
            type="button"
            title={`${a.name} · ${formatBytes(a.size)}`}
            aria-label={`View ${a.name}`}
            className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setOpenIndex(i)}
          >
            <img
              src={urlFor(a.name)}
              alt={a.name}
              loading="lazy"
              className="size-14 rounded-sm object-cover"
            />
          </button>
        ))}
      </div>
      <ImageViewer
        images={attachments}
        index={openIndex}
        onIndex={setOpenIndex}
        onClose={() => setOpenIndex(null)}
        urlFor={urlFor}
      />
    </>
  )
}

export function TurnAttachments({
  taskId,
  turn,
  attachments,
  archived,
}: {
  taskId: string
  turn: number
  attachments: TurnAttachment[]
  archived: boolean
}) {
  return (
    <AttachmentGallery
      attachments={attachments}
      archived={archived}
      urlFor={(name) => attachmentUrl(taskId, turn, name)}
      testId="turn-attachments"
    />
  )
}
