import { useState } from "react"

import type { TaskAgentChoice } from "@/components/task-agent-picker"
import { sendWhen, steerAction, type SteerAction } from "@/lib/steer-delivery"
import type { ApiTask, SendWhen } from "@/lib/types"

export interface QueueToggleState {
  value: boolean
  onChange: (value: boolean) => void
}

/**
 * The composer's delivery choice while a turn runs: what send will do, the
 * `when` it carries, and the queue toggle. The toggle holds one send, for the
 * task and the turn it was armed on: a task switch, a send, or the turn
 * ending turns it off again.
 */
export function useSteerDelivery({
  task,
  taskId,
  blocked,
  supported,
  choice,
}: {
  task: ApiTask | null
  taskId: string | null
  blocked: boolean
  supported: boolean
  /** the picker's agent, when the picker is offered */
  choice: TaskAgentChoice | null
}): {
  action: SteerAction | null
  when: SendWhen | undefined
  queue: QueueToggleState | null
  reset: () => void
} {
  const [queueFor, setQueueFor] = useState<string | null>(null)
  if (queueFor !== null && (queueFor !== taskId || !blocked)) setQueueFor(null)
  const queued = queueFor !== null && queueFor === taskId
  const action = steerAction({ task, blocked, supported, queued, choice })
  const offered = action !== null && action !== "legacy" && Boolean(task?.turn_input)
  return {
    action,
    when: sendWhen(supported, action),
    queue: offered ? { value: queued, onChange: (on) => setQueueFor(on ? taskId : null) } : null,
    reset: () => setQueueFor(null),
  }
}
