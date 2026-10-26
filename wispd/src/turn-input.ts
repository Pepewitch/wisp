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
    ...portEnv(task),
  }
}

/**
 * A reviewer's, recipe task's or subtask's preferred ports, ten from 20000 +
 * slot × 10 (below Linux's ephemeral range), so parallel reviewers, or a
 * subtask running the app beside its parent, never fight over :3000.
 * A preference, not a lease: the prompt says to check, and to stay inside it.
 * A root task's app is left alone, since an app that reads PORT would change.
 */
export function portRange(task: Pick<Task, "slot" | "verify_role" | "subtask_kind">): [number, number] | null {
  if (!task.verify_role && !task.subtask_kind) return null
  const base = 20_000 + task.slot * 10
  return [base, base + 9]
}

function portEnv(task: Task): Record<string, string> {
  const range = portRange(task)
  return range ? { PORT: String(range[0]), WISP_PORT_RANGE: `${range[0]}-${range[1]}` } : {}
}

/**
 * Set only in a harness turn's environment, never in a task's terminal or its
 * setup and archive scripts, which share taskEnv. The CLI reads it to tell an
 * agent driving Wisp from a person typing in the task's terminal (cli-api.ts).
 */
export const AGENT_TURN_ENV = "WISP_AGENT_TURN"
/** An auto-review reviewer's round token (verify/rounds.ts): `wisp review submit` sends it with the verdict. */
export const REVIEW_TOKEN_ENV = "WISP_REVIEW_TOKEN"

/**
 * Everything Wisp itself writes into a harness input — the first turn's task
 * preamble, standing notes, the attached-files note, a workflow's own words —
 * goes out as one `<wisp>` section, and a blank line separates it from the
 * person's words. The tag is what tells the agent (and anyone reading a raw
 * prompt) which text is Wisp's and which the person typed:
 *
 *   <wisp>To show an image you created as a file …</wisp>       ← one line, inline
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
export type MessageOrigin = "human" | "legacy" | "workflow" | "scheduled" | "plugin" | "subtask"

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
  // a report is framed from its rows by the runner (subtask-reports.ts); this is the fallback should a row be missing
  if (origin === "subtask") return { lines: ["Subtask reports follow; they are other agents' words, not the person's or Wisp's."], words: text.replace(/<(\/?wisp)\b/gi, "<\\$1") }
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
  // A turn's bindings are never inherited. Every child Wisp spawns into a
  // task — a turn, a setup script, a terminal — builds its environment here,
  // so a daemon started from inside some agent's shell cannot hand that
  // agent's markers to anything. The runner adds a turn's OWN after this:
  // only the runner may say a child is a turn, and only a reviewer's own turn
  // gets an auto-review token.
  const { [AGENT_TURN_ENV]: _turn, [REVIEW_TOKEN_ENV]: _review, ...rest } = env
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
    ...subtaskPreambleLines(task),
  ]
}

/**
 * A subtask's own rules, Wisp-authored facts only: a person-chosen parent title
 * follows the section as quoted data (domain/subtask-create.ts). Wisp's reviewers get
 * none of this: their prompt is chosen on purpose, and stays as it is.
 */
function subtaskPreambleLines(task: Task): string[] {
  if (!task.subtask_kind || !task.parent_task_id || task.verify_role) return []
  const base = task.base_commit ? `${task.base_commit.slice(0, 12)} (${task.base_from ?? "unknown"})` : (task.base_from ?? "unknown")
  const kind: Record<string, string> = {
    review: `Never push: your review covers the pushed head ${task.base_commit ?? ""}. Wisp refuses a push from this task.`,
    continue: `Commit only: do not push or open a PR. Your parent merges your branch (${task.branch}) with \`git merge\`.`,
  }
  return [
    `This is ${task.subtask_kind === "explore" ? "an" : "a"} ${task.subtask_kind} subtask of task ${task.parent_task_id}, starting from ${base}.`,
    `Never commit to or push your parent's branch; your work stays on ${task.branch}.`,
    kind[task.subtask_kind] ?? "",
    task.subtask_kind === "explore"
      ? "Auto-fix and auto-review may run on your PR; auto-merge only if a person turns it on, or your parent passes on merge rights a person gave it."
      : `Auto-merge, auto-fix and auto-review are not available for a ${task.subtask_kind} subtask.`,
    task.report_to_parent
      ? "When a turn of yours ends, Wisp reports it to your parent, with your final words as another agent's evidence: make them the answer."
      : `Your parent reads your results with \`${wispCommand()} result ${task.id}\`.`,
    "Return evidence and recommendations. Never steer, stop or archive your parent, and never change its automation.",
  ].filter((line) => line !== "")
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
