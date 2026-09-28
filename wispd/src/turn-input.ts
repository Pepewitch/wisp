import { attachmentPreamble, IMAGE_INPUT_STRATEGIES, type AdapterDef, type ImageInputStrategy } from "./adapters"
import { attachmentKind, type StoredAttachment } from "./attachments"
import { wispCommand } from "./command"
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
 * The one variable that binds a turn to its brief (brief-store.ts). Named to
 * stay clear of the KEY/SECRET/TOKEN patterns a harness may filter out of its
 * tool environment; it is a scope check, not a credential.
 */
export const BRIEF_RUN_ENV = "WISP_BRIEF_RUN"

/**
 * The single line an eligible turn is given. Short on purpose — the schema,
 * the limits and the example live in `wisp brief --help`, read only when the
 * agent needs them — and scoped to THIS turn, never phrased as a standing
 * session policy, so an agent that remembers it after briefs are switched off
 * was told nothing about later turns.
 */
export function briefReminder(): string {
  const cmd = wispCommand()
  return `Before ending this turn, save a JSON brief with \`${cmd} brief set --stdin\`; help: \`${cmd} brief --help\`.`
}

/**
 * Everything Wisp itself writes into a harness input — the first turn's task
 * preamble, standing notes, the attached-files note — goes out one `[wisp]`
 * line at a time, and a blank line separates it from the person's words. The
 * tag is what tells the agent (and anyone reading a raw prompt) which lines
 * are Wisp's and which the person typed.
 *
 * A line prefix rather than an open/close block: there is nothing to close,
 * nothing a model can leave unclosed, and a person's own message that happens
 * to contain a closing tag cannot end Wisp's section early.
 */
export function wispNoteLines(lines: string[]): string {
  return lines.map((line) => `[wisp] ${line}`).join("\n")
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
  // A brief binding is never inherited. Every child Wisp spawns into a task —
  // a turn, a setup script, a terminal — builds its environment here, so a
  // daemon started from inside some agent's shell cannot hand that agent's
  // binding to anything. The runner adds a turn's OWN binding after this.
  const { [BRIEF_RUN_ENV]: _inherited, ...rest } = env
  return { ...rest, PWD: cwd } as T & { PWD: string }
}

/**
 * The first turn's framing, in Wisp's voice and tagged line by line. It ends
 * with a blank line, so `${preamble}\n${message}` leaves exactly one empty
 * line before the person's words — the same boundary every later turn's
 * notes use.
 */
export function taskPreamble(task: Task, notes: string[] = []): string {
  return `${wispNoteLines([
    `You are working on task ${task.id}, managed by Wisp, in a dedicated git worktree.`,
    `Worktree: ${task.worktree_path} (branch ${task.branch}). Work ONLY inside this directory.`,
    `When you finish the requested work, commit your changes to this branch with a clear message. Do not push unless asked.`,
    `For follow-up after waiting on time or an external condition, use \`${wispCommand()} workflow types\` to choose durable automation instead of relying on a harness background process.`,
    ...notes,
  ])}\n`
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
  return `${wispNoteLines(attachmentPreamble(byPath).split("\n"))}\n\n${message}`
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
