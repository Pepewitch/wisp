import type { ReactNode } from "react"

import { ChangesPane } from "@/components/changes-pane"
import { FileViewerProvider } from "@/components/file-viewer"
import { BriefPane } from "@/components/task-brief"
import { TaskPanel } from "@/components/task-panel"
import { TerminalSection } from "@/components/terminal-pane"
import { WorkflowsPane } from "@/components/workflows-pane"
import { revealFileHandler } from "@/lib/external-links"
import type { ApiTask } from "@/lib/types"

export function buildTaskSurfaces({
  mobile,
  workflowsSupported,
  briefsSupported,
  connectionId,
  task,
  taskId,
  archived,
  onRefresh,
}: {
  mobile: boolean
  workflowsSupported: boolean
  briefsSupported: boolean
  connectionId: string
  task: ApiTask | null
  taskId: string | null
  archived: boolean
  onRefresh: () => void
}): {
  changes: ReactNode
  /** Touch only: the desktop Brief is a tab inside `changes`' task panel. */
  brief?: (showConversation: () => void) => ReactNode
  workflows?: ReactNode
  terminal: ReactNode
} {
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
  // Its own surface on touch, so it needs the same provider as the diff and
  // a way to bring the chat forward before a find runs against it.
  const brief = mobile && briefsSupported
    ? (showConversation: () => void) => (
      <FileViewerProvider
        taskId={archived ? null : taskId}
        onReveal={revealFileHandler(connectionId, task?.worktree_path ?? null)}
      >
        <BriefPane
          key={`${connectionId}:${taskId ?? ""}`}
          task={task}
          touch
          onShowConversation={showConversation}
        />
      </FileViewerProvider>
    )
    : undefined
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
  return { changes, brief, workflows, terminal }
}
