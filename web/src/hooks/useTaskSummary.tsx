import type { ReactNode } from "react"

import type { SwitchesModel } from "@/components/autopilot-pane"
import { TaskTokensReport } from "@/components/tokens-panel"
import { useAutopilot } from "@/hooks/mutations"
import { useHarnessFeatures } from "@/hooks/queries"
import { useSubtaskChildren } from "@/hooks/useSubtasks"
import { useToolPanelControls } from "@/hooks/useToolPanel"
import { failureReason } from "@/lib/api"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ToolName } from "@/lib/tools"
import type { ApiTask, ConversationDetail, PullRequestStatus, Turn } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"

/**
 * Everything the card says about one task, gathered once. The card and the
 * chip's popover draw the same model, and the gallery draws it from fixtures.
 * Every fact comes from a read the app already makes: the task row, the PR
 * status the sidebar shares, the live task list for the children, and the
 * `/tokens` key only while the Context row is open.
 */
export interface SummaryModel {
  task: ApiTask
  /** undefined until the forge answers; an origin with no forge has no row */
  pullRequest?: PullRequestStatus
  /** the running turn's start, for the lead row's clock */
  runningSince: string | null
  /** when the latest turn ended, for "4 min ago" once nothing runs */
  settledAt: string | null
  /** the harness is blocked on a question the conversation shows */
  questionWaiting: boolean
  /** null on a daemon without autopilot: no row */
  autopilot: { switches: SwitchesModel; reviewable: boolean } | null
  /** the live children; null on a daemon without subtasks */
  children: Pick<ApiTask, "id" | "title" | "state" | "subtask_kind" | "background">[] | null
  /** the Context row's report, mounted only while that row is open */
  tokens: ReactNode
  /** a question is waiting: bring it on screen */
  onJumpToQuestion: () => void
  onOpenTask: (id: string) => void
  /** null where there is no tool panel to open (the gallery) */
  onOpenTool: ((name: ToolName) => void) | null
}

/** The model, from the reads the app already makes for the selected task. */
export function useTaskSummary(task: ApiTask, pullRequest: PullRequestStatus | undefined, turns: Turn[] | undefined): SummaryModel {
  const { connectionId } = useDaemonRuntime()
  const features = useHarnessFeatures().data
  const autopilot = useAutopilot()
  const sentHere = autopilot.variables?.id === task.id
  const tools = useToolPanelControls()
  const children = useSubtaskChildren(task.id)
  const intents = uiIntentsFor(connectionId)
  const latest = turns?.at(-1)
  return {
    task,
    pullRequest,
    runningSince: turns?.find((turn) => turn.status === "running")?.started_at ?? null,
    settledAt: latest?.ended_at ?? null,
    // the conversation detail carries it; the list row alone does not
    questionWaiting: Boolean((task as Partial<ConversationDetail>).pending_question_id),
    autopilot: features?.taskAutopilot === true ? {
      switches: {
        status: task.autopilot ?? null,
        locked: task.archived ? "archived" : task.mode === "local" ? "local" : null,
        // the card stays mounted across tasks: a write in flight, or one that
        // failed, belongs to the task that sent it, never to the next one shown
        pending: sentHere && autopilot.isPending,
        error: sentHere && autopilot.error ? failureReason(autopilot.error) : null,
        onSet: (change) => autopilot.mutate({ id: task.id, set: change }),
        onAct: (act) => autopilot.mutate({ id: task.id, act }),
      },
      reviewable: features.autoReview === true,
    } : null,
    children: features?.subtasks === true ? children : null,
    tokens: <TaskTokensReport task={task} turns={turns} />,
    // the transcript follows its live end, and a waiting question is there
    onJumpToQuestion: () => intents.focusStream(),
    onOpenTask: (id) => intents.focusTask(id),
    onOpenTool: tools ? (name) => tools.show(name) : null,
  }
}
