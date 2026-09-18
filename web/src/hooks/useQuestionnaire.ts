import { useCallback, useMemo, useState } from "react"

import type { QuestionnaireState } from "@/components/questionnaire-card"
import type { QuestionnaireContext } from "@/components/questionnaire-context"
import { useAnswerQuestion } from "@/hooks/mutations"
import { hasCoarsePointer } from "@/hooks/useMediaQuery"
import { failureReason } from "@/lib/api"
import { emptyDraft, type QuestionDraft } from "@/lib/questionnaire"
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
 * question `asked` with nothing behind it — so the daemon names the live one
 * in `pending_question_id`. That fact arrives on a DIFFERENT clock: the log
 * stream delivers the question immediately, while the task detail is refetched
 * behind a 400ms debounce (lib/sse.ts), so for the first half-second the
 * daemon's answer is stale.
 *
 * Hence `stateOf` below: trust the daemon when it is informative, and fall
 * back to the turn while it is not. Getting that fallback backwards is the
 * expensive mistake — a form that cannot be sent costs a click and a refusal,
 * while "this question expired" over a LIVE question is a lie that sends the
 * reader somewhere else entirely.
 *
 * The drafts live here rather than in the card because the card unmounts more
 * often than anyone expects: a task switch, and every stream reconnect, which
 * resets the blocks to `[]` before replaying them.
 */
export function useQuestionnaireController(
  task: ConversationDetail | null,
  touch: boolean,
): QuestionnaireContext {
  const runtime = useDaemonRuntime()
  const answer = useAnswerQuestion()
  const [sending, setSending] = useState<string | null>(null)
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map())
  /** Answered in this session — the card stays locked until the log agrees. */
  const [submitted, setSubmitted] = useState<Set<string>>(() => new Set())
  const [drafts, setDrafts] = useState<Map<string, Map<number, QuestionDraft>>>(() => new Map())

  const taskId = task?.id ?? null
  const pendingId = task?.pending_question_id ?? null
  // A question can only be live inside a turn that is still open. Both facts
  // come from the same (possibly stale) detail, but they move together.
  const turnOpen = Boolean(task?.state === "needs-input" && task.turns.some((turn) => turn.status === "running"))

  // Nothing here belongs to the next task. The Conversation stays mounted
  // across a switch, so without this an in-flight submit on task A would
  // silently swallow the first click on task B. Reset during RENDER rather
  // than in an effect: React re-renders immediately without committing the
  // stale pass, so the new task never paints another task's answers.
  const [seenTask, setSeenTask] = useState(taskId)
  if (seenTask !== taskId) {
    setSeenTask(taskId)
    setSending(null)
    setErrors(new Map())
    setSubmitted(new Set())
    setDrafts(new Map())
  }

  const stateOf = useCallback(
    (questionId: string): QuestionnaireState => {
      if (sending === questionId) return "submitting"
      // Already sent: hold it locked rather than letting a second click race
      // the log's `answered` event into a refusal for a question that worked.
      if (submitted.has(questionId)) return "submitting"
      if (questionId === pendingId) return "pending"
      // The daemon is holding a DIFFERENT question, so this one is genuinely
      // over — that is an informative answer, not a stale one.
      if (pendingId !== null) return "expired"
      return turnOpen ? "pending" : "expired"
    },
    [pendingId, sending, submitted, turnOpen],
  )

  const errorOf = useCallback((questionId: string) => errors.get(questionId) ?? null, [errors])

  const draftsFor = useCallback(
    (questionId: string) => drafts.get(questionId) ?? EMPTY_DRAFTS,
    [drafts],
  )

  const onDraftChange = useCallback(
    (questionId: string, index: number, change: (draft: QuestionDraft) => QuestionDraft) => {
      setDrafts((previous) => {
        const next = new Map(previous)
        const forQuestion = new Map(previous.get(questionId) ?? EMPTY_DRAFTS)
        forQuestion.set(index, change(forQuestion.get(index) ?? emptyDraft()))
        next.set(questionId, forQuestion)
        return next
      })
    },
    [],
  )

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
          // looking at the thing that failed. It also unlocks the card, since
          // the answer demonstrably did not land.
          onError: (error: unknown) => {
            setSending(null)
            setErrors((previous) => new Map(previous).set(questionId, failureReason(error)))
          },
          // The daemon's `question` event is what settles the card for good;
          // until it arrives the card stays locked rather than re-offering a
          // Send for an answer that already succeeded.
          onSuccess: () => {
            setSending(null)
            setSubmitted((previous) => new Set(previous).add(questionId))
          },
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
      draftsFor,
      onDraftChange,
      onSubmit,
      onFocusComposer,
    }),
    [draftsFor, errorOf, onDraftChange, onFocusComposer, onSubmit, stateOf, task?.harness, touch],
  )
}

const EMPTY_DRAFTS: ReadonlyMap<number, QuestionDraft> = new Map()
