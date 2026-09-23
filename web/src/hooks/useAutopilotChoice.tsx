import { useState, type ReactNode } from "react"

import { AutopilotPicker, type AutopilotChoice } from "@/components/autopilot-picker"
import { useHarnessFeatures } from "@/hooks/queries"
import type { TaskMode } from "@/lib/types"

/**
 * The composer's auto-merge / auto-fix choice: offered for a worktree task on
 * a daemon that has it, and sent only when a switch is on.
 */
export function useAutopilotChoice(mode: TaskMode): { picker: ReactNode; body: { autopilot?: AutopilotChoice } } {
  const [value, setValue] = useState<AutopilotChoice>({ autoMerge: false, autoFix: false })
  const features = useHarnessFeatures()
  const offered = features.data?.taskAutopilot === true && mode === "worktree"
  return {
    picker: offered ? <AutopilotPicker value={value} onChange={setValue} /> : null,
    body: offered && (value.autoMerge || value.autoFix) ? { autopilot: value } : {},
  }
}
