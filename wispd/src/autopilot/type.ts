/**
 * Autopilot rows live in the `workflows` table, so archive, history, and the
 * agent-switch trigger apply to them for free. They are NOT workflows to the
 * rest of the daemon: no definition, no Workflows picker, no generic scheduler.
 * This module has no imports, so the workflow store can name the type without
 * an import cycle.
 */
export const AUTOPILOT_TYPE = "pr-autopilot"

/** What the SQL trigger writes when a task's agent or context changes (migration 13). */
export const CONTEXT_CHANGE_PAUSE = "Task agent or context changed; review and resume"
