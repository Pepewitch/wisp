import { createContext, useContext } from "react"

import type { QuestionnaireState } from "@/components/questionnaire-card"

/**
 * What a questionnaire card needs that its own log item cannot say.
 *
 * `ActivityList` is recursive (a subagent's steps nest inside it), so passing
 * these through every level would thread six props through a component that
 * cares about none of them. The Conversation provides once; the card reads.
 *
 * Absent provider = read-only cards. That is the honest default for every
 * surface that renders a transcript without a live turn behind it — the
 * gallery, an export, a settled turn someone scrolled back to.
 */
export interface QuestionnaireContext {
  /** Which harness is asking, for the card's one sentence of copy. */
  harness: string | null
  /** Thumb sizing, from the same `hasCoarsePointer` the composer uses. */
  touch: boolean
  /** How this specific card should render right now. */
  stateOf: (questionId: string) => QuestionnaireState
  /** The refusal the daemon gave for this card's last attempt, if any. */
  errorOf: (questionId: string) => string | null
  onSubmit: (questionId: string, answers: { index: number; answer: string }[]) => void
  onFocusComposer: () => void
}

const Context = createContext<QuestionnaireContext | null>(null)

export const QuestionnaireProvider = Context.Provider

export function useQuestionnaire(): QuestionnaireContext | null {
  return useContext(Context)
}
