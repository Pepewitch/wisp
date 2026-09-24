import { useRef, useState } from "react"

import { AttachmentViewer } from "@/components/attachment-viewer"
import { Attach, Dismiss } from "@/components/icons"

import { ATTACHMENT_ACCEPT, formatBytes, type PendingAttachments } from "@/lib/attachments"
import { cn } from "@/lib/utils"

/**
 * The pending-attachment rows under a composer (S3): one quiet muted row per
 * file — `name.png · 12 KB · ✕` — with a small content thumbnail for images.
 * The thumbnail and name open the same preview as a sent image, without
 * submitting or uploading the pending file.
 * No chip, no badge, no tint (design law); the thumbnail is content, not
 * status. A pdf, a text file or a video has no thumbnail worth drawing, so it
 * gets its kind as one muted word instead — the row still has to say what it
 * is, or a `report.pdf` and a `report.mp4` differ only by three characters.
 *
 * The optional note lines carry the harness's delivery caveat (A1c) and the
 * client-side rejection (capability, caps, type) in the same muted register —
 * the daemon's named 400 remains the authority on submit.
 */
export function PendingAttachmentRows({
  pending,
  touch = false,
  onInsertInline,
}: {
  pending: PendingAttachments
  /** A thumb needs a real target to drop an image again, and a bigger thumbnail to recognise it by. */
  touch?: boolean
  /**
   * Put a paste that became a file back in the textarea (A1d). A cutoff that
   * cannot be overridden is a cutoff that will be wrong for someone.
   */
  onInsertInline?: (pasted: NonNullable<PendingAttachments["pastedText"]>) => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const pasted = pending.pastedText
  if (pending.list.length === 0 && !pending.note && !pasted) return null
  const notes = [pending.deliveryNote, pending.note].filter((n): n is string => Boolean(n))
  const images = pending.list.filter((a) => a.kind === "image" && a.url)
  const openIndex = openId === null ? null : images.findIndex((a) => a.id === openId)
  return (
    <div className="mt-1.5 flex flex-col gap-1" data-testid="pending-attachments">
      {pending.list.map((a) => (
        <div key={a.id} data-testid="pending-attachment" className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
          {a.kind === "image" && a.url ? (
            <button
              type="button"
              aria-label={`View ${a.name}`}
              title={`View ${a.name}`}
              className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm text-left hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => setOpenId(a.id)}
            >
              <img
                src={a.url}
                alt=""
                className={cn("shrink-0 rounded-sm object-cover", touch ? "size-8" : "size-6")}
              />
              <span className="truncate font-mono">{a.name}</span>
            </button>
          ) : (
            <span className="truncate font-mono">{a.name}</span>
          )}
          {a.kind !== "image" && (
            <>
              <span className="shrink-0 text-faint">·</span>
              <span className="shrink-0">{a.kind}</span>
            </>
          )}
          <span className="shrink-0 text-faint">·</span>
          <span className="shrink-0">{formatBytes(a.bytes)}</span>
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            className={cn(
              "ml-auto flex shrink-0 cursor-pointer items-center justify-center rounded-md text-faint hover:text-foreground",
              // the negative margin keeps a 40px target from making the row 40px tall
              touch ? "-my-2 size-10 active:bg-hover" : "size-4",
            )}
            onClick={() => pending.remove(a.id)}
          >
            <Dismiss className={touch ? "size-4" : "size-3"} />
          </button>
        </div>
      ))}
      {pasted && (
        <div data-testid="pasted-text-note" className="text-[11.5px] text-faint">
          {`long paste attached as ${pasted.name}`}
          {onInsertInline && (
            <>
              {" · "}
              <button
                type="button"
                className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                onClick={() => onInsertInline(pasted)}
              >
                insert inline instead
              </button>
            </>
          )}
        </div>
      )}
      {notes.map((n) => (
        <div key={n} data-testid="attachment-note" className="text-[11.5px] text-faint">
          {n}
        </div>
      ))}
      <AttachmentViewer
        files={images.map((a) => ({ name: a.name, size: a.bytes, mediaType: a.mediaType }))}
        index={openIndex === -1 ? null : openIndex}
        onIndex={(next) => setOpenId(images[next]?.id ?? null)}
        onClose={() => setOpenId(null)}
        localSrcFor={(index) => images[index]?.url ?? ""}
      />
    </div>
  )
}

/**
 * The paperclip (A1a: "pick images from my folder"). A real `<input type=file>`
 * behind a quiet icon button, because the file dialog is the one piece of chrome
 * only the platform can draw.
 *
 * `accept` mirrors what the daemon's sniffer accepts — it is a hint to the
 * platform, not a check: the picked bytes go through the same read/validate
 * path a paste does, and the daemon re-sniffs regardless.
 *
 * Never disabled since A1d: pdf, text and video reach every harness by path, so
 * there is no harness this button can do nothing for. An image picked for a
 * harness with no image mechanism is refused BY NAME in the note row, which is
 * the honest version of the old disabled tooltip — the other files in the same
 * batch still attach.
 */
export function AttachButton({
  pending,
  touch = false,
  className,
}: {
  pending: PendingAttachments
  touch?: boolean
  className?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        data-testid="attach-input"
        onChange={(e) => {
          pending.addFiles(Array.from(e.target.files ?? []))
          // reset so picking the same file twice in a row still fires onChange
          e.target.value = ""
        }}
      />
      <button
        type="button"
        aria-label="Attach a file"
        title="Attach a file"
        onClick={() => input.current?.click()}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
          "hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground",
          touch ? "size-11 active:bg-hover" : "size-6",
          className,
        )}
      >
        <Attach className={touch ? "size-5" : "size-3.5"} />
      </button>
    </>
  )
}
