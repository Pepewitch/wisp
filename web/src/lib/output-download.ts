import { isTauri } from "@tauri-apps/api/core"
import { desktopBridge } from "./desktop-bridge"

const MAX_BYTES = 8 * 1024 * 1024

/** Native Save panel in Desktop; the already authenticated blob in Browser. */
export async function saveOutputImage(name: string, src: string): Promise<boolean> {
  if (isTauri()) {
    // src belongs to the initiating connection's immutable proxy route. No
    // daemon credential or URL is passed to the native file-writing command.
    const response = await fetch(src, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error("Image unavailable. Refresh the task and retry.")
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Image unavailable.")
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Output image exceeds the 8 MiB limit.") }
        chunks.push(new Uint8Array(value))
      }
    } finally { reader.releaseLock() }
    const data = await new Promise<string>((resolve, reject) => {
      const file = new FileReader()
      file.onerror = () => reject(new Error("Could not read the output image."))
      file.onload = () => resolve(String(file.result).split(",")[1] ?? "")
      file.readAsDataURL(new Blob(chunks))
    })
    return desktopBridge.saveOutputImage(name, data)
  }
  const anchor = document.createElement("a")
  anchor.href = src
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  return true
}
