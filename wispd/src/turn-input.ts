import { attachmentPreamble, IMAGE_INPUT_STRATEGIES, type AdapterDef, type ImageInputStrategy } from "./adapters"
import { attachmentKind, type StoredAttachment } from "./attachments"
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

/**
 * Whether this harness's IMAGES travel by path on this turn. Images have
 * native channels almost everywhere (argv, stdin envelope, a live protocol's
 * own image blocks), and a path preamble beside a natively delivered image
 * would just be noise. Everything that is not an image always travels by path.
 */
function imageTravelsByPath(def: AdapterDef): boolean {
  return (
    Boolean(def.imageDelivery) &&
    def.liveInput !== "droid-jsonrpc" &&
    def.liveInput !== "codex-app-server"
  )
}

function isImage(attachment: StoredAttachment): boolean {
  return attachmentKind(attachment.mediaType) === "image"
}

/**
 * The attachments this turn hands over by naming their absolute paths: pdf,
 * text and video always (A1d — no harness CLI has a flag for those, but every
 * harness has file tools), plus images on a delivery harness.
 */
export function pathDeliveredAttachments(
  def: AdapterDef,
  attachments: StoredAttachment[],
): StoredAttachment[] {
  return attachments.filter((attachment) => !isImage(attachment) || imageTravelsByPath(def))
}

/**
 * The images this turn hands over through the harness's own image channel —
 * the only attachments that belong on argv or in a stdin envelope. A pdf in
 * codex's `-i` would be a turn that fails inside the harness.
 */
export function nativeImageAttachments(
  def: AdapterDef,
  attachments: StoredAttachment[],
): StoredAttachment[] {
  return attachments.filter((attachment) => isImage(attachment) && !imageTravelsByPath(def))
}

export function deliveredMessage(
  def: AdapterDef,
  attachments: StoredAttachment[],
  message: string,
): string {
  const byPath = pathDeliveredAttachments(def, attachments)
  if (byPath.length === 0) return message
  return `${attachmentPreamble(byPath)}\n\n${message}`
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
