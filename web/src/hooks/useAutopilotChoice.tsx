import { useState, type ReactNode } from "react"

import { AutopilotPicker, type AutopilotChoice } from "@/components/autopilot-picker"
import { useHarnessFeatures } from "@/hooks/queries"
import type { TaskMode } from "@/lib/types"

const OFF: AutopilotChoice = { autoMerge: false, autoFix: false }

/**
 * The composer's auto-merge / auto-fix / auto-review choice: offered for a
 * worktree task on a daemon that has it, and sent only when a switch is on.
 *
 * Auto-merge and auto-fix start at the chosen model's default (`fallback`,
 * from the Models modal) and follow it until that switch is flipped; `chosen`
 * holds only the flipped ones, and `reset` forgets them when another model is
 * picked. Auto-review has no per-model default: it starts off, and a model
 * change keeps it.
 *
 * `autoReview` rides in the body only when it is on and the daemon advertises
 * `features.autoReview` — an older daemon rejects a field it does not know.
 */
export function useAutopilotChoice(
  mode: TaskMode,
  saved?: Partial<AutopilotChoice>,
  fallback: AutopilotChoice = OFF,
): {
  picker: ReactNode
  body: { autopilot?: AutopilotChoice }
  value: AutopilotChoice
  chosen: Partial<AutopilotChoice>
  reset: () => void
} {
  const [chosen, setChosen] = useState<Partial<AutopilotChoice>>(saved ?? {})
  const features = useHarnessFeatures()
  const review = features.data?.autoReview === true
  const value: AutopilotChoice = {
    autoMerge: chosen.autoMerge ?? fallback.autoMerge,
    autoFix: chosen.autoFix ?? fallback.autoFix,
    autoReview: review && (chosen.autoReview ?? fallback.autoReview ?? false),
  }
  const offered = features.data?.taskAutopilot === true && mode === "worktree"
  const change = (next: AutopilotChoice) =>
    setChosen((current) => ({
      ...current,
      ...(next.autoMerge !== value.autoMerge ? { autoMerge: next.autoMerge } : {}),
      ...(next.autoFix !== value.autoFix ? { autoFix: next.autoFix } : {}),
      ...(next.autoReview !== value.autoReview ? { autoReview: next.autoReview === true } : {}),
    }))
  const on = value.autoMerge || value.autoFix || value.autoReview === true
  const sent: AutopilotChoice = value.autoReview
    ? { autoMerge: value.autoMerge, autoFix: value.autoFix, autoReview: true }
    : { autoMerge: value.autoMerge, autoFix: value.autoFix }
  return {
    picker: offered ? <AutopilotPicker value={value} onChange={change} review={review} /> : null,
    body: offered && on ? { autopilot: sent } : {},
    value,
    chosen,
    // auto-review is no model's default, so another model keeps its flip
    reset: () => setChosen((current) => (current.autoReview === undefined ? {} : { autoReview: current.autoReview })),
  }
}
