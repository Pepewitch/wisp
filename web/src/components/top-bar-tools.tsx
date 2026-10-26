import { BranchRequest, Clock, Console, DocumentList, Flowchart, type FluentIcon } from "@/components/icons"
import { parsedDiff, useDiff, useHarnessFeatures, useTaskShells, useTaskWorkflows } from "@/hooks/queries"
import { useSubtaskCount } from "@/hooks/useSubtasks"
import { useToolPanelControls } from "@/hooks/useToolPanel"
import { changedFileCount } from "@/lib/diff"
import { PULL_REQUEST_ICON_TONE, pullRequestIconTone } from "@/lib/pull-request-tone"
import { STATE_DOT } from "@/lib/state"
import { TOOL_NAMES, type ToolName } from "@/lib/tools"
import type { ApiTask, PullRequestStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

const LABEL: Record<ToolName, string> = {
  terminal: "Terminal",
  changes: "Changes",
  autopilot: "Autopilot",
  subtasks: "Subtasks",
  workflows: "Workflows",
}

const ICON: Record<ToolName, FluentIcon> = {
  terminal: Console,
  changes: DocumentList,
  autopilot: BranchRequest,
  subtasks: Flowchart,
  workflows: Clock,
}

/**
 * The top bar's tools: what you can open for this task (frontend §6). Each
 * icon opens its tool in the panel and closes it again when it is the one
 * showing; the open one wears the pressed background, no hue.
 *
 * Each carries the small form of its state, so the panel can stay closed:
 * Changes counts files, Subtasks counts children, Workflows counts the ones
 * still watching, the pull-request icon takes its PR's tone (the panel it
 * opens is Autopilot, where that PR's story is), and a shell with a program
 * in the foreground puts a dot on the Terminal, so a finishing test run is
 * visible without opening it. Every count is a query the panel's pane makes
 * anyway: one key, one request.
 *
 * On Desktop the wrapper is part of the window's drag region; the icons are
 * not.
 */
export function TopBarTools({
  task,
  pullRequest,
  dragRegion,
}: {
  task: ApiTask
  pullRequest?: PullRequestStatus
  dragRegion: boolean
}) {
  const controls = useToolPanelControls()
  const features = useHarnessFeatures()
  const diff = useDiff(task.id, task.archived).data
  const workflows = useTaskWorkflows(task.id, features.data?.taskWorkflows === true).data
  const children = useSubtaskCount(task.id)
  const shells = useTaskShells(
    task.id,
    features.data?.taskTerminals === true && !task.archived && task.worktree_path !== null,
  ).data
  if (!controls) return null

  const files = diff?.kind === "ok" ? changedFileCount(parsedDiff(diff).files, diff.untracked) : 0
  const watching = workflows?.filter((workflow) => workflow.state !== "completed").length ?? 0
  const running = shells?.filter((shell) => shell.program !== null && shell.exitCode === null) ?? []
  const found = pullRequest?.kind === "found" ? pullRequest.pullRequest : null

  const count: Partial<Record<ToolName, number>> = { changes: files, subtasks: children, workflows: watching }
  const title: Record<ToolName, string> = {
    terminal: running.length > 0 ? `Terminal (⌃\`) — running ${running.map((shell) => shell.program).join(", ")}` : "Terminal (⌃`)",
    changes: files > 0 ? `Changes — ${files} file${files === 1 ? "" : "s"}` : "Changes",
    autopilot: found ? `Pull request #${found.number} and autopilot` : "Autopilot",
    subtasks: "Subtasks",
    workflows: watching > 0 ? `Workflows — ${watching} watching` : "Workflows",
  }
  // the daemon's features decide the rest; until they answer, the two every daemon has
  const offered = TOOL_NAMES.filter((name) => (controls.available ?? ["terminal", "changes"]).includes(name))

  return (
    <div data-tauri-drag-region={dragRegion ? "" : undefined} className="flex h-full shrink-0 items-center gap-1">
      {offered.map((name) => {
        const Icon = ICON[name]
        const pressed = name === "terminal" ? controls.layout.terminal : controls.layout.tool === name
        const shown = count[name] ?? 0
        return (
          <button
            key={name}
            type="button"
            aria-pressed={pressed}
            title={title[name]}
            onClick={() => controls.toggle(name)}
            className={cn(
              "relative flex h-[26px] min-w-[26px] shrink-0 items-center justify-center gap-1 rounded-md px-1.5 transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              pressed ? "bg-accent text-foreground" : "text-fg-secondary hover:bg-hover hover:text-foreground",
            )}
          >
            <Icon
              aria-hidden
              className={cn(
                "size-4 shrink-0",
                name === "autopilot" && found && PULL_REQUEST_ICON_TONE[pullRequestIconTone(found)],
              )}
            />
            <span className="sr-only">{LABEL[name]}</span>
            {shown > 0 && <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">{shown}</span>}
            {name === "terminal" && running.length > 0 && (
              <span aria-hidden className={cn("absolute top-[3px] right-[3px] size-1.5 rounded-full", STATE_DOT.running)} />
            )}
          </button>
        )
      })}
    </div>
  )
}
