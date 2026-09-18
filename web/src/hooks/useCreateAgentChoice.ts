import { useState } from "react"

import {
  initialChoice,
  type ModelChoice,
} from "@/lib/model-choice"
import {
  defaultServiceTierFor,
  serviceTierForModel,
} from "@/lib/service-tier"
import type { HarnessInfo } from "@/lib/types"

export function useCreateAgentChoice(
  harnesses: HarnessInfo[],
  preferredChoice: ModelChoice | null,
) {
  const [choice, setChoice] = useState<ModelChoice | null>(() =>
    initialChoice(harnesses, preferredChoice),
  )
  const [effort, setEffort] = useState(
    () => harnesses.find((harness) => harness.name === choice?.harness)?.defaults.reasoningEffort ?? "",
  )
  const [serviceTier, setServiceTier] = useState<string | null>(() =>
    defaultServiceTierFor(harnesses.find((harness) => harness.name === choice?.harness)),
  )

  const pickChoice = (next: ModelChoice) => {
    const destination = harnesses.find((candidate) => candidate.name === next.harness)
    setChoice(next)
    setEffort(destination?.defaults.reasoningEffort ?? "")
    setServiceTier(
      serviceTierForModel(destination, next.model, next.harness === choice?.harness ? serviceTier : null),
    )
  }

  return { choice, effort, serviceTier, pickChoice, setEffort, setServiceTier }
}
