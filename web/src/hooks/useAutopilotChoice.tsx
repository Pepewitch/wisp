import { useState, type ReactNode } from "react"

import { AutopilotPicker, type AutopilotChoice } from "@/components/autopilot-picker"
import { useHarnessFeatures } from "@/hooks/queries"
import type { TaskMode } from "@/lib/types"

const OFF: AutopilotChoice = { autoMerge: false, autoFix: false }

/**
 * The composer's auto-merge / auto-fix choice: offered for a worktree task on
 * a daemon that has it, and sent only when a switch is on.
 *
 * Each switch starts at the chosen model's default (`fallback`, from the
 * Models modal) and follows it until that switch is flipped; `chosen` holds
 * only the flipped ones, and `reset` forgets them when another model is
 * picked.
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
  const value: AutopilotChoice = {
    autoMerge: chosen.autoMerge ?? fallback.autoMerge,
    autoFix: chosen.autoFix ?? fallback.autoFix,
  }
  const features = useHarnessFeatures()
  const offered = features.data?.taskAutopilot === true && mode === "worktree"
  const change = (next: AutopilotChoice) =>
    setChosen((current) => ({
      ...current,
      ...(next.autoMerge !== value.autoMerge ? { autoMerge: next.autoMerge } : {}),
      ...(next.autoFix !== value.autoFix ? { autoFix: next.autoFix } : {}),
    }))
  return {
    picker: offered ? <AutopilotPicker value={value} onChange={change} /> : null,
    body: offered && (value.autoMerge || value.autoFix) ? { autopilot: value } : {},
    value,
    chosen,
    reset: () => setChosen({}),
  }
}
