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
 * releases the harness, so every viewer agrees and a reload rebuilds it.
 *
 * What the log cannot say is which unreleased question can still be ANSWERED.
 * A transcript can hold more than one — an older Droid's fallback leaves a
 * question `asked` with nothing behind it — and "still open in the log" is not
 * "open in this daemon, right now". Only the live driver knows the second, so
 * the daemon names it (`pending_question_id`) and everything else is
 * `expired`: same card, no controls, copy pointing at the composer.
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
  const pendingId = task?.pending_question_id ?? null

  const stateOf = useCallback(
    (questionId: string): QuestionnaireState => {
      if (sending === questionId) return "submitting"
      return questionId === pendingId ? "pending" : "expired"
    },
    [pendingId, sending],
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
