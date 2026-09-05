import type { UpdateStatus } from "@/lib/types"

const RESTART_TIMEOUT_MS = 5 * 60 * 1000
const RESTART_POLL_MS = 500
const STATUS_POLL_MS = 2_000

export interface WaitForUpdatedDaemonOptions {
  request?: typeof fetch
  timeoutMs?: number
  pollMs?: number
}

async function requestBefore(
  request: typeof fetch,
  path: string,
  deadline: number,
): Promise<Response> {
  const timeoutMs = Math.min(5_000, deadline - Date.now())
  if (timeoutMs <= 0) throw new DOMException("Update wait expired", "TimeoutError")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await request(path, { cache: "no-store", signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The POST response comes from the old process. Wait across its shutdown until
 * the supervisor starts a daemon that proves the requested build is live.
 */
export async function waitForUpdatedDaemon(
  expectedVersion: string,
  options: WaitForUpdatedDaemonOptions = {},
): Promise<void> {
  const request = options.request ?? fetch
  const timeoutMs = options.timeoutMs ?? RESTART_TIMEOUT_MS
  const pollMs = options.pollMs ?? RESTART_POLL_MS
  const deadline = Date.now() + timeoutMs
  let nextStatusCheck = 0

  while (Date.now() <= deadline) {
    try {
      const health = await requestBefore(request, "/api/health", deadline)
      if (health.ok) {
        const body = (await health.json()) as { version?: unknown }
        if (body.version === expectedVersion) return
      }

      if (Date.now() >= nextStatusCheck) {
        nextStatusCheck = Date.now() + STATUS_POLL_MS
        const update = await requestBefore(request, "/api/update", deadline)
        if (update.ok) {
          const status = (await update.json()) as UpdateStatus
          if (status.state === "failed") throw new Error(status.message ?? "update failed")
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("update failed")) throw error
      // A refused connection is the expected gap between old and new daemon.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error(`Wisp ${expectedVersion} did not start within ${Math.round(timeoutMs / 1000)} seconds`)
}
