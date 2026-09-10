import {
  readConnectionStorage,
  removeConnectionStorage,
  writeConnectionStorage,
} from "./connection-storage"

const SELECTED_TASK_KEY = "wisp_selected_task"
const SELECTED_TASK_SETTING = "selected_task"

type ListedTask = { id: string; archived: boolean }

/**
 * Keep sidebar focus across list updates without fighting an explicit pick.
 *
 * A just-created task is selected before the list refetch lands, so "not in
 * this snapshot" is not the same as "gone". Drop the selection only when it
 * vanished from a list that already had it, or when a persisted id is absent
 * on first load. An empty selection still opens on the first live row.
 */
export function reconcileSelectedTaskId(
  selectedId: string | null,
  tasks: readonly ListedTask[] | undefined,
  previousTasks: readonly ListedTask[] | undefined
): string | null {
  if (!tasks) return selectedId
  if (selectedId && tasks.some((task) => task.id === selectedId)) return selectedId
  if (selectedId && previousTasks && !previousTasks.some((task) => task.id === selectedId)) {
    return selectedId
  }
  return tasks.find((task) => !task.archived)?.id ?? tasks[0]?.id ?? null
}

/**
 * The task a connection's view opens on. One module owns the key so the view
 * that renders the selection and the desktop focus request that wants to
 * change it before that view mounts agree on where it lives.
 */
export function readSelectedTask(connectionId: string): string | null {
  return readConnectionStorage(
    connectionId,
    SELECTED_TASK_SETTING,
    SELECTED_TASK_KEY
  )
}

export function writeSelectedTask(connectionId: string, taskId: string): void {
  writeConnectionStorage(
    connectionId,
    SELECTED_TASK_SETTING,
    SELECTED_TASK_KEY,
    taskId
  )
}

export function clearSelectedTask(connectionId: string): void {
  removeConnectionStorage(
    connectionId,
    SELECTED_TASK_SETTING,
    SELECTED_TASK_KEY
  )
}
