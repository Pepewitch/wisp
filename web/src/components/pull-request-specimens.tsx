import { PullRequestStatusLink } from "@/components/pull-request-status"
import { PR_SPECIMEN } from "@/components/gallery-fixtures"

/**
 * The pull-request link's two shapes. They live outside `gallery.tsx` for the
 * same reason the prompt-bubble and connection specimens do: that file is the
 * route, not a warehouse, and it sits at its maintainability cap.
 */
export function PullRequestSpecimens() {
  return (
    <>
      <div className="mt-4 flex items-center gap-3">
        <PullRequestStatusLink pullRequest={PR_SPECIMEN} />
        <span className="text-[11.5px] text-muted-foreground">
          Branch outcome replaces the task header's Push button; unsupported or absent status renders nothing.
        </span>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <PullRequestStatusLink pullRequest={PR_SPECIMEN} others={2} />
        <span className="text-[11.5px] text-muted-foreground">
          A task branches more than once when main moves under it — so Wisp asks about every{" "}
          <span className="font-mono text-faint">wisp/&lt;id&gt;-…</span> branch it made, shows the NEWEST pull
          request, and counts the rest. That count is the only thing the row would otherwise be hiding.
        </span>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <PullRequestStatusLink pullRequest={{ ...PR_SPECIMEN, queuedToMerge: true }} />
        <span className="text-[11.5px] text-muted-foreground">
          Queue membership replaces the open state and uses GitHub&apos;s merge-queue orange.
        </span>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <PullRequestStatusLink
          pullRequest={PR_SPECIMEN}
          autoMerge={{ autoMerge: true, autoFix: false, pr: PR_SPECIMEN.number, state: "waiting", reason: "Waiting for checks (2 running)", about: "pr", mergedByWisp: false, updatedAt: null }}
        />
        <span className="text-[11.5px] text-muted-foreground">
          With auto-merge on, its reason stands in for CI and review — it already accounts for both, and a
          reason tacked onto a truncating line is the first thing cut. The hover keeps every fact.
        </span>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <PullRequestStatusLink
          pullRequest={{ ...PR_SPECIMEN, lifecycle: "merged" }}
          autoMerge={{ autoMerge: false, autoFix: false, pr: PR_SPECIMEN.number, state: "merged", reason: "Merged by Wisp", about: "pr", mergedByWisp: true, updatedAt: null }}
        />
        <span className="text-[11.5px] text-muted-foreground">A PR auto-merge landed says so.</span>
      </div>
    </>
  )
}
