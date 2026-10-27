import sample from "@/assets/output-sample.png"
import { Section } from "@/components/gallery-chrome"
import { OutputImagePreview } from "@/components/turn-outputs"
import type { OutputImage } from "../../../shared/api/outputs"

const image: OutputImage = { id: "0".repeat(64), name: "sample.png", size: 489, mediaType: "image/png", source: "native" }
const shared: OutputImage = { ...image, source: "published", step: { id: "call-1", label: "wisp output add sample.png --turn 1" } }

export function OutputGallerySpecimen() {
  return (
    <Section title="Agent image outputs">
      <div className="grid grid-cols-2 gap-10">
        <OutputImagePreview image={shared} src={sample} caption={shared.step?.label} />
        <div>
          <OutputImagePreview image={image} src={null} unavailable />
          <OutputImagePreview image={image} src={null} removed />
          <OutputImagePreview image={image} src={sample} compact />
        </div>
      </div>
    </Section>
  )
}
