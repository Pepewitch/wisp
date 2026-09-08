import {
  readConnectionStorage,
  removeConnectionStorage,
  writeConnectionStorage,
} from "./connection-storage"

const SELECTED_TASK_KEY = "wisp_selected_task"
const SELECTED_TASK_SETTING = "selected_task"

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
