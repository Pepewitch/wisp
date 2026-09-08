import { emit } from "../events";
import { getTask, setTaskFields } from "../store";
import type { Task } from "../types";

/** Persist metadata and publish the resulting task row after the write commits. */
export function updateTaskAndEmit(
  taskId: string,
  fields: Parameters<typeof setTaskFields>[1],
  metadata?: "title",
): Task | null {
  setTaskFields(taskId, fields);
  const updated = getTask(taskId);
  if (!updated) return null;
  emit({
    type: "task",
    taskId,
    state: updated.state,
    stateDetail: updated.state_detail,
    seq: updated.seq,
    ...(metadata === "title" ? { title: updated.title, updatedAt: updated.updated_at } : {}),
  });
  return updated;
}
