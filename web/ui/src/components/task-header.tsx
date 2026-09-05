import { Local } from "@/components/icons"
import { Meta, StateDot } from "@/components/primitives"
import { PullRequestStatusLink } from "@/components/pull-request-status"
import { TaskActions } from "@/components/task-actions"
import { stateWord } from "@/lib/state"
import type { ApiTask, PullRequestStatus } from "@/lib/types"
import { oneLine } from "@/lib/utils"

/**
 * The centre column's header. The task's TITLE leads — the old header led with
 * the id in bold mono and never showed the title at all, which is why every
 * task looked like every other task.
 *
 * An associated PR replaces the old Push button with the durable outcome of
 * the task branch: lifecycle, CI and review. No PR, unsupported origin, or a
 * provider failure renders nothing. Push remains available through `/push`.
 *
 * Stop/steer lives in the composer. Archive, Fresh session and Copy branch
 * live behind the overflow.
 */
export function TaskHeader({
  task,
  pullRequest,
  worktreeReason,
}: {
  task: ApiTask | null
  pullRequest?: PullRequestStatus
  /** the daemon's one sentence when git can no longer read the worktree (D1) */
  worktreeReason?: string | null
}) {
  if (!task) {
    return (
      <div className="flex h-[60px] shrink-0 items-center border-b border-border px-4.5 text-[13px] text-muted-foreground">
        Select a task
      </div>
    )
  }

  return (
    <div className="shrink-0 border-b border-border px-4.5 pt-2.5 pb-3">
      <div className="flex items-center gap-2.5">
        <h1 className="min-w-0 flex-1 truncate text-[14.5px] font-semibold tracking-[-0.01em]">{task.title}</h1>
        <div className="flex shrink-0 items-center gap-1.5">
          {pullRequest?.kind === "found" && <PullRequestStatusLink pullRequest={pullRequest.pullRequest} />}
          <TaskActions task={task} />
        </div>
      </div>

      <Meta
        className="mt-1.5"
        items={[
          <span key="id" className="font-mono text-fg-secondary">
            {task.id}
          </span>,
          <span key="state" className="flex items-center gap-1.5">
            <StateDot state={task.state} />
            <span className="text-fg-secondary">{stateWord(task)}</span>
          </span>,
          task.archived && <span key="arch">Archived</span>,
          // Worktree is the default and the wisp/… branch already says so;
          // LOCAL is the one worth calling out, because this task is editing
          // the checkout the user works in.
          task.mode === "local" && (
            <span key="mode" className="flex items-center gap-1.5 text-fg-secondary">
              <Local className="size-3" />
              Local
            </span>
          ),
          task.branch && (
            <span key="branch" className="truncate font-mono">
              {task.branch}
            </span>
          ),
          <span key="agent" className="flex min-w-0 items-center gap-2">
            <span className="shrink-0">{task.harness}</span>
            {task.model && (
              <>
                <span className="text-faint">·</span>
                <span className="min-w-0 truncate font-mono">{task.model}</span>
              </>
            )}
            {task.effort && (
              <>
                <span className="shrink-0 text-faint">·</span>
                <span className="shrink-0">{task.effort} effort</span>
              </>
            )}
          </span>,
        ]}
      />

      {/* ONE muted line, the same register the archived-task placeholders use.
          Capped here as well as at the daemon: nothing about a git failure gets
          to grow into a wall of text in the header (D1). */}
      {worktreeReason && (
        <div className="mt-1.5 text-[11.5px] leading-normal text-muted-foreground">{oneLine(worktreeReason)}</div>
      )}
    </div>
  )
}
