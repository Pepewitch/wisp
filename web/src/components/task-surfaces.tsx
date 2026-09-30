import type { ReactNode } from "react"

import { AutopilotPane } from "@/components/autopilot-pane"
import { ChangesPane } from "@/components/changes-pane"
import { PaneErrorBoundary } from "@/components/error-boundary"
import { FileViewerProvider } from "@/components/file-viewer"
import { TaskPanel } from "@/components/task-panel"
import { TerminalSection } from "@/components/terminal-pane"
import { WorkflowsPane } from "@/components/workflows-pane"
import { revealFileHandler } from "@/lib/external-links"
import type { ApiTask, HarnessesResponse } from "@/lib/types"

export function buildTaskSurfaces({
  mobile,
  features,
  connectionId,
  task,
  taskId,
  archived,
  onRefresh,
}: {
  mobile: boolean
  /** the daemon's feature flags, which decide the surfaces it has; absent reads as none */
  features: HarnessesResponse["features"]
  connectionId: string
  task: ApiTask | null
  taskId: string | null
  archived: boolean
  onRefresh: () => void
}): {
  changes: ReactNode
  /** Touch only: on the desktop, Autopilot is a tab inside `changes`' task panel. */
  autopilot?: { label: "Autopilot" | "Brief"; render: (showConversation: () => void) => ReactNode }
  workflows?: ReactNode
  terminal: ReactNode
} {
  const workflowsSupported = features?.taskWorkflows === true
  const briefsSupported = features?.taskBriefs === true
  const autopilotSupported = features?.taskAutopilot === true
  // The diff pane's double-click opens a file the way a path in prose does,
  // so it gets the same provider. An archived task's worktree is gone, which
  // is exactly what the pane's own "unavailable" note says.
  const changes = (
    <FileViewerProvider
      taskId={archived ? null : taskId}
      onReveal={revealFileHandler(connectionId, task?.worktree_path ?? null)}
    >
      {mobile ? (
        // Keyed by task: switching tasks must not still show the last one's
        // crash while the new one's diff is perfectly readable.
        <PaneErrorBoundary key={taskId ?? "none"} label="the changes">
          <ChangesPane taskId={taskId} archived={archived} onRefresh={onRefresh} touch />
        </PaneErrorBoundary>
      ) : (
        <TaskPanel
          task={task}
          taskId={taskId}
          archived={archived}
          onRefresh={onRefresh}
        />
      )}
    </FileViewerProvider>
  )
  // Its own surface on touch, so it needs the same provider as the diff and
  // a way to bring the chat forward before a find runs against it.
  // A daemon with briefs and no autopilot keeps the tab's old name.
  const autopilot = mobile && (briefsSupported || autopilotSupported)
    ? {
      label: autopilotSupported ? "Autopilot" as const : "Brief" as const,
      render: (showConversation: () => void) => (
        <FileViewerProvider
          taskId={archived ? null : taskId}
          onReveal={revealFileHandler(connectionId, task?.worktree_path ?? null)}
        >
          <AutopilotPane
            key={`${connectionId}:${taskId ?? ""}`}
            task={task}
            touch
            onShowConversation={showConversation}
          />
        </FileViewerProvider>
      ),
    }
    : undefined
  const workflows = workflowsSupported ? (
    <WorkflowsPane
      key={`${connectionId}:${taskId ?? ""}`}
      task={task}
      touch
    />
  ) : undefined
  const terminal = (
    // Keyed by task: a shell that broke rendering task A's terminal must not
    // still show task A's fallback once task B's terminal pane mounts.
    <PaneErrorBoundary key={taskId ?? "none"} label="the terminal">
      <TerminalSection
        taskId={taskId}
        // The list row is what the SSE bridge refreshes. A just-created task has
        // no worktree yet, so the pane waits instead of failing to connect.
        worktreePath={task?.worktree_path ?? null}
        archived={archived}
        touch={mobile}
      />
    </PaneErrorBoundary>
  )
  return { changes, autopilot, workflows, terminal }
}
