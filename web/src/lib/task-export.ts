import { isTauri } from "@tauri-apps/api/core"
import { desktopBridge } from "./desktop-bridge"
export { decodeTaskExport } from "../../../shared/task-export"

/** Native Save panel in Desktop; a regular download in the browser. */
export async function saveTaskExport(
  taskId: string,
  data: string
): Promise<boolean> {
  if (isTauri()) return desktopBridge.saveTaskExport(taskId, data)
  const url = URL.createObjectURL(
    new Blob([data], { type: "application/json" })
  )
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `wisp-task-${taskId}.json`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return true
}
