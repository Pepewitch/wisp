import { backgroundLingers, backgroundNames } from "@/lib/state"
import { steerActionNote, type SteerAction } from "@/lib/steer-delivery"
import type { ApiTask } from "@/lib/types"

export interface ComposerStatus {
  text: string
  /** A send would stop running work: said in the warning tone. */
  warn: boolean
}

/** The agent the composer will send to (the picker's choice); null for the task's own. */
interface AgentTarget {
  harness: string
  model: string | null
  effort: string | null
  fast: boolean
}

/** What a send will and will not do while this task still has live work. */
export function composerStatus(
  task: ApiTask | null,
  action: SteerAction | null,
  compacting = false,
  choice: AgentTarget | null = null
): ComposerStatus | null {
  // Recorded compact turns own their status in the transcript; action
  // compactors have one task-keyed note. Neither needs a duplicate here.
  if (compacting) return null
  if (action) return steerActionNote(action)
  if (!task?.background || task.background.state === "none") return null
  const running = backgroundNames(task.background)
  const what = `background work${running ? ` (${running})` : ""}`
  // The agent kept alive for this work takes the next message itself. Another
  // agent cannot, and the daemon stops it rather than run two in one session.
  if (backgroundLingers(task.background) && choice && !sameAgent(task, choice)) {
    return { text: `${what} · another agent stops it, then sends`, warn: true }
  }
  return { text: `${what} · send won't stop it`, warn: false }
}

function sameAgent(task: ApiTask, choice: AgentTarget): boolean {
  return choice.harness === task.harness && choice.model === task.model &&
    choice.effort === (task.effort ?? null) && choice.fast === (task.fast === true)
}
