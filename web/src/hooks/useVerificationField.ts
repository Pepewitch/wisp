import { useEffect, useRef, useState } from "react"

import { useHarnessFeatures } from "@/hooks/queries"
import type { ProjectVerifyAgent, RepoInfo } from "@/lib/types"

/**
 * The project settings' Verification section, as the form holds it: whether
 * it is drawn, the reviewer agent it saves with Save, and the ref the dialog
 * scrolls to when it was opened at Verification.
 *
 * A daemon older than auto-review serves no `verification` on its repos and
 * would refuse a `verify` it does not know, so `reviewable` gates both the
 * section and the field in the save body. A gallery specimen draws the
 * section from its own model (`specimen`) whatever the daemon says.
 */
export function useVerificationField(project: RepoInfo, section: "verification" | null, specimen: boolean) {
  const [verify, setVerify] = useState<ProjectVerifyAgent | null>(project.verify ?? null)
  const features = useHarnessFeatures()
  const reviewable = features.data?.autoReview === true && project.verification !== undefined
  const show = reviewable || specimen
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (section !== "verification" || !show) return
    const target = ref.current
    target?.scrollIntoView?.({ block: "start" })
    target?.focus({ preventScroll: true })
  }, [section, show])
  return { verify, setVerify, reviewable, show, ref }
}
