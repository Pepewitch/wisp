import { useState } from "react"

import { BriefToggle } from "@/components/fast-mode-toggle"
import { useHarnessFeatures } from "@/hooks/queries"
import type { CreateTaskDraft } from "@/lib/drafts"
import type { HarnessInfo } from "@/lib/types"

/**
 * The composer's task-brief choice: offered only where the daemon has briefs
 * and the chosen harness proved it can publish one, off for every new task,
 * and sent only when on — so an older daemon or a harness without it never
 * sees the field.
 */
export function useBriefChoice(harness: HarnessInfo | null, saved: Pick<CreateTaskDraft, "brief"> | null | undefined) {
  const [value, setValue] = useState(saved?.brief === true)
  const features = useHarnessFeatures()
  const offered = features.data?.taskBriefs === true && harness?.hasBriefs === true
  return {
    value,
    toggle: offered ? <BriefToggle value={value} onChange={setValue} /> : null,
    body: offered && value ? { briefEnabled: true } : {},
  }
}
