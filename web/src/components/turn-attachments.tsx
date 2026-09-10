import { useState } from "react"

import { AttachmentViewer } from "@/components/attachment-viewer"
import { useAssetSrc } from "@/lib/asset-src"
import { attachmentKind, attachmentUrl, formatBytes } from "@/lib/attachments"
import type { TurnAttachment } from "@/lib/types"

/**
 * One thumbnail. Its own component because resolving a protected asset is a
 * hook (`useAssetSrc`), and the gallery renders these in a list.
 */
function AttachmentThumb({ path, name }: { path: string; name: string }) {
  const src = useAssetSrc(path)
  return (
    <img
      src={src ?? undefined}
      alt={name}
      loading="lazy"
      className="size-14 rounded-sm object-cover"
    />
  )
}

/**
 * A pdf or a text file, as the one thing it can honestly be here: a download.
 * The daemon serves these with `content-disposition: attachment`, so rendering
 * one inline would be the app disagreeing with its own server about whether
 * someone's pasted file may draw on this origin.
 *
 * The href is a blob URL the transport already fetched with its credential, so
 * this is a save, not a second authenticated request. While it resolves the row
 * is plain text rather than a dead link.
 */
function AttachmentFileRow({
  path,
  attachment,
}: {
  path: string
  attachment: TurnAttachment
}) {
  const src = useAssetSrc(path)
  const label = `${attachment.name} · ${attachmentKind(attachment.mediaType)} · ${formatBytes(attachment.size)}`
  if (!src) return <span className="max-w-[76%] truncate text-[11.5px] text-faint">{label}</span>
  return (
    <a
      href={src}
      download={attachment.name}
      title={`Download ${attachment.name}`}
      className="max-w-[76%] truncate text-[11.5px] text-muted-foreground hover:text-foreground"
    >
      {label}
    </a>
  )
}

/**
 * A past turn's attachments, under its prompt bubble (A1a). Right-aligned with
 * the bubble, because these were part of what the person sent.
 *
 * Images are thumbnails: content, not status, so they render as bare images —
 * no chip, no frame, no count badge. Clicking one opens the presentation view,
 * which a video shares. A pdf or a text file has no picture to draw, so it is
 * one muted row that says its kind and downloads on click.
 *
 * The archived case is the honest half. Archive deletes the bytes (Q4) but the
 * manifest survives on the turn row, so this component knows a file was here
 * and can say it is gone, in the register the removed-worktree placeholders use.
 * Rendering a thumbnail that 410s, or rendering nothing at all, are both the
 * quiet lie the manifest exists to prevent.
 */
export function AttachmentGallery({
  attachments,
  archived,
  pathFor,
  testId,
  removedReason,
}: {
  attachments: TurnAttachment[]
  archived: boolean
  /** The daemon API path for one attachment; the transport supplies the credential. */
  pathFor: (name: string) => string
  testId?: string
  removedReason?: string
}) {
  // the open file lives here rather than inside the viewer, so clicking a
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

  const kindOf = (a: TurnAttachment) => attachmentKind(a.mediaType)
  const images = attachments.filter((a) => kindOf(a) === "image")
  // what the viewer steps through, in the turn's own order
  const viewable = attachments.filter((a) => kindOf(a) === "image" || kindOf(a) === "video")
  const rows = attachments.filter((a) => kindOf(a) !== "image")

  return (
    <>
      <div data-testid={testId} className="mt-1.5 flex flex-col items-end gap-1.5">
        {images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map((a) => (
              <button
                key={a.name}
                type="button"
                title={`${a.name} · ${formatBytes(a.size)}`}
                aria-label={`View ${a.name}`}
                className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setOpenIndex(viewable.indexOf(a))}
              >
                <AttachmentThumb path={pathFor(a.name)} name={a.name} />
              </button>
            ))}
          </div>
        )}
        {rows.map((a) =>
          kindOf(a) === "video" ? (
            <button
              key={a.name}
              type="button"
              aria-label={`View ${a.name}`}
              title={`${a.name} · ${formatBytes(a.size)}`}
              className="max-w-[76%] cursor-pointer truncate text-[11.5px] text-muted-foreground hover:text-foreground"
              onClick={() => setOpenIndex(viewable.indexOf(a))}
            >
              {a.name} · video · {formatBytes(a.size)}
            </button>
          ) : (
            <AttachmentFileRow key={a.name} path={pathFor(a.name)} attachment={a} />
          ),
        )}
      </div>
      <AttachmentViewer
        files={viewable}
        index={openIndex}
        onIndex={setOpenIndex}
        onClose={() => setOpenIndex(null)}
        pathFor={pathFor}
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
      pathFor={(name) => attachmentUrl(taskId, turn, name)}
      testId="turn-attachments"
    />
  )
}
