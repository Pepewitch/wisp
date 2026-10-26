import { TOOL_ICON, TOOL_LABEL, useToolHints } from "@/components/tool-hints"
import { useToolPanelControls } from "@/hooks/useToolPanel"
import { PULL_REQUEST_ICON_TONE, pullRequestIconTone } from "@/lib/pull-request-tone"
import { STATE_DOT } from "@/lib/state"
import { TOOL_NAMES, type ToolName } from "@/lib/tools"
import type { ApiTask, PullRequestStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The top bar's tools: what you can open for this task (frontend §6). Each
 * icon opens its tool in the panel and closes it again when it is the one
 * showing; the open one wears the pressed background, no hue.
 *
 * Each carries the small form of its state (tool-hints.ts), so the panel
 * can stay closed: a count beside the icon, the PR's tone on the Autopilot
 * icon, and a dot on the Terminal while a shell runs a program.
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
  const { count, running, pullRequest: found } = useToolHints(task, pullRequest)
  if (!controls) return null

  const files = count.changes ?? 0
  const watching = count.workflows ?? 0
  const title: Record<ToolName, string> = {
    terminal: running.length > 0 ? `Terminal (⌃\`) — running ${running.join(", ")}` : "Terminal (⌃`)",
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
        const Icon = TOOL_ICON[name]
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
            <span className="sr-only">{TOOL_LABEL[name]}</span>
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
