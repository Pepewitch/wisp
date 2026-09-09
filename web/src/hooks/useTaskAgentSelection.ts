import { useState } from "react"

import type { TaskAgentChoice } from "@/components/task-agent-picker"
import type { AgentSubmission } from "@/hooks/useSteerSubmit"
import type { ApiTask, HarnessInfo } from "@/lib/types"

interface AgentState {
  sourceKey: string
  taskId: string
  contextN: number
  choice: TaskAgentChoice
}

const stateFor = (task: ApiTask | null): AgentState | null =>
  task?.model
    ? {
        sourceKey: `${task.id}:${task.context_n ?? 1}:${task.harness}:${task.model}:${task.effort ?? ""}`,
        taskId: task.id,
        contextN: task.context_n ?? 1,
        choice: {
          harness: task.harness,
          model: task.model,
          effort: task.effort ?? null,
        },
      }
    : null

type SubmitAgent = (agent?: AgentSubmission | null) => void

/** Draft agent selection and the confirmation gate for crossing harnesses. */
export function useTaskAgentSelection(
  task: ApiTask | null,
  harnesses: HarnessInfo[],
) {
  const [state, setState] = useState<AgentState | null>(() => stateFor(task))
  const [confirmFresh, setConfirmFresh] = useState(false)
  const contextN = task?.context_n ?? 1
  const fallback = stateFor(task)
  if ((state?.sourceKey ?? null) !== (fallback?.sourceKey ?? null)) {
    setState(fallback)
    if (confirmFresh) setConfirmFresh(false)
  }
  const current =
    state && state.taskId === task?.id && state.contextN === contextN
      ? state
      : fallback
  const choice = current?.choice ?? null
  const selectedHarness = harnesses.find(
    (candidate) => candidate.name === choice?.harness,
  )

  const setChoice = (next: TaskAgentChoice) => {
    if (!task) return
    setState({
      sourceKey: fallback?.sourceKey ?? "",
      taskId: task.id,
      contextN,
      choice: next,
    })
  }

  const requestSend = (submit: SubmitAgent) => {
    if (!task || !choice) return submit()
    const changed =
      choice.harness !== task.harness ||
      choice.model !== task.model ||
      choice.effort !== (task.effort ?? null)
    if (!changed) return submit()
    if (choice.harness !== task.harness) {
      setConfirmFresh(true)
      return
    }
    submit({ ...choice, startFreshContext: false })
  }

  const confirm = (submit: SubmitAgent) => {
    if (!choice) return
    setConfirmFresh(false)
    submit({ ...choice, startFreshContext: true })
  }

  return {
    choice,
    selectedHarness,
    confirmFresh,
    setChoice,
    requestSend,
    cancel: () => setConfirmFresh(false),
    confirm,
  }
}
