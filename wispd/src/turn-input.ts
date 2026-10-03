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
 * Set only in a harness turn's environment, never in a task's terminal or its
 * setup and archive scripts, which share taskEnv. The CLI reads it to tell an
 * agent driving Wisp from a person typing in the task's terminal (cli-api.ts).
 */
export const AGENT_TURN_ENV = "WISP_AGENT_TURN"

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
 * preamble, standing notes, the attached-files note, a workflow's own words —
 * goes out as one `<wisp>` section, and a blank line separates it from the
 * person's words. The tag is what tells the agent (and anyone reading a raw
 * prompt) which text is Wisp's and which the person typed:
 *
 *   <wisp>Before ending this turn, save a JSON brief …</wisp>   ← one line, inline
 *
 *   <wisp>                                                      ← several lines, one block
 *   You are working on task …
 *   …
 *   </wisp>
 *
 * One form for any length, in the delimiter models read most reliably. A
 * literal `</wisp>` inside (a file name, a PR title) is escaped to `<\/wisp>`,
 * so nothing Wisp relays can close the section early.
 */
export function wispSection(lines: string[]): string {
  if (lines.length === 0) return ""
  const safe = lines.map((line) => line.replace(/<\/wisp>/gi, "<\\/wisp>"))
  return safe.length === 1 ? `<wisp>${safe[0]}</wisp>` : ["<wisp>", ...safe, "</wisp>"].join("\n")
}

/** Wisp's section, a blank line, then the person's words — or just one of the two when the other is empty. */
export function withWispSection(lines: string[], message: string): string {
  if (lines.length === 0) return message
  return message === "" ? wispSection(lines) : `${wispSection(lines)}\n\n${message}`
}

/** Who wrote a queued message, fixed when it was created (store-messages). */
export type MessageOrigin = "human" | "legacy" | "workflow" | "scheduled" | "plugin"

/**
 * How a message's own text joins its input's one Wisp section. The stored
 * text is never changed — the transcript shows what was written — so the
 * framing is decided here, at delivery, from who wrote it:
 *
 *  - `workflow`: Wisp's own words (an auto-fix round, a heartbeat wake), so
 *    all of it goes inside the section.
 *  - `scheduled`: the person's words, sent on their schedule — one Wisp line
 *    says so and the words stay outside.
 *  - `plugin`: a workflow plugin's wake — its control lines (everything
 *    before the first blank line) are Wisp's; its report is neither Wisp's
 *    nor the person's, and a Wisp line says whose it is.
 *
 * A `/command` is never framed: a harness only treats input as a command when
 * it starts with `/`.
 */
export function framedMessage(origin: MessageOrigin | undefined, text: string): { lines: string[]; words: string } {
  if (text.trimStart().startsWith("/")) return { lines: [], words: text }
  if (origin === "workflow") return { lines: text.split("\n"), words: "" }
  if (origin === "scheduled") return { lines: ["scheduled steer"], words: text }
  if (origin === "plugin") {
    const split = text.indexOf("\n\n")
    const control = split < 0 ? [] : text.slice(0, split).split("\n")
    // relayed data (a PR comment, a CI log): it may not open or close a Wisp section of its own
    const report = (split < 0 ? text : text.slice(split + 2)).replace(/<(\/?wisp)\b/gi, "<\\$1")
    return { lines: [...control, "The workflow's report follows; it is not the person's words."], words: report }
  }
  return { lines: [], words: text }
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
  // The agent-turn marker is dropped for the same reason: only the runner
  // may say a child is a turn.
  const { [BRIEF_RUN_ENV]: _inherited, [AGENT_TURN_ENV]: _turn, ...rest } = env
  return { ...rest, PWD: cwd } as T & { PWD: string }
}

/** An explicit turn number also works when the harness process is reused. */
export function outputReminder(turn: number): string {
  return `To show an image you created as a file in the task reply, run ${wispCommand()} output add <image-path> --turn ${turn}. This copies it into task-owned storage for inline preview and download. Publish only images you intend to share (PNG, JPEG, GIF or WebP, up to 8 MiB each).`;
}

/** The first turn's framing, in Wisp's voice; the runner puts it in the turn's one Wisp section. */
export function taskPreambleLines(task: Task): string[] {
  return [
    `You are working on task ${task.id}, managed by Wisp, in a dedicated git worktree.`,
    `Worktree: ${task.worktree_path} (branch ${task.branch}). Work ONLY inside this directory.`,
    `When you finish the requested work, commit your changes to this branch with a clear message. Do not push unless asked.`,
    `For follow-up after waiting on time or an external condition, use \`${wispCommand()} workflow types\` to choose durable automation instead of relying on a harness background process.`,
  ]
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

/** The attached-files note for files that reach the harness by path; none when nothing does. */
export function attachmentLines(def: AdapterDef, attachments: StoredAttachment[]): string[] {
  const byPath = pathDeliveredAttachments(def, attachments)
  return byPath.length === 0 ? [] : attachmentPreamble(byPath).split("\n")
}

/** A steer's whole input: its own framing and attached-files note, and no other Wisp text. */
export function deliveredMessage(
  def: AdapterDef,
  attachments: StoredAttachment[],
  message: string,
  origin?: MessageOrigin,
): string {
  const framed = framedMessage(origin, message)
  return withWispSection([...framed.lines, ...attachmentLines(def, attachments)], framed.words)
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
