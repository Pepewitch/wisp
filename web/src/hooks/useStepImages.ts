import { useMemo, useState } from "react"

import type { StepImageSet } from "@/components/activity-list"
import { placeStepImages, samePlacement, type StepImagePlacement } from "@/lib/turn-images"
import type { ActivityItem } from "@/stream/reducer"
import type { OutputImage } from "../../../shared/api/outputs"

/**
 * Where a turn's images sit in its timeline, as data the memoized activity
 * rows can compare. The live turn's items change every frame, but where its
 * images go almost never does: an unchanged placement keeps its identity, so
 * no row or thumbnail redraws for it.
 */
export function useStepImages({ taskId, turn, removed, items, outputs }: {
  taskId: string
  turn: number
  removed: boolean
  items: ActivityItem[]
  outputs: OutputImage[]
}): { placement: StepImagePlacement; stepImages: StepImageSet } {
  const fresh = useMemo(() => placeStepImages(items, outputs), [items, outputs])
  const [held, setHeld] = useState(fresh)
  let placement = held
  if (held !== fresh && !samePlacement(held, fresh)) {
    setHeld(fresh)
    placement = fresh
  }
  const byStep = placement.byStep
  const stepImages = useMemo(() => ({ taskId, turn, removed, byStep }), [taskId, turn, removed, byStep])
  return { placement, stepImages }
}
