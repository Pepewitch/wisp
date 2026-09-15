import { backgroundNames } from "@/lib/state"
import type { ApiTask } from "@/lib/types"

/** What a send will and will not do while this task still has live work. */
export function composerStatus(
  task: ApiTask | null,
  blocked: boolean,
  compacting = false
): string | null {
  // Recorded compact turns own their status in the transcript; action
  // compactors have one task-keyed note. Neither needs a duplicate here.
  if (compacting) return null
  if (blocked) return "running · send won't interrupt"
  if (!task?.background || task.background.state === "none") return null
  const running = backgroundNames(task.background)
  return `background work${running ? ` (${running})` : ""} · send won't stop it`
}
