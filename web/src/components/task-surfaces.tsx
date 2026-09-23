import type { ReactNode } from "react"

import { ChangesPane } from "@/components/changes-pane"
import { FileViewerProvider } from "@/components/file-viewer"
import { TaskPanel } from "@/components/task-panel"
import { TerminalSection } from "@/components/terminal-pane"
import { WorkflowsPane } from "@/components/workflows-pane"
import { revealFileHandler } from "@/lib/external-links"
import type { ApiTask } from "@/lib/types"

export function buildTaskSurfaces({
  mobile,
  workflowsSupported,
  connectionId,
  task,
  taskId,
  archived,
  onRefresh,
}: {
  mobile: boolean
  workflowsSupported: boolean
  connectionId: string
  task: ApiTask | null
  taskId: string | null
  archived: boolean
  onRefresh: () => void
}): { changes: ReactNode; workflows?: ReactNode; terminal: ReactNode } {
  // The diff pane's double-click opens a file the way a path in prose does,
  // so it gets the same provider. An archived task's worktree is gone, which
  // is exactly what the pane's own "unavailable" note says.
  const changes = (
    <FileViewerProvider
      taskId={archived ? null : taskId}
      onReveal={revealFileHandler(connectionId, task?.worktree_path ?? null)}
    >
      {mobile ? (
        <ChangesPane taskId={taskId} archived={archived} onRefresh={onRefresh} touch />
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
  const workflows = workflowsSupported ? (
    <WorkflowsPane
      key={`${connectionId}:${taskId ?? ""}`}
      task={task}
      touch
    />
  ) : undefined
  const terminal = (
    <TerminalSection
      taskId={taskId}
      // The list row is what the SSE bridge refreshes. A just-created task has
      // no worktree yet, so the pane waits instead of failing to connect.
      worktreePath={task?.worktree_path ?? null}
      archived={archived}
      touch={mobile}
    />
  )
  return { changes, workflows, terminal }
}
