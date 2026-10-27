import type { OutputImage } from "../../../shared/api/outputs"
import { stepsOf } from "@/lib/activity"
import type { ActivityItem } from "@/stream/reducer"

export interface StepImagePlacement {
  /** Images under the timeline step whose id their manifest names. */
  byStep: Map<string, OutputImage[]>
  /** Images with no step, or a step this timeline does not show: they go at its end. */
  unplaced: OutputImage[]
}

/** Where each of a turn's images sits in its expanded timeline. */
export function placeStepImages(items: ActivityItem[], outputs: OutputImage[]): StepImagePlacement {
  const steps = new Set(stepsOf({ items, text: "" }).map((step) => step.id))
  const byStep = new Map<string, OutputImage[]>()
  const unplaced: OutputImage[] = []
  for (const image of outputs) {
    const id = image.step?.id
    if (id === undefined || !steps.has(id)) {
      unplaced.push(image)
      continue
    }
    const group = byStep.get(id)
    if (group) group.push(image)
    else byStep.set(id, [image])
  }
  return { byStep, unplaced }
}

/** The images the agent chose to show the person; the rest it only looked at. */
export function sharedImages(outputs: OutputImage[]): OutputImage[] {
  return outputs.filter((image) => image.source === "published")
}

export function lookedAtLabel(outputs: OutputImage[]): string | null {
  const count = outputs.length - sharedImages(outputs).length
  if (count === 0) return null
  return `looked at ${count} ${count === 1 ? "image" : "images"}`
}
