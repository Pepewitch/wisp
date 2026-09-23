/**
 * The autopilot loop: for each armed task, bind it to its pull request, ask
 * GitHub where that PR stands, and merge it once the gate allows.
 *
 * It never decides anything mid-turn. A busy task is only checked on a slow
 * cadence, and only to notice that its PR was merged or closed by someone
 * else; the moment the task settles, an event brings its row forward.
 */
import type { AutopilotState } from "../../../shared/autopilot"
import type { AdapterDef } from "../adapters"
import { repoConfigFor, type WispConfig } from "../config"
import { subscribe } from "../events"
import { homeIsDraining, trackHomeWork } from "../home-lifetime"
import { bunProbeSpawn } from "../probes"
import { taskBranches } from "../pull-request-branches"
import { githubRepository } from "../pull-request-github"
import { startNextQueuedMessage } from "../runner"
import { getTask, nextQueuedMessage, runningTurn } from "../store"
import { backgroundWork, processStopPending } from "../task-processes"
import { isTaskStopping } from "../turn-interrupt"
import type { Task } from "../types"
import { changeWorkflowState, getWorkflow, recordWorkflow, type WorkflowRow } from "../workflows/store"
import { mergeGate, type PublishedWork } from "./gate"
import { ghAutopilot, type AutopilotGitHub, type OpenPullRequest, type PrSnapshot } from "./github"
import { whileMerging } from "./merging"
import { publishedWork } from "./published"
import {
  checkAutopilotSoon, checkpointOf, dueAutopilots, finishAutopilot, paramsOf, pauseAutopilot,
  saveAutopilotCheck, writeAutopilotCheckpoint, type AutopilotCheckpoint,
} from "./store"

/** Something that moves on its own: checks running, a fresh head, a merge queue. */
export const MOVING_MS = 60_000
/** Blocked on a person, or no PR yet. The settle event still brings it forward. */
export const WAITING_ON_YOU_MS = 5 * 60_000
/** A busy task: only a lifecycle look, for a PR someone else merged or closed. */
export const BUSY_MS = 20 * 60_000
const REQUIRED_TTL_MS = 10 * 60_000
const MERGE_FAILURE_LIMIT = 3

export interface AutopilotRuntimeOptions {
  now?: () => Date
  github?: AutopilotGitHub
  published?: (task: Task, branch: string, head: string, signal: AbortSignal) => Promise<PublishedWork>
  repository?: (task: Task, signal: AbortSignal) => Promise<string | null>
  branches?: (task: Task, signal: AbortSignal) => Promise<string[]>
}

/** Settled `done`, with nothing queued, stopping, or still running in the background. */
export function taskIsIdle(task: Task): boolean {
  return task.state === "done" && !task.archived && !runningTurn(task.id) && !nextQueuedMessage(task.id) &&
    !isTaskStopping(task.id) && !processStopPending(task.id) && backgroundWork(task.id).state === "none"
}

function busyReason(task: Task): string {
  switch (task.state) {
    case "needs-input": return "Waiting for your answer"
    case "failed": return "The task failed — waiting for you"
    case "stuck": return "The task is stuck — waiting for you"
    case "creating": return "Waiting for the task to start"
    case "running": return "Waiting for the task to finish"
    default: return backgroundWork(task.id).state !== "none" ? "Waiting for the task's background work" : "Waiting for the task to finish"
  }
}

async function originRepository(task: Task, signal: AbortSignal): Promise<string | null> {
  const origin = await Promise.resolve()
    .then(() => bunProbeSpawn(["git", "remote", "get-url", "origin"], { cwd: task.repo_path, signal }))
    .catch(() => null)
  return origin && origin.exitCode === 0 ? githubRepository(origin.stdout) : null
}

function choosePull(pulls: OpenPullRequest[], allowedBases: ReadonlySet<string>): OpenPullRequest | null {
  const own = pulls.filter((pull) => !pull.isCrossRepository).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number)
  // The oldest PR onto the base first, so a stacked child never jumps its parent.
  return own.find((pull) => allowedBases.has(pull.baseRefName)) ?? own[0] ?? null
}

function trimHeads(heads: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(heads).sort((a, b) => a[1].localeCompare(b[1])).slice(-5))
}

export class AutopilotRuntime {
  private pending: Promise<void> | null = null
  private stopped = false
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private readonly now: () => Date
  private readonly github: AutopilotGitHub
  private readonly required = new Map<string, { names: string[]; at: number }>()

  constructor(private cfg: WispConfig, private adapters: Record<string, AdapterDef>, private options: AutopilotRuntimeOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.github = options.github ?? ghAutopilot
  }

