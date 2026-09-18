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

/** Questions still open anywhere in an activity tree, for the waiting float. */
export function countAskedQuestions(items: ActivityItem[]): number {
  let open = 0
  for (const item of items) {
    if (item.kind === "question" && item.status === "asked") open += 1
    else if (item.kind === "subagent") open += countAskedQuestions(item.items)
  }
  return open
}
