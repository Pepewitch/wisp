import type { Workflow, WorkflowDecision } from "../../../shared/workflows";

export function evaluateHeartbeat(item: Workflow, checkpoint: Record<string, unknown>): WorkflowDecision {
  return { action: "wake", reason: "Heartbeat due", checkpoint, key: `heartbeat:${item.wakeCount + 1}`, message: String(item.params.prompt) };
}
export function evaluateScheduledSteer(item: Workflow, checkpoint: Record<string, unknown>, now: Date): WorkflowDecision {
  const scheduledAt = String(item.params.scheduledAt);
  if (Date.parse(scheduledAt) > now.getTime()) {
    return { action: "wait", reason: `Scheduled for ${scheduledAt}`, checkpoint };
  }
  return {
    action: "wake",
    reason: "Scheduled steer due",
    checkpoint,
    key: `schedule-steer:${scheduledAt}`,
    message: String(item.params.prompt),
  };
}
