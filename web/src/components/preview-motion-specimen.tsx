import { useState } from "react"

import sample from "@/assets/output-sample.png"
import { TextAttachmentRow } from "@/components/attachment-table"
import { TextPreviewPopup } from "@/components/attachment-text-viewer"
import { AttachmentViewer } from "@/components/attachment-viewer"
import { Section } from "@/components/gallery-chrome"
import { Eyebrow } from "@/components/primitives"

/**
 * The gallery's place to feel a preview open: the same image viewer and
 * reading popup the transcript uses, with triggers spread to the corners so
 * the grow-from-the-click (`lib/open-origin.ts`, `.wisp-zoom`) is easy to see.
 */

const IMAGES = ["left.png", "middle.png", "right.png"].map((name) => ({ name, size: 489, mediaType: "image/png" }))

const NOTE = `# Previews grow out of the click

Open this from the left, then from the right: it comes out of the row you
pressed and shrinks back into it. From the keyboard it grows out of the
focused row; with reduced motion it simply appears.
`
const NOTE_FILE = { name: "motion.md", size: new TextEncoder().encode(NOTE).length }

export function PreviewMotionSpecimen() {
  const [image, setImage] = useState<number | null>(null)
  const [reading, setReading] = useState(false)
  return (
    <Section title="Previews grow out of what you clicked">
      <Eyebrow>Images — click one, ← → steps, Escape closes</Eyebrow>
      <div className="mt-2.5 flex items-start justify-between gap-6">
        {IMAGES.map((file, i) => (
          <button
            key={file.name}
            type="button"
            onClick={() => setImage(i)}
            aria-label={`Expand ${file.name}`}
            className="w-[160px] cursor-zoom-in rounded-md focus-visible:outline focus-visible:outline-ring"
          >
            <img src={sample} alt={file.name} className="w-full rounded-md object-contain" />
          </button>
        ))}
      </div>

      <Eyebrow className="mt-8 block">Text — the reading popup Changes and attachments share</Eyebrow>
      <div className="mt-2.5 flex items-center justify-between">
        <TextAttachmentRow attachment={NOTE_FILE} onOpen={() => setReading(true)} />
        <TextAttachmentRow attachment={NOTE_FILE} onOpen={() => setReading(true)} />
      </div>
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
        Quick in, quicker out: 220ms from 40% at the click, 110ms back to 60%. The scrim fades on its own clock.
      </p>

      <AttachmentViewer
        files={IMAGES}
        index={image}
        onIndex={setImage}
        onClose={() => setImage(null)}
        localSrcFor={() => sample}
      />
      <TextPreviewPopup
        attachment={reading ? NOTE_FILE : null}
        data={reading ? { text: NOTE, truncated: false } : undefined}
        pending={false}
        error={null}
        downloadHref={null}
        onClose={() => setReading(false)}
      />
    </Section>
  )
}
