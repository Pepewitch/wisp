import { backgroundNames } from "@/lib/state"
import { steerActionNote, type SteerAction } from "@/lib/steer-delivery"
import type { ApiTask } from "@/lib/types"

export interface ComposerStatus {
  text: string
  /** A send would stop running work: said in the warning tone. */
  warn: boolean
}

/** What a send will and will not do while this task still has live work. */
export function composerStatus(
  task: ApiTask | null,
  action: SteerAction | null,
  compacting = false
): ComposerStatus | null {
  // Recorded compact turns own their status in the transcript; action
  // compactors have one task-keyed note. Neither needs a duplicate here.
  if (compacting) return null
  if (action) return steerActionNote(action)
  if (!task?.background || task.background.state === "none") return null
  const running = backgroundNames(task.background)
  return { text: `background work${running ? ` (${running})` : ""} · send won't stop it`, warn: false }
}
