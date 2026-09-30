/**
 * Auto-merge and auto-fix responses, as the API serves them. The status and
 * the entry shapes live in `shared/autopilot.ts`, which the daemon's own
 * store also speaks.
 */
import type { AutopilotHistoryEntry } from "../autopilot";

/**
 * GET /api/tasks/:id/autopilot/history, advertised by `features.autopilotHistory`
 * on GET /api/harnesses: newest first, across every time the switches were on.
 */
export interface AutopilotHistoryResponse {
  history: AutopilotHistoryEntry[];
}
