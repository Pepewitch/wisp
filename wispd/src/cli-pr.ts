import type { AutopilotStatus } from "../../shared/autopilot"
import type { Flags } from "./cli-args"
import { wispCommand } from "./command"

type Api = (path: string, method?: string, body?: unknown) => Promise<unknown>

export const PR_USAGE = `usage: ${wispCommand()} pr <task> [merge on|off | fix on|off | resume | send-now | skip] [--json]`

export function formatAutopilot(status: AutopilotStatus): string {
  const pr = status.pr ? ` · PR #${status.pr}` : ""
  if (status.state === "merged") return `auto-merge: done${pr} · ${status.reason}`
  const on = [status.autoMerge && "auto-merge", status.autoFix && "auto-fix"].filter(Boolean).join(" + ")
  // the plain switch-off says nothing the line does not
  const why = status.reason && status.reason !== "Auto-merge off" ? ` · ${status.reason}` : ""
  if (!on) return `auto-merge and auto-fix: off${pr}${why}`
  const rounds = status.autoFix && status.fixRounds > 0 ? ` · fix round ${status.fixRounds}` : ""
  return `${on}: on${pr} · ${status.state} · ${status.reason}${rounds}`
}

/** `wisp pr <task>`: the task's auto-merge status, and the one switch that drives it. */
export async function prCommand(positional: string[], flags: Flags, api: Api): Promise<void> {
  const [task, action, value] = positional
  if (!task) throw new Error(PR_USAGE)
  const path = `/api/tasks/${encodeURIComponent(task)}/autopilot`
  let status: AutopilotStatus
  if (action === undefined) status = await api(path) as AutopilotStatus
  else if (action === "merge" && (value === "on" || value === "off")) status = await api(path, "PUT", { autoMerge: value === "on" }) as AutopilotStatus
  else if (action === "fix" && (value === "on" || value === "off")) status = await api(path, "PUT", { autoFix: value === "on" }) as AutopilotStatus
  else if ((action === "resume" || action === "send-now" || action === "skip") && value === undefined) status = await api(`${path}/${action}`, "POST", {}) as AutopilotStatus
  else throw new Error(PR_USAGE)
  console.log(flags.json ? JSON.stringify(status, null, 2) : formatAutopilot(status))
}
