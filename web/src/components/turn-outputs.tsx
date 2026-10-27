import { useState } from "react"
import { outputImageUrl, type OutputImage } from "../../../shared/api/outputs"
import { AttachmentViewer } from "@/components/attachment-viewer"
import { useAssetStatus } from "@/lib/asset-src"
import { formatBytes } from "@/lib/attachments"
import { saveOutputImage } from "@/lib/output-download"
import { cn } from "@/lib/utils"

function OutputCard({ taskId, turn, image, removed, compact = false, caption }: { taskId: string; turn: number; image: OutputImage; removed: boolean; compact?: boolean; caption?: string }) {
  const path = outputImageUrl(taskId, turn, image.id)
  const { src, failed } = useAssetStatus(removed ? null : path)
  return <OutputImagePreview image={image} src={src} unavailable={failed} removed={removed} compact={compact} caption={caption} />
}

/**
 * `compact` is the thumbnail an image gets under the step that produced it;
 * `caption` names where a shared image came from.
 */
export function OutputImagePreview({ image, src, unavailable = false, removed = false, compact = false, caption }: { image: OutputImage; src: string | null; unavailable?: boolean; removed?: boolean; compact?: boolean; caption?: string }) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const missing = unavailable || failed
  return (
    <figure className={compact ? "my-1 w-[220px] max-w-full" : "my-3 max-w-[400px]"} data-testid="output-image">
      {removed ? <p className="text-[11.5px] text-faint">{image.name} · removed when this task was archived</p> : (
        <>
          <button type="button" onClick={() => setOpen(true)} disabled={!src || missing} aria-label={`Expand ${image.name}`} className="block w-full cursor-zoom-in rounded-md focus-visible:outline focus-visible:outline-ring disabled:cursor-default">
            <img src={src ?? undefined} alt={image.name} loading="lazy" onLoad={() => setFailed(false)} onError={() => setFailed(true)} className={cn("w-full rounded-md object-contain object-left", compact ? "max-h-[140px]" : "max-h-[320px]")} />
          </button>
          <figcaption className={cn("mt-1 flex items-center gap-2 text-muted-foreground", compact ? "text-[11px]" : "text-[11.5px]")}>
            <span className="truncate">{image.name}</span>
            {!compact && <><span>·</span><span className="shrink-0">{formatBytes(image.size)}</span></>}
            {src && !missing && <button type="button" disabled={saving} onClick={async () => {
              setSaving(true); setSaveError(null)
              try { await saveOutputImage(image.name, src) }
              catch (error) { setSaveError(error instanceof Error ? error.message : typeof error === "string" ? error : "Could not save image.") }
              finally { setSaving(false) }
            }} className="ml-auto shrink-0 cursor-pointer hover:text-foreground disabled:cursor-wait">{saving ? "Saving…" : "Download"}</button>}
            {missing && <span className="shrink-0">Image unavailable</span>}
          </figcaption>
          {caption && <p data-output-step className="mt-0.5 truncate text-[11px] text-faint" title={caption}>from: {caption}</p>}
          {saveError && <p role="alert" className="mt-1 text-[11.5px] text-destructive">{saveError}</p>}
          <AttachmentViewer files={[image]} index={open ? 0 : null} onIndex={() => {}} onClose={() => setOpen(false)} localSrcFor={() => src ?? ""} />
        </>
      )}
    </figure>
  )
}

/**
 * The images the agent shared, after its reply, each captioned with the step
 * that shared it. Output bytes are independent of the transcript and use the
 * active connection's asset transport.
 */
export function TurnOutputs({ taskId, turn, outputs, removed = false }: { taskId: string; turn: number; outputs: OutputImage[]; removed?: boolean }) {
  return outputs.length ? <div aria-label="Agent output images">{outputs.map((image) => <OutputCard key={image.id} taskId={taskId} turn={turn} image={image} removed={removed} caption={image.step?.label} />)}</div> : null
}

/** Thumbnails under the timeline step that produced them, or at the timeline's end. */
export function StepImages({ taskId, turn, images, removed = false, step = null }: { taskId: string; turn: number; images: OutputImage[]; removed?: boolean; step?: string | null }) {
  return images.length ? (
    <div data-step-images={step ?? ""} aria-label={step ? "Images from this step" : "Images from this turn's steps"} className="flex flex-wrap gap-x-3 pl-5">
      {images.map((image) => <OutputCard key={image.id} taskId={taskId} turn={turn} image={image} removed={removed} compact />)}
    </div>
  ) : null
}
