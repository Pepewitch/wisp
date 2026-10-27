import type { SteerNote } from "@/hooks/useSteerCommands"
import type { ApiTask, Turn } from "@/lib/types"

/**
 * What the steer box can do right now, from the task, the draft and the
 * notes in flight. Pure, so the composer's render reads it in one call.
 */

export interface SuffixSelection {
  taskId: string | null
  value: string | null
}

function settledCompactionNote(note: SteerNote, turns?: Turn[]): SteerNote | null {
  if (note.compactTurn === undefined) return note
  const turn = turns?.find((turn) => turn.n === note.compactTurn)
  // Once its recorded turn arrives, the transcript owns running, completion,
  // and failure presentation. Keep this note only across the response-to-SSE
  // handoff so there is never a moment with no feedback.
  return turn ? null : note
}

export function steerState({
  task,
  value,
  sending,
  note,
  turns,
  suffixSelection,
  compactingTaskId,
}: {
  task: ApiTask | null
  value: string
  sending: boolean
  note: SteerNote | null
  turns?: Turn[]
  suffixSelection: SuffixSelection
  compactingTaskId: string | null
}) {
  const taskId = task?.id ?? null
  const suffixPromptId =
    suffixSelection.taskId === taskId ? suffixSelection.value : null
  const disabled = !task || task.archived || task.state === "creating"
  // A stuck task still owns a live turn; it must stop/steer like running,
  // rather than offering a send the daemon will reject.
  const blocked = task?.state === "running" || task?.state === "stuck"
  const compacting = compactionIsRunning(taskId, note, turns, compactingTaskId)
  const hasMessage = value.trim().length > 0
  const canSend = hasMessage && !disabled && !sending && !compacting
  const hasBackground = task?.background && task.background.state !== "none"
  const canStop = (blocked || hasBackground) && !hasMessage && !disabled && !sending
  const shown = note && task && note.taskId === task.id ? settledCompactionNote(note, turns) : null
  return { taskId, suffixPromptId, disabled, blocked, compacting, canSend, canStop: Boolean(canStop), shown }
}

function compactionIsRunning(
  taskId: string | null,
  note: SteerNote | null,
  turns: Turn[] | undefined,
  compactingTaskId: string | null
): boolean {
  if (taskId !== null && compactingTaskId === taskId) return true
  if (turns?.some((turn) => turn.operation === "compact" && turn.status === "running")) return true
  if (note?.taskId !== taskId || note.compactTurn === undefined) return false
  return !turns?.some((turn) => turn.n === note.compactTurn)
}
