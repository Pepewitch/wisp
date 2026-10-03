import { useState } from "react"
import { outputImageUrl, type OutputImage } from "../../../shared/api/outputs"
import { AttachmentViewer } from "@/components/attachment-viewer"
import { useAssetStatus } from "@/lib/asset-src"
import { formatBytes } from "@/lib/attachments"
import { saveOutputImage } from "@/lib/output-download"

function OutputCard({ taskId, turn, image, removed }: { taskId: string; turn: number; image: OutputImage; removed: boolean }) {
  const path = outputImageUrl(taskId, turn, image.id)
  const { src, failed } = useAssetStatus(removed ? null : path)
  return <OutputImagePreview image={image} src={src} unavailable={failed} removed={removed} />
}

export function OutputImagePreview({ image, src, unavailable = false, removed = false }: { image: OutputImage; src: string | null; unavailable?: boolean; removed?: boolean }) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const missing = unavailable || failed
  return (
    <figure className="my-3 max-w-[400px]" data-testid="output-image">
      {removed ? <p className="text-[11.5px] text-faint">{image.name} · removed when this task was archived</p> : (
        <>
          <button type="button" onClick={() => setOpen(true)} disabled={!src || missing} aria-label={`Expand ${image.name}`} className="block w-full cursor-zoom-in rounded-md focus-visible:outline focus-visible:outline-ring disabled:cursor-default">
            <img src={src ?? undefined} alt={image.name} loading="lazy" onLoad={() => setFailed(false)} onError={() => setFailed(true)} className="max-h-[320px] w-full rounded-md object-contain object-left" />
          </button>
          <figcaption className="mt-1 flex items-center gap-2 text-[11.5px] text-muted-foreground">
            <span className="truncate">{image.name}</span><span>·</span><span className="shrink-0">{formatBytes(image.size)}</span>
            {src && !missing && <button type="button" disabled={saving} onClick={async () => {
              setSaving(true); setSaveError(null)
              try { await saveOutputImage(image.name, src) }
              catch (error) { setSaveError(error instanceof Error ? error.message : typeof error === "string" ? error : "Could not save image.") }
              finally { setSaving(false) }
            }} className="ml-auto cursor-pointer hover:text-foreground disabled:cursor-wait">{saving ? "Saving…" : "Download"}</button>}
            {missing && <span>Image unavailable</span>}
          </figcaption>
          {saveError && <p role="alert" className="mt-1 text-[11.5px] text-destructive">{saveError}</p>}
          <AttachmentViewer files={[image]} index={open ? 0 : null} onIndex={() => {}} onClose={() => setOpen(false)} localSrcFor={() => src ?? ""} />
        </>
      )}
    </figure>
  )
}

/** Output bytes are independent of the transcript and use the active connection's asset transport. */
export function TurnOutputs({ taskId, turn, outputs, removed = false }: { taskId: string; turn: number; outputs: OutputImage[]; removed?: boolean }) {
  return outputs.length ? <div aria-label="Agent output images">{outputs.map((image) => <OutputCard key={image.id} taskId={taskId} turn={turn} image={image} removed={removed} />)}</div> : null
}
