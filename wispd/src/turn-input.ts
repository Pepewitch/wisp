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

/**
 * The environment for a child spawned into `cwd`, with PWD made to agree.
 *
 * The daemon inherits a PWD from whatever directory it was started in, and
 * `{...process.env}` would hand that stale value to every child — naming a
 * directory outside the task's worktree entirely.
 *
 * That is not a cosmetic disagreement. Caught live on 2026-09-10 during the
 * opencode bring-up: opencode resolves its project root as
 * `process.env.PWD ?? process.cwd()` — PWD FIRST — so a turn spawned with
 * cwd=<worktree> globbed and read the daemon's launch directory instead, and
 * the worktree isolation Wisp's whole model rests on was silently not in
 * effect. PWD is a shell convention that is supposed to track cwd, so it is
 * corrected for every harness here rather than worked around in one adapter's
 * argv, and it is derived from the SAME `cwd` value passed to the spawn so the
 * two cannot drift apart.
 */
export function envForCwd<T extends Record<string, string | undefined>>(env: T, cwd: string): T & { PWD: string } {
  return { ...env, PWD: cwd }
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
