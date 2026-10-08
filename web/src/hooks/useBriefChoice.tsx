import { useState } from "react"

import { BriefToggle } from "@/components/fast-mode-toggle"
import { useHarnessFeatures } from "@/hooks/queries"
import type { CreateTaskDraft } from "@/lib/drafts"
import type { HarnessInfo } from "@/lib/types"

/**
 * The composer's task-brief choice: offered only where the daemon has briefs
 * and the chosen harness proved it can publish one, and sent only when on —
 * so an older daemon or a harness without it never sees the field.
 *
 * It starts at the chosen model's default (`fallback`, from the Models
 * modal) and follows it until the toggle is pressed; `chosen` is that press,
 * and `reset` forgets it when another model is picked.
 */
export function useBriefChoice(
  harness: HarnessInfo | null,
  saved: Pick<CreateTaskDraft, "brief"> | null | undefined,
  fallback: boolean,
) {
  const [chosen, setChosen] = useState<boolean | undefined>(saved?.brief)
  const value = chosen ?? fallback
  const features = useHarnessFeatures()
  const offered = features.data?.taskBriefs === true && harness?.hasBriefs === true
  return {
    value,
    chosen,
    reset: () => setChosen(undefined),
    toggle: offered ? <BriefToggle value={value} onChange={setChosen} /> : null,
    body: offered && value ? { briefEnabled: true } : {},
  }
}
