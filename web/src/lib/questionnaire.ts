import type { QuestionPrompt } from "@/lib/types"
import type { ActivityItem } from "@/stream/reducer"

/** One question's working answer: chosen labels plus whatever was typed. */
export interface QuestionDraft {
  selected: Set<string>
  own: string
  ownOpen: boolean
}

export function emptyDraft(): QuestionDraft {
  return { selected: new Set(), own: "", ownOpen: false }
}

/**
 * One question's answer as the harness receives it. Multi-select is joined in
 * the harness's OPTION order rather than click order, so two people who pick
 * the same set send the same string.
 */
export function answerText(question: QuestionPrompt, draft: QuestionDraft): string {
  const chosen = question.options.filter((option) => draft.selected.has(option))
  const own = draft.own.trim()
  if (own) chosen.push(own)
  return chosen.join(", ")
}

/**
 * How many questions the one pending card is asking, for the waiting float.
 *
 * Scoped to the id the daemon says is answerable, not to every unreleased
 * question in the transcript: an older harness can leave one `asked` in the
 * log forever, and counting that would send the reader to a card they cannot
 * answer. The number is the questions INSIDE that card, which is what "3
 * questions waiting" means to whoever reads it.
 */
export function countPendingQuestions(
  items: ActivityItem[],
  pendingId: string | null | undefined,
): number {
  if (!pendingId) return 0
  for (const item of items) {
    if (item.kind === "question" && item.id === pendingId && item.status === "asked") {
      return item.questions.length
    }
    if (item.kind === "subagent") {
      const nested = countPendingQuestions(item.items, pendingId)
      if (nested > 0) return nested
    }
  }
  return 0
}
