/**
 * Who did what to a task, from `GET /api/tasks/:id/audit` (newest first).
 *
 * An actor is one of:
 * - `web`, `desktop`, `cli`: the client that sent the request;
 * - `agent:<taskId>`: the CLI run by an agent during one of that task's turns
 *   (a person typing in the task's terminal is `cli`);
 * - `autopilot`, `workflow:<id>`: the daemon acting for a switch the owner armed;
 * - `system`: the daemon on its own account (boot recovery and the like);
 * - `api`: a caller that did not say which client it is.
 *
 * The client part is the caller's own report (the `X-Wisp-Client` header), so
 * it answers "which client did this" for accountability. It is not
 * authentication: every client holds the same token and can claim any name.
 */
export type TaskAuditActor = string

export const TASK_AUDIT_ACTIONS = [
  "create",
  "rename",
  "send",
  "steer",
  "send-now",
  "edit",
  "cancel",
  "answer",
  "interrupt",
  "compact",
  "archive",
  "force-archive",
  "cleanup",
  "fresh-session",
  "push",
  "autopilot",
  "autopilot-resume",
  "autopilot-skip",
  "autopilot-send-now",
  "workflow-start",
  "workflow-update",
  "workflow-pause",
  "workflow-resume",
  "workflow-complete",
  "merge",
  "fail",
] as const

export type TaskAuditAction = (typeof TASK_AUDIT_ACTIONS)[number]

export interface TaskAuditEntry {
  /** ISO-8601 */
  at: string
  action: TaskAuditAction
  actor: TaskAuditActor
  /** what it was about: a message id, a PR, which switches; null when the action says it all */
  detail: string | null
}

export interface TaskAuditResponse {
  entries: TaskAuditEntry[]
}
