import { BranchRequest, Clock, Console, DocumentList, Flowchart, type FluentIcon } from "@/components/icons"
import { useHarnessFeatures, useTaskShells, useTaskWorkflows } from "@/hooks/queries"
import { useChangedFileCount } from "@/hooks/useChangedFileCount"
import { useSubtaskCount } from "@/hooks/useSubtasks"
import type { ToolName } from "@/lib/tools"
import type { ApiTask, PullRequestInfo, PullRequestStatus } from "@/lib/types"

export const TOOL_LABEL: Record<ToolName, string> = {
  terminal: "Terminal",
  changes: "Changes",
  autopilot: "Autopilot",
  subtasks: "Subtasks",
  workflows: "Workflows",
}

export const TOOL_ICON: Record<ToolName, FluentIcon> = {
  terminal: Console,
  changes: DocumentList,
  autopilot: BranchRequest,
  subtasks: Flowchart,
  workflows: Clock,
}

/**
 * The small form of each tool's state, so the tool can stay closed: Changes
 * counts files, Subtasks counts children, Workflows counts the ones still
 * watching, a shell with a program in the foreground names it, and the
 * pull-request icon takes its PR's tone. The top bar's icons and the phone's
 * task sheet both draw them. Every count but one is a query the tool's pane
 * makes anyway: one key, one request. Changes is the exception, because its
 * pane's query is the whole diff: the hint asks for the count alone.
 */
export interface ToolHints {
  /** files changed, children, workflows still watching */
  count: Partial<Record<ToolName, number>>
  /** the programs in the foreground of the task's shells */
  running: string[]
  /** the PR the Autopilot tool is about, for its icon's tone */
  pullRequest: PullRequestInfo | null
}

export function useToolHints(task: ApiTask, pullRequest?: PullRequestStatus): ToolHints {
  const features = useHarnessFeatures()
  const files = useChangedFileCount(task)
  const workflows = useTaskWorkflows(task.id, features.data?.taskWorkflows === true).data
  const children = useSubtaskCount(task.id)
  const shells = useTaskShells(
    task.id,
    features.data?.taskTerminals === true && !task.archived && task.worktree_path !== null,
  ).data
  const watching = workflows?.filter((workflow) => workflow.state !== "completed").length ?? 0
  return {
    count: { changes: files, subtasks: children, workflows: watching },
    running: shells?.flatMap((shell) => (shell.program !== null && shell.exitCode === null ? [shell.program] : [])) ?? [],
    pullRequest: pullRequest?.kind === "found" ? pullRequest.pullRequest : null,
  }
}
