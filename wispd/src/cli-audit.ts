import type { TaskAuditEntry, TaskAuditResponse } from "../../shared/api/task-audit"
import type { Flags } from "./cli-args"
import { print, printJson } from "./cli-print"
import { wispCommand } from "./command"
import { controlFree } from "./control-free"

type Api = (path: string, method?: string, body?: unknown) => Promise<unknown>

export const AUDIT_USAGE = `usage: ${wispCommand()} audit <task> [--limit <1-500>] [--json]`

/** One action per line: when, what, who, and what it was about. */
export function formatAudit(entries: TaskAuditEntry[]): string {
  if (entries.length === 0) return "nothing recorded for this task yet"
  return entries.map((entry) => [
    entry.at.replace(/\.\d+Z$/, "Z"), entry.action.padEnd(18), controlFree(entry.actor).padEnd(14),
    entry.detail === null ? "" : controlFree(entry.detail).replace(/\s+/g, " "),
  ].join("  ").trimEnd()).join("\n")
}

/** `wisp audit <task>`: who did what to the task, newest first. */
export async function auditCommand(positional: string[], flags: Flags, api: Api): Promise<void> {
  const [task, extra] = positional
  if (!task || extra !== undefined || flags.limit === true) throw new Error(AUDIT_USAGE)
  const limit = typeof flags.limit === "string" ? `?limit=${encodeURIComponent(flags.limit)}` : ""
  const { entries } = await api(`/api/tasks/${encodeURIComponent(task)}/audit${limit}`) as TaskAuditResponse
  if (flags.json) printJson(entries)
  else print(formatAudit(entries))
}
