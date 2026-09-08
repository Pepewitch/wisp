import { useRef } from "react"

import { Attach, Dismiss } from "@/components/icons"

import { formatBytes, type PendingAttachments } from "@/lib/attachments"
import { cn } from "@/lib/utils"

/**
 * The pending-attachment rows under a composer (S3): one quiet muted row per
 * image — `name.png · 12 KB · ✕` — with a small content thumbnail. No chip,
 * no badge, no tint (design law); the thumbnail is content, not status. The
 * optional note lines carry the harness's delivery caveat (A1c) and the
 * client-side rejection (capability, caps, type) in the same muted register —
 * the daemon's named 400 remains the authority on submit.
 */
export function PendingAttachmentRows({ pending }: { pending: PendingAttachments }) {
  if (pending.list.length === 0 && !pending.note) return null
  const notes = [pending.deliveryNote, pending.note].filter((n): n is string => Boolean(n))
  return (
    <div className="mt-1.5 flex flex-col gap-1" data-testid="pending-attachments">
      {pending.list.map((a) => (
        <div key={a.id} data-testid="pending-attachment" className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
          {a.url && (
            <img
              src={a.url}
              alt=""
              className="size-6 shrink-0 rounded-sm object-cover"
            />
          )}
          <span className="truncate font-mono">{a.name}</span>
          <span className="shrink-0 text-faint">·</span>
          <span className="shrink-0">{formatBytes(a.bytes)}</span>
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            className="ml-auto shrink-0 cursor-pointer rounded-sm p-0.5 text-faint hover:text-foreground"
            onClick={() => pending.remove(a.id)}
          >
            <Dismiss className="size-3" />
          </button>
        </div>
      ))}
      {notes.map((n) => (
        <div key={n} data-testid="attachment-note" className="text-[11.5px] text-faint">
          {n}
        </div>
      ))}
    </div>
  )
}

/**
 * The paperclip (A1a: "pick images from my folder"). A real `<input type=file>`
 * behind a quiet icon button, because the file dialog is the one piece of chrome
 * only the platform can draw.
 *
 * `accept` mirrors the four formats the daemon's sniffer accepts — it is a hint
 * to the platform, not a check: the picked bytes go through the same
 * read/validate path a paste does, and the daemon re-sniffs regardless.
 *
 * Disabled with its reason in the tooltip when the harness has no image
 * capability. The button must never look available and do nothing, which is
 * exactly what it did before this slice.
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
        accept="image/png,image/jpeg,image/gif,image/webp"
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
        disabled={!pending.enabled}
        aria-label="Attach an image"
        title={pending.disabledReason ?? "Attach an image"}
        onClick={() => input.current?.click()}
        className={cn(
          "flex items-center justify-center rounded-md text-muted-foreground transition-colors",
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
