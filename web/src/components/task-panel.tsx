import { ChangesPane } from "@/components/changes-pane"
import { PaneErrorBoundary } from "@/components/error-boundary"
import { AutopilotPane } from "@/components/autopilot-pane"
import { SubtasksPane } from "@/components/subtasks-pane"
import { WorkflowsPane } from "@/components/workflows-pane"
import { useHarnessFeatures } from "@/hooks/queries"
import type { PanelTool } from "@/hooks/useToolPanel"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask } from "@/lib/types"

/**
 * The tool panel's upper half: the views of a task's durable state that the
 * top bar's icons open — **Autopilot** (where it stands, and what auto-merge,
 * auto-fix and auto-review are doing about it), its **Changes**, the
 * **Workflows** watching it, and its **Subtasks**. One shows at a time
 * (`view`); the Terminal docks below it (`panes.tsx`).
 *
 * There is no tab strip any more: the top bar's icons are the switch, and
 * each pane draws its own label and a close control.
 *
 * All panes stay mounted. Opening Workflows and going back to Changes must
 * not close the diff you had open, and closing the panel must not either —
 * the same rule the mobile shell's tabs follow. A pane this daemon has no
 * feature for (`taskAutopilot`, `taskWorkflows`, `subtasks`) is not mounted.
 */
export function TaskPanel({
  task,
  taskId,
  archived,
  onRefresh,
  view,
  onClose,
}: {
  task: ApiTask | null
  taskId: string | null
  archived: boolean
  onRefresh?: () => void
  /** the tool on screen; null while the panel shows only the Terminal, or nothing */
  view: PanelTool | null
  onClose?: () => void
}) {
  const { connectionId } = useDaemonRuntime()
  const features = useHarnessFeatures()
  const workflowsSupported = Boolean(features.data?.taskWorkflows)
  const autopilotSupported = Boolean(features.data?.taskAutopilot)
  const subtasksSupported = features.data?.subtasks === true

  // Which panes exist depends on the daemon. Painting before that is known
  // would show a remembered Autopilot as nothing, then as itself.
  if (features.isPending) return <div className="h-full min-h-0 flex-1" />

  return (
    // h-full AND flex-1: this root fills a resizable panel (which sets a
    // height) as well as a flex column (which does not) — frontend reference §6b
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {autopilotSupported && (
        <AutopilotPane
          // a task's autopilot history belongs to ONE task on ONE daemon; the
          // prefix keeps it apart from its siblings, whose keys would otherwise be identical
          key={`autopilot:${connectionId}:${taskId ?? ""}`}
          task={task}
          hidden={view !== "autopilot"}
          onClose={onClose}
        />
      )}
      {/* Keyed like its siblings: a diff that broke rendering one task must not
          still show that fallback once the panel points at another. */}
      <PaneErrorBoundary key={`changes:${connectionId}:${taskId ?? ""}`} label="the changes">
        <ChangesPane
          taskId={taskId}
          archived={archived}
          onRefresh={onRefresh}
          hidden={view !== "changes"}
          onClose={onClose}
        />
      </PaneErrorBoundary>
      {workflowsSupported && (
        <WorkflowsPane
          // a drill-down belongs to ONE task on ONE daemon: switching either
          // must not leave a half-filled form pointing at the wrong place
          key={`workflows:${connectionId}:${taskId ?? ""}`}
          task={task}
          hidden={view !== "workflows"}
          onClose={onClose}
        />
      )}
      {subtasksSupported && (
        <SubtasksPane
          key={`subtasks:${connectionId}:${taskId ?? ""}`}
          task={task}
          hidden={view !== "subtasks"}
          onClose={onClose}
        />
      )}
    </div>
  )
}
