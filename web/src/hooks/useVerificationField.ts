import { useEffect, useRef, useState } from "react"

import { useHarnessFeatures } from "@/hooks/queries"
import type { ProjectVerifyAgent, ProjectVerifySecond, RepoInfo } from "@/lib/types"

/**
 * The project settings' Verification section, as the form holds it: whether
 * it is drawn, the reviewer agents it saves with Save, and the ref the dialog
 * scrolls to when it was opened at Verification.
 *
 * A daemon older than auto-review serves no `verification` on its repos and
 * would refuse a `verify` it does not know, so `reviewable` gates both the
 * section and the field in the save body. `panel` (`features.reviewPanel`)
 * gates the second reviewer the same way. A gallery specimen draws the
 * section from its own model (`specimen`) whatever the daemon says.
 */
export function useVerificationField(project: RepoInfo, section: "verification" | null, specimen: boolean) {
  const [verify, setVerify] = useState<ProjectVerifyAgent | null>(project.verify ?? null)
  // undefined until a person picks one: Save sends `verifySecond` only then,
  // so a save never overwrites a choice made elsewhere (the CLI) with a stale read
  const [second, setSecond] = useState<ProjectVerifySecond | undefined>(undefined)
  const features = useHarnessFeatures()
  const reviewable = features.data?.autoReview === true && project.verification !== undefined
  const panel = reviewable && features.data?.reviewPanel === true
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
  }
  /** the section's second-reviewer picker, or null where the daemon has no panel */
  const secondField = panel ? { value: second, onChange: setSecond } : null
  return { verify, setVerify, second, setSecond, secondField, patch, reviewable, panel, show, ref }
}
