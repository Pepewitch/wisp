import {
  IMAGE_DELIVERY_STRATEGIES,
  IMAGE_INPUT_STRATEGIES,
  type AdapterDef,
  type ImageInputStrategy,
} from "./adapters"
import type { StoredAttachment } from "./attachments"
import type { Task } from "./types"

export function taskEnv(task: Task): Record<string, string> {
  return {
    WISP_TASK_ID: task.id,
    WISP_TASK_SLOT: String(task.slot),
    WISP_WORKTREE: task.worktree_path ?? "",
    WISP_REPO: task.repo_path,
  }
}

export function taskPreamble(task: Task): string {
  return [
    `You are working on task ${task.id}, managed by Wisp, in a dedicated git worktree.`,
    `Worktree: ${task.worktree_path} (branch ${task.branch}). Work ONLY inside this directory.`,
    `When you finish the requested work, commit your changes to this branch with a clear message. Do not push unless asked.`,
    ``,
    `Task:`,
  ].join("\n")
}

export function deliveredMessage(
  def: AdapterDef,
  attachments: StoredAttachment[],
  message: string,
): string {
  if (
    attachments.length === 0 ||
    !def.imageDelivery ||
    def.liveInput === "droid-jsonrpc" ||
    def.liveInput === "codex-app-server"
  ) {
    return message
  }
  const delivery = IMAGE_DELIVERY_STRATEGIES[def.imageDelivery]
  return delivery
    ? `${delivery.preamble(attachments.map((attachment) => attachment.path))}\n\n${message}`
    : message
}

export function inputStrategyFor(
  def: AdapterDef,
  hasImages: boolean,
): ImageInputStrategy | undefined {
  const name =
    def.liveInput === "claude-stream-json"
      ? def.liveInput
      : hasImages
        ? def.imageInput
        : undefined
  return name ? IMAGE_INPUT_STRATEGIES[name] : undefined
}
