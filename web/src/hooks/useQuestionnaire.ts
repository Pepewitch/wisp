import { useCallback, useMemo, useState } from "react"

import type { QuestionnaireState } from "@/components/questionnaire-card"
import type { QuestionnaireContext } from "@/components/questionnaire-context"
import { useAnswerQuestion } from "@/hooks/mutations"
import { hasCoarsePointer } from "@/hooks/useMediaQuery"
import { failureReason } from "@/lib/api"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ConversationDetail } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"

/**
 * The questionnaire card's state machine, which is mostly about honesty: a
 * card may only offer buttons when there is something on the other end of them.
 *
 * Everything a card SETTLED into comes from the log — answered, superseded by
 * a message, cancelled with the agent. The daemon writes that phase when it
 * releases the harness, so every viewer agrees and a reload rebuilds it. What
 * the log cannot say is whether the reply channel still EXISTS: that needs the
 * turn to still be running in this daemon, which only the task detail knows. A
 * question replayed from a settled turn, or from a daemon that has restarted
 * since, is `expired` — same card, no controls, copy pointing at the composer.
 */
export function useQuestionnaireController(
  task: ConversationDetail | null,
  touch: boolean,
): QuestionnaireContext {
  const runtime = useDaemonRuntime()
  const answer = useAnswerQuestion()
  const [sending, setSending] = useState<string | null>(null)
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map())

  const taskId = task?.id ?? null
  const live = Boolean(task && task.state === "needs-input" && hasRunningTurn(task))

  const stateOf = useCallback(
    (questionId: string): QuestionnaireState =>
      sending === questionId ? "submitting" : live ? "pending" : "expired",
    [live, sending],
  )

  const errorOf = useCallback((questionId: string) => errors.get(questionId) ?? null, [errors])

  const onSubmit = useCallback(
    (questionId: string, answers: { index: number; answer: string }[]) => {
      if (!taskId || sending) return
      setSending(questionId)
      setErrors((previous) => {
        if (!previous.has(questionId)) return previous
        const next = new Map(previous)
        next.delete(questionId)
        return next
      })
      answer.mutate(
        { id: taskId, questionId, answers },
        {
          // A refusal is the card's own sentence, not a toast: the reader is
          // looking at the thing that failed.
          onError: (error: unknown) => {
            setSending(null)
            setErrors((previous) => new Map(previous).set(questionId, failureReason(error)))
          },
          // The daemon's `question` event is what settles the card. Clearing
          // the in-flight marker here only stops it reading "Sending…" forever
          // if that event is slow behind a busy stream.
          onSuccess: () => setSending(null),
        },
      )
    },
    [answer, sending, taskId],
  )

  const onFocusComposer = useCallback(() => {
    uiIntentsFor(runtime.connectionId).focusComposer()
  }, [runtime.connectionId])

  return useMemo(
    () => ({
      harness: task?.harness ?? null,
      touch: touch || hasCoarsePointer(),
      stateOf,
      errorOf,
      onSubmit,
      onFocusComposer,
    }),
    [errorOf, onFocusComposer, onSubmit, stateOf, task?.harness, touch],
  )
}

/**
 * Whether a turn is still open in the daemon. `needs-input` alone is not
 * enough: it is also the state of a turn that ENDED asking for something.
 */
function hasRunningTurn(task: ConversationDetail): boolean {
  return task.turns.some((turn) => turn.status === "running")
}
