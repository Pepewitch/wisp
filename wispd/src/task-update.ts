import type { WispConfig } from "./config";
import { emit } from "./events";
import type { PullRequestFound } from "./pull-request-notify";
import { getTask, setTaskFields } from "./store";
import type { Task } from "./types";

/** Creation and manual renames use this UI-safe display-title ceiling. */
export const TASK_TITLE_MAX = 80;

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

/**
 * Apply provider-owned PR metadata without duplicating pull-request selection
 * rules. The cache calls this only after it has chosen the same PR the UI
 * links to. Re-reading the row makes concurrent manual/automatic updates
 * idempotent, archived history remains immutable, and a name the user typed
 * (custom_title) is authority this sync never overrides.
 */
export function syncTaskTitleWithPullRequest(
  cfg: Pick<WispConfig, "autoRenameTasksFromPullRequests">,
  taskId: string,
  pullRequestTitle: string,
): Task | null {
  const task = getTask(taskId);
  if (
    cfg.autoRenameTasksFromPullRequests === false ||
    !task ||
    task.archived ||
    task.custom_title
  ) {
    return task;
  }
  const title = pullRequestTitle.trim().slice(0, TASK_TITLE_MAX);
  if (title === "" || title === task.title) return task;
  return updateTaskAndEmit(task.id, { title }, "title");
}

/**
 * The PR cache's discovery hook, built once per config so production
 * (daemon.ts) and the route-level standalone cache wire identical behavior.
 */
export function pullRequestTitleSync(cfg: WispConfig): PullRequestFound {
  return (task, pullRequest) => syncTaskTitleWithPullRequest(cfg, task.id, pullRequest.title);
}