  start(): void {
    const kick = (): void => { void trackHomeWork(this.tick()).catch(() => console.error("[wisp] autopilot check failed")) }
    this.timer = setInterval(kick, 10_000)
    this.timer.unref?.()
    // A task that settles is the moment auto-merge usually has something to do.
    this.unsubscribe = subscribe((event) => {
      if (event.type === "task" && event.state === "done" && checkAutopilotSoon(event.taskId, this.now())) kick()
    })
    kick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.controller.abort()
    if (this.timer) clearInterval(this.timer)
    this.unsubscribe?.()
    await this.pending
  }

  tick(): Promise<void> {
    if (this.stopped || homeIsDraining()) return Promise.resolve()
    if (this.pending) return this.pending
    this.pending = this.runDue().finally(() => { this.pending = null })
    return this.pending
  }

  private async runDue(): Promise<void> {
    const rows = dueAutopilots(this.now())
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
      while (cursor < rows.length && !this.stopped && !homeIsDraining()) await this.evaluate(rows[cursor++]!)
    }))
  }

  private async evaluate(row: WorkflowRow): Promise<void> {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    this.controller.signal.addEventListener("abort", abort, { once: true })
    const timeout = setTimeout(abort, 90_000)
    try {
      await this.decide(row, controller.signal)
    } catch (error) {
      if (this.stopped || homeIsDraining()) return
      const current = getWorkflow(row.id)
      if (!current || current.state !== "active") return
      const failures = current.failures + 1
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 200)
      saveAutopilotCheck(current, {
        state: "waiting", reason: message.startsWith("GitHub") ? message : `Check failed: ${message}`,
        checkpoint: checkpointOf(current), failures,
        delayMs: Math.min(MOVING_MS * 2 ** Math.min(failures, 5), 30 * 60_000),
      }, this.now())
    } finally {
      clearTimeout(timeout)
      this.controller.signal.removeEventListener("abort", abort)
    }
  }

  private async decide(row: WorkflowRow, signal: AbortSignal): Promise<void> {
    const now = this.now()
    if (row.state === "paused") {
      // the agent-switch trigger paused it; autopilot follows the task instead
      changeWorkflowState(row.id, "active", "Followed the task's agent change", now)
      return
    }
    const task = getTask(row.task_id)
    if (!task || task.archived) { changeWorkflowState(row.id, "completed", "Task archived", now); return }
    if (!paramsOf(row).autoMerge) { changeWorkflowState(row.id, "completed", "Auto-merge off", now); return }
    const checkpoint: AutopilotCheckpoint = checkpointOf(row)
    const idle = taskIsIdle(task)
    const save = (state: AutopilotState, reason: string, delayMs: number) =>
      saveAutopilotCheck(row, { state, reason, checkpoint, delayMs }, this.now())

    if (checkpoint.stopHold) {
      if (idle && task.turn_count > checkpoint.stopHold.turnCount) delete checkpoint.stopHold
      else { save("held", "Held — you pressed Stop; continues after your next turn", BUSY_MS); return }
    }

    const repository = await (this.options.repository ?? originRepository)(task, signal)
    if (!repository) { save("needs-you", "Not a GitHub repository", BUSY_MS); return }
    const cwd = task.repo_path
    const configured = repoConfigFor(this.cfg, task.repo_path)?.baseBranch?.replace(/^origin\//, "")

    if (!checkpoint.pr) {
      if (!idle) { save("waiting", busyReason(task), BUSY_MS); return }
      const branches = await (this.options.branches ?? ((t, s) => taskBranches(t, bunProbeSpawn, s)))(task, signal)
      const { defaultBranch, pulls } = await this.github.openPullRequests(repository, branches, cwd, signal)
      const pick = choosePull(pulls, new Set([defaultBranch, configured].filter((b): b is string => Boolean(b))))
      if (!pick) { save("waiting", "Waiting for a PR", WAITING_ON_YOU_MS); return }
      checkpoint.pr = pick.number
      recordWorkflow(row.id, "bound", `Watching PR #${pick.number}`, now.toISOString())
    }

    const pr = await this.github.snapshot(repository, checkpoint.pr, cwd, signal)
    if (pr.state !== "OPEN") { this.settle(row, checkpoint, pr); return }
    if (pr.isCrossRepository) { save("needs-you", "Fork pull requests are not supported", BUSY_MS); return }
    if (pr.providerAutoMerge) { pauseAutopilot(row, `GitHub auto-merge was turned on for #${pr.number} — resume to let Wisp decide`, now); return }
    if (pr.queued) { save("queued", "Queued to merge", MOVING_MS); return }
    checkpoint.heads = trimHeads({ ...checkpoint.heads, [pr.head]: checkpoint.heads?.[pr.head] ?? now.toISOString() })
    if (!idle) { save("waiting", busyReason(task), BUSY_MS); return }

    const required = await this.requiredChecks(repository, pr.baseRefName, cwd, signal)
    const published = await (this.options.published ?? publishedWork)(task, pr.headRefName, pr.head, signal)
    const gate = mergeGate({
      pr, requiredNames: new Set(required),
      allowedBases: new Set([pr.defaultBranch, configured].filter((b): b is string => Boolean(b))),
      headFirstSeenMs: Date.parse(checkpoint.heads[pr.head]!), nowMs: now.getTime(), published,
    })
    if (gate.kind === "wait") { save("waiting", gate.reason, MOVING_MS); return }
    if (gate.kind === "needs-you") { save("needs-you", gate.reason, WAITING_ON_YOU_MS); return }
    await this.merge(row, checkpoint, pr, repository, signal)
  }

  /** The bound PR is no longer open: record how it ended and stand down. */
  private settle(row: WorkflowRow, checkpoint: AutopilotCheckpoint, pr: PrSnapshot): void {
    const now = this.now()
    if (pr.state === "MERGED") {
      const ours = checkpoint.mergeAttempt?.head === pr.head
      finishAutopilot(row, "merged", ours ? `Merged by Wisp` : `#${pr.number} was merged`, now, { base: pr.baseRefName, byWisp: ours })
      return
    }
    // Closing a PR is how its owner abandons an approach: never move on to another.
    finishAutopilot(row, "closed", `Auto-merge off — #${pr.number} was closed`, now)
  }

  private async requiredChecks(repository: string, base: string, cwd: string, signal: AbortSignal): Promise<string[]> {
    const key = `${repository}#${base}`
    const hit = this.required.get(key)
    if (hit && this.now().getTime() - hit.at < REQUIRED_TTL_MS) return hit.names
    // Unreadable protection counts as none, which is the STRICTER branch:
    // every check then counts. Cached briefly so a flaky read retries soon.
    const names = await this.github.requiredChecks(repository, base, cwd, signal).catch(() => null)
    this.required.set(key, { names: names ?? [], at: names ? this.now().getTime() : this.now().getTime() - REQUIRED_TTL_MS + 60_000 })
    return names ?? []
  }

  private async merge(row: WorkflowRow, checkpoint: AutopilotCheckpoint, pr: PrSnapshot, repository: string, signal: AbortSignal): Promise<void> {
    const now = this.now()
    // Pre-flight, with no await between it and the merging guard: a toggle,
    // a Stop, or a turn that started during the check all win.
    const task = getTask(row.task_id)
    if (!task || !taskIsIdle(task)) return
    const attempt: AutopilotCheckpoint = { ...checkpoint, mergeAttempt: { head: pr.head, at: now.toISOString() }, state: "merging" }
    if (!writeAutopilotCheckpoint(row, attempt, now)) return
    recordWorkflow(row.id, "merging", `Merging #${pr.number} (${pr.mergeMethod.toLowerCase()})`, now.toISOString())
    const result = await whileMerging(task.id,
      () => this.github.merge({ repository, number: pr.number, method: pr.mergeMethod, head: pr.head }, task.repo_path, signal),
      () => { startNextQueuedMessage(task.id, this.adapters, this.cfg) })
    const after = await this.github.snapshot(repository, pr.number, task.repo_path, signal).catch(() => null)
    const current = getWorkflow(row.id)
    if (!current || current.state !== "active") return
    if (after && after.state !== "OPEN") { this.settle(current, attempt, after); return }
    if (after?.queued) { saveAutopilotCheck(current, { state: "queued", reason: "Queued to merge", checkpoint: attempt, delayMs: MOVING_MS }, this.now()); return }
    if (after?.providerAutoMerge) {
      pauseAutopilot(current, `GitHub auto-merge was turned on for #${pr.number} — resume to let Wisp decide`, this.now())
      return
    }
    const failures = attempt.mergeFailures?.head === pr.head ? attempt.mergeFailures.count + 1 : 1
    const failed: AutopilotCheckpoint = { ...attempt, mergeFailures: { head: pr.head, count: failures } }
    delete failed.mergeAttempt
    const detail = result.detail || "gh pr merge did not merge"
    if (failures >= MERGE_FAILURE_LIMIT) {
      writeAutopilotCheckpoint(current, failed, this.now())
      pauseAutopilot(getWorkflow(row.id) ?? current, `Merge failed: ${detail}`.slice(0, 300), this.now())
      return
    }
    saveAutopilotCheck(current, { state: "waiting", reason: `Merge failed, retrying: ${detail}`.slice(0, 300), checkpoint: failed, delayMs: 2 * MOVING_MS }, this.now())
  }
}
