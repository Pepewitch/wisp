import type {
  DesktopBridge,
  TaskFocusRequest,
  TaskNotificationInput,
} from "./desktop-bridge"
import { stateWord } from "./state"
import { writeSelectedTask } from "./task-selection"
import type { TaskTransition } from "./task-transitions"
import { uiIntentsFor } from "./ui-intents"

/**
 * Desktop-only: a finished turn becomes a macOS notification, and clicking it
 * comes back as a focus request. The browser build never reaches this module
 * because only the desktop connection provider calls it.
 */

/** What the person is already looking at when a transition lands. */
export interface NotificationContext {
  readonly windowFocused: boolean
  readonly activeConnectionId: string
  /** The selected task on the connection being observed, if any. */
  readonly selectedTaskId: string | null
}

/**
 * The one case that is noise: the task is on screen in a focused window. A
 * different tab, a different task, or a background window all deserve the
 * banner, because that is exactly when the sidebar dot goes unseen.
 */
export function shouldNotify(
  connectionId: string,
  taskId: string,
  context: NotificationContext
): boolean {
  return !(
    context.windowFocused &&
    context.activeConnectionId === connectionId &&
    context.selectedTaskId === taskId
  )
}

/** Title is the task; body is the honest state word plus which daemon. */
export function describeTaskTransition(
  transition: TaskTransition,
  connectionName: string
): { title: string; body: string } {
  const title = transition.task.title.trim() || "Untitled task"
  return { title, body: `${stateWord(transition.task)} · ${connectionName}` }
}

/** Post one notification per transition that passes the policy; returns what was sent. */
export function publishTaskTransitions({
  bridge,
  connectionId,
  connectionName,
  transitions,
  context,
}: {
  bridge: Pick<DesktopBridge, "notifyTaskTransition">
  connectionId: string
  connectionName: string
  transitions: readonly TaskTransition[]
  context: NotificationContext
}): TaskNotificationInput[] {
  const sent: TaskNotificationInput[] = []
  for (const transition of transitions) {
    if (!shouldNotify(connectionId, transition.task.id, context)) continue
    const input: TaskNotificationInput = {
      connectionId,
      taskId: transition.task.id,
      ...describeTaskTransition(transition, connectionName),
    }
    sent.push(input)
    // A refused notification (a dev binary outside Wisp.app, permission
    // denied) costs only the banner; the sidebar state is still the truth.
    void bridge.notifyTaskTransition(input).catch(() => undefined)
  }
  return sent
}

/**
 * Land on the task a clicked notification named. The selection is persisted
 * first so a connection switch mounts straight onto it; when that connection
 * is already on screen, the mounted view is asked to move instead.
 */
export function applyTaskFocusRequest(
  request: TaskFocusRequest,
  {
    connectionIds,
    activeConnectionId,
    select,
  }: {
    connectionIds: readonly string[]
    activeConnectionId: string
    select: (connectionId: string) => Promise<void>
  }
): boolean {
  if (!connectionIds.includes(request.connectionId)) return false
  writeSelectedTask(request.connectionId, request.taskId)
  if (request.connectionId === activeConnectionId) {
    uiIntentsFor(request.connectionId).focusTask(request.taskId)
  } else {
    void select(request.connectionId)
  }
  return true
}
