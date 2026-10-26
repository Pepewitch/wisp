import { useEffect, useRef, useState } from "react"

import { useHarnessFeatures } from "@/hooks/queries"
import type { ProjectVerifyAgent, ProjectVerifySecond, RepoInfo } from "@/lib/types"

/** Each reviewer's fallback as the form holds it: undefined until a person picks one, null for none. */
export interface ReviewerFallbacks {
  primary?: ProjectVerifyAgent | null
  second?: ProjectVerifyAgent | null
}

/**
 * The project settings' Verification section, as the form holds it: whether
 * it is drawn, the reviewer agents it saves with Save, and the ref the dialog
 * scrolls to when it was opened at Verification.
 *
 * A daemon older than auto-review serves no `verification` on its repos and
 * would refuse a `verify` it does not know, so `reviewable` gates both the
 * section and the field in the save body. `panel` (`features.reviewPanel`)
 * gates the second reviewer the same way, and `fallbacks`
 * (`features.reviewFallback`) each reviewer's fallback agent. A gallery specimen draws the
 * section from its own model (`specimen`) whatever the daemon says.
 */
export function useVerificationField(project: RepoInfo, section: "verification" | null, specimen: boolean) {
  const [verify, setVerify] = useState<ProjectVerifyAgent | null>(project.verify ?? null)
  // undefined until a person picks one: Save sends `verifySecond` only then,
  // so a save never overwrites a choice made elsewhere (the CLI) with a stale read
  const [second, setSecond] = useState<ProjectVerifySecond | undefined>(undefined)
  const [fallbacks, setFallbacks] = useState<ReviewerFallbacks>({})
  const features = useHarnessFeatures()
  const reviewable = features.data?.autoReview === true && project.verification !== undefined
  const panel = reviewable && features.data?.reviewPanel === true
  const fallible = reviewable && features.data?.reviewFallback === true
  const show = reviewable || specimen
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (section !== "verification" || !show) return
    const target = ref.current
    target?.scrollIntoView?.({ block: "start" })
    target?.focus({ preventScroll: true })
  }, [section, show])
  /** what Save adds to the body: `verify` where the daemon knows it, `verifySecond` only once picked on a panel daemon */
  const patch = {
    ...(reviewable ? { verify } : {}),
    ...(panel && second !== undefined ? { verifySecond: second } : {}),
    ...(fallible && fallbacks.primary !== undefined ? { verifyFallback: fallbacks.primary } : {}),
    ...(fallible && fallbacks.second !== undefined ? { verifySecondFallback: fallbacks.second } : {}),
  }
  /** the section's second-reviewer picker, or null where the daemon has no panel */
  const secondField = panel ? { value: second, onChange: setSecond } : null
  /** the section's fallback pickers, or null where the daemon has no fallbacks */
  const fallbackField = fallible
    ? { value: fallbacks, onChange: (role: keyof ReviewerFallbacks, agent: ProjectVerifyAgent | null) => setFallbacks((prev) => ({ ...prev, [role]: agent })) }
    : null
  return { verify, setVerify, second, setSecond, secondField, fallbackField, patch, reviewable, panel, show, ref }
}
