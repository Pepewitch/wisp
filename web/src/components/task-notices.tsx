import { CleanupPanel } from "./cleanup-panel"
import type { ApiTask } from "@/lib/types"
import { oneLine } from "@/lib/utils"

/**
 * What is left of the old task header: the notices that ask the person to act.
 * The task's identity, its state and its verbs live in the top bar now
 * (`top-bar-task.tsx`), so a task with nothing to decide renders nothing here
 * and the conversation starts at the top of the pane.
 *
 * They keep to the reading column, because they are read with the transcript
 * under them rather than as pane chrome.
 */
export function TaskNotices({
  task,
  worktreeReason,
}: {
  task: ApiTask | null
  /** the daemon's one sentence when git can no longer read the worktree (D1) */
  worktreeReason?: string | null
}) {
  if (!task || (!task.cleanup && !worktreeReason)) return null
  return (
    <div className="shrink-0 border-b border-border">
      <div className="mx-auto w-full max-w-(--reading-measure) px-4.5 pt-1.5 pb-3">
        {task.cleanup && <CleanupPanel task={task} />}

        {/* ONE muted line, the same register the archived-task placeholders use.
            Capped here as well as at the daemon: nothing about a git failure gets
            to grow into a wall of text above the conversation (D1). */}
        {worktreeReason && (
          <div className="mt-1.5 text-[11.5px] leading-normal text-muted-foreground">{oneLine(worktreeReason)}</div>
        )}
      </div>
    </div>
  )
}
