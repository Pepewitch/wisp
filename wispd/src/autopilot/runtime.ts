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
import { getTask } from "../store"
import { assertTaskCapacity, TaskCapacityError } from "../task-admission"
import { backgroundWork } from "../task-processes"
import type { Task } from "../types"
import { changeWorkflowState, getWorkflow, recordWorkflow, seenWake, type WorkflowRow } from "../workflows/store"
import { mergeGate, type PublishedWork } from "./gate"
import { taskIsIdle } from "./idle"
import { ghAutopilot, type AutopilotGitHub, type OpenPullRequest, type PrComment, type PrSnapshot } from "./github"
import { whileMerging } from "./merging"
import { publishedWork } from "./published"
import { MAX_ROUNDS, roundMessage, writeEvidence, type RoundContent } from "./evidence"
import { feedbackItems, feedbackKey, feedbackSummary, isMarked, markerOf, pairedChecks, withDelivered, type FeedbackItem } from "./feedback"
import { planFix, type FixPlan } from "./fix"
import {
  checkAutopilotSoon, checkpointOf, deferAutopilot, dueAutopilots, finishAutopilot, paramsOf, pauseAutopilot,
  reserveRound, saveAutopilotCheck, unmarkedTurns, withdrawQueuedRound, writeAutopilotCheckpoint, type AutopilotCheckpoint,
} from "./store"
import { CONTEXT_CHANGE_PAUSE } from "./type"

/** Something that moves on its own: checks running, a fresh head, a merge queue. */
export const MOVING_MS = 60_000
/** Blocked on a person, or no PR yet. The settle event still brings it forward. */
export const WAITING_ON_YOU_MS = 5 * 60_000
/** A busy task: only a lifecycle look, for a PR someone else merged or closed. */
export const BUSY_MS = 20 * 60_000
const REQUIRED_TTL_MS = 10 * 60_000
/** How long after the task goes idle an auto-fix round waits before it is sent. */
export const SEND_DELAY_MS = 2 * 60_000
const MERGE_FAILURE_LIMIT = 3
/** Looks that could read none of a round's logs before it is sent with links only. */
const LOG_MISS_LIMIT = 3

export interface AutopilotRuntimeOptions {
  now?: () => Date
  github?: AutopilotGitHub
  published?: (task: Task, branch: string, head: string, signal: AbortSignal) => Promise<PublishedWork>
  repository?: (task: Task, signal: AbortSignal) => Promise<string | null>
  branches?: (task: Task, signal: AbortSignal) => Promise<string[]>
  /** one look's deadline */
  lookTimeoutMs?: number
}

export { taskIsIdle } from "./idle"

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

/**
 * Only a PR this task could have opened: authored by the account Wisp merges
 * as, opened after the task was created, from this repository. A worktree can
 * check out anyone's branch (`gh pr checkout`), and adopting that PR would
 * merge someone else's work under the owner's name. Among those, the task's
 * own branch names first, then the oldest onto the base, so a stacked child
 * never jumps its parent.
 */
export function choosePull(pulls: OpenPullRequest[], task: Task, viewer: string, allowedBases: ReadonlySet<string>): OpenPullRequest | null {
  const created = Date.parse(task.created_at)
  const own = pulls
    .filter((pull) => !pull.isCrossRepository && viewer !== "" && pull.author === viewer && Date.parse(pull.createdAt) >= created)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number)
  const named = (pull: OpenPullRequest) => pull.headRefName === task.branch || pull.headRefName.startsWith(`wisp/${task.id}-`)
  return own.find((pull) => named(pull) && allowedBases.has(pull.baseRefName)) ??
    own.find((pull) => allowedBases.has(pull.baseRefName)) ?? own.find(named) ?? own[0] ?? null
}

/** Why the first open PR was not adopted, so "Waiting for a PR" never hides one that exists. */
export function skippedPull(pulls: OpenPullRequest[], task: Task, viewer: string): string | null {
  const pull = pulls[0]
  if (!pull) return null
  if (pull.isCrossRepository) return `#${pull.number} is from a fork`
  if (pull.author !== viewer) return `#${pull.number} was opened by @${pull.author ?? "someone else"}, not @${viewer}`
  if (Date.parse(pull.createdAt) < Date.parse(task.created_at)) return `#${pull.number} is older than this task`
  return null
}

interface FixContext {
  row: WorkflowRow; task: Task; checkpoint: AutopilotCheckpoint; pr: PrSnapshot; required: ReadonlySet<string>
  repository: string; autoMerge: boolean; signal: AbortSignal
}

/** What one look at an open, unqueued PR teaches the checkpoint. */
function observe(checkpoint: AutopilotCheckpoint, pr: PrSnapshot, now: Date): void {
  // A merge attempt no longer being confirmed did not land (or a merge queue
  // ejected it): forget it, so a later merge by someone else is not Wisp's.
  if (checkpoint.mergeAttempt && checkpoint.state !== "merging") delete checkpoint.mergeAttempt
  checkpoint.heads = trimHeads({ ...checkpoint.heads, [pr.head]: checkpoint.heads?.[pr.head] ?? now.toISOString() }, pr.head)
  // A draft marked ready queues new CI; its draft-time results prove nothing.
  if (pr.isDraft) delete checkpoint.readySince
  else checkpoint.readySince ??= now.toISOString()
}

function forgetPending(checkpoint: AutopilotCheckpoint): void {
  delete checkpoint.pending
  delete checkpoint.sendNow
}

/** The task is busy, or a round went out: the next delay starts from its next idle moment. */
function forgetIdle(checkpoint: AutopilotCheckpoint): void {
  delete checkpoint.idleSince
  delete checkpoint.idleTurn
  forgetPending(checkpoint)
}

/**
 * Review threads Wisp sent that are still open. On a PR with more than 100
 * threads, one pushed out of the newest 100 cannot be read, so it counts as open.
 */
function openSentThreads(pr: PrSnapshot, checkpoint: AutopilotCheckpoint): number {
  const sent = Object.keys(checkpoint.delivered ?? {}).filter((id) => id.startsWith("thread:"))
  const read = new Map(pr.threads.map((thread) => [`thread:${thread.id}`, thread]))
  return sent.filter((id) => (read.has(id) ? !read.get(id)!.resolved : pr.threadsTruncated)).length
}

/** The last few heads seen, and always the current one. */
function trimHeads(heads: Record<string, string>, current: string): Record<string, string> {
  const kept = Object.entries(heads).filter(([sha]) => sha !== current).sort((a, b) => a[1].localeCompare(b[1])).slice(-4)
  return Object.fromEntries([...kept, [current, heads[current]!]])
}

export class AutopilotRuntime {
  private pending: Promise<void> | null = null
  private again = false
  private stopped = false
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private readonly now: () => Date
  private readonly github: AutopilotGitHub
  private readonly required = new Map<string, { names: string[]; at: number }>()
  private readonly pushers = new Map<string, { ok: boolean; until: number }>()

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
    // A kick during a pass must not be absorbed by it: that pass chose its
    // rows before the kick brought this one forward. Run once more after it.
    if (this.pending) { this.again = true; return this.pending }
    this.pending = (async () => {
      do {
        this.again = false
        await this.runDue()
      } while (this.again && !this.stopped && !homeIsDraining())
    })().finally(() => { this.pending = null })
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
    const timeout = setTimeout(abort, this.options.lookTimeoutMs ?? 90_000)
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
      if (row.reason === CONTEXT_CHANGE_PAUSE) {
        // the agent-switch trigger paused it; autopilot follows the task instead
        changeWorkflowState(row.id, "active", "Followed the task's agent change", now)
        return
      }
      await this.pausedLifecycle(row, signal)
      return
    }
    const task = getTask(row.task_id)
    if (!task || task.archived) { changeWorkflowState(row.id, "completed", "Task archived", now); return }
    const params = paramsOf(row)
    if (!params.autoMerge && !params.autoFix) { changeWorkflowState(row.id, "completed", "Auto-merge off", now); return }
    // A round reserved but never started goes back; the next look plans it
    // afresh from current evidence rather than sending a stale one.
    if (withdrawQueuedRound(row)) return
    const checkpoint: AutopilotCheckpoint = checkpointOf(row)
    const idle = taskIsIdle(task)
    const save = (state: AutopilotState, reason: string, delayMs: number, about: "pr" | "task" = "task") =>
      saveAutopilotCheck(row, { state, reason, checkpoint, delayMs, about }, this.now())

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
      const bound = await this.bind(row, task, repository, configured, signal)
      if (typeof bound === "string") { save("waiting", bound, WAITING_ON_YOU_MS); return }
      checkpoint.pr = bound
    }

    const pr = await this.github.snapshot(repository, checkpoint.pr, cwd, signal)
    await this.lookAt({ row, task, checkpoint, pr, repository, configured, idle, save, autoFix: params.autoFix, autoMerge: params.autoMerge, signal })
  }

  /** Everything after the bound PR has been read: settle it, fix it, or merge it. */
  private async lookAt(ctx: {
    row: WorkflowRow; task: Task; checkpoint: AutopilotCheckpoint; pr: PrSnapshot; repository: string
    configured: string | undefined; idle: boolean; autoFix: boolean; autoMerge: boolean; signal: AbortSignal
    save: (state: AutopilotState, reason: string, delayMs: number, about?: "pr" | "task") => boolean
  }): Promise<void> {
    const { row, task, checkpoint, pr, repository, configured, save, signal } = ctx
    const now = this.now()
    const cwd = task.repo_path
    if (pr.state !== "OPEN") { this.settle(row, checkpoint, pr); return }
    if (pr.isCrossRepository) { save("needs-you", "Fork pull requests are not supported", BUSY_MS, "pr"); return }
    if (pr.providerAutoMerge) { this.providerPause(row, checkpoint, pr); return }
    if (pr.queued) { save("queued", "Queued to merge", MOVING_MS, "pr"); return }
    observe(checkpoint, pr, now)
    if (!ctx.idle) {
      forgetIdle(checkpoint)
      save("waiting", busyReason(task), BUSY_MS)
      return
    }
    // The delay runs from the end of the task's LATEST turn: one the owner
    // started and finished between two looks restarts it.
    if (checkpoint.idleTurn !== task.turn_count || !checkpoint.idleSince) {
      forgetIdle(checkpoint)
      checkpoint.idleSince = now.toISOString()
      checkpoint.idleTurn = task.turn_count
    }

    const required = await this.requiredChecks(repository, pr.baseRefName, cwd, signal)
    // Auto-fix acts first: a red check or a conflict is fixed before anything merges.
    const nothingToFix = ctx.autoFix
      ? await this.autoFix({ row, task, checkpoint, pr, required: new Set(required), repository, autoMerge: ctx.autoMerge, signal })
      : "Nothing to fix"
    if (nothingToFix === null) return
    // Review threads Wisp sent that are still open: the agent answered what it
    // could; the rest (a colleague's to resolve, or one it disagreed with) is
    // for a person, whether or not the repository requires resolution.
    const open = ctx.autoFix ? openSentThreads(pr, checkpoint) : 0
    if (open > 0) {
      saveAutopilotCheck(row, { state: "needs-you", reason: `${open} review thread${open === 1 ? "" : "s"} still open`, checkpoint, delayMs: WAITING_ON_YOU_MS, about: "pr", by: "auto-fix" }, this.now())
      return
    }
    if (!ctx.autoMerge) { save("waiting", nothingToFix, WAITING_ON_YOU_MS, "pr"); return }
    const published = await (this.options.published ?? publishedWork)(task, pr.headRefName, pr.head, signal)
    const gate = mergeGate({
      pr, requiredNames: new Set(required),
      allowedBases: new Set([pr.defaultBranch, configured].filter((b): b is string => Boolean(b))),
      // observe() recorded both; a missing one parses as NaN, which the gate reads as fresh
      headFirstSeenMs: Math.max(Date.parse(checkpoint.heads?.[pr.head] ?? ""), Date.parse(checkpoint.readySince ?? "")),
      nowMs: now.getTime(), published,
    })
    if (gate.kind === "wait") { save("waiting", gate.reason, gate.slow ? WAITING_ON_YOU_MS : MOVING_MS, "pr"); return }
    if (gate.kind === "needs-you") { save("needs-you", gate.reason, WAITING_ON_YOU_MS, "pr"); return }
    await this.merge(row, checkpoint, pr, repository)
  }

  /**
   * One auto-fix look. Returns null when it acted or explained itself (a rerun,
   * a round, a wait, a needs-you), or the reason there is nothing to fix — in
   * which case auto-merge, if it is on, takes over.
   */
  private async autoFix(ctx: FixContext): Promise<string | null> {
    const { row, task, checkpoint, pr } = ctx
    const now = this.now()
    const say = (state: AutopilotState, reason: string, delayMs: number): null => {
      saveAutopilotCheck(row, { state, reason, checkpoint, delayMs, about: "pr", by: "auto-fix" }, this.now())
      return null
    }
    const rerun = checkpoint.rerun?.head === pr.head ? checkpoint.rerun.runs : []
    const items = await this.feedbackFor(ctx)
    // A bot's verdict check beside the sticky comment being sent is the review flow's.
    const paired = pairedChecks(pr, items, checkpoint.delivered ?? {})
    const plan = planFix({ pr: { ...pr, checks: pr.checks.filter((check) => !paired.has(check.name)) }, requiredNames: ctx.required, rerun: new Set(rerun) })
    if (plan.kind === "rerun") {
      forgetPending(checkpoint)
      // Token-free, once per run and head: a flake gets a second chance
      // before anyone spends an agent turn on it.
      const accepted = await Promise.all(plan.runs.map((run) => this.github.rerunRun(ctx.repository, run, task.repo_path, ctx.signal).catch(() => false)))
      // Tried is tried: a refused rerun is not asked for again, and the next look moves on.
      checkpoint.rerun = { head: pr.head, runs: [...rerun, ...plan.runs] }
      const reason = accepted.some(Boolean) ? plan.reason : plan.reason.replace(/^Rerunning/, "Could not rerun")
      recordWorkflow(row.id, "rerun", reason, now.toISOString())
      return say("waiting", reason, MOVING_MS)
    }
    // CI's part, unless that evidence already went out (alone, or in a round
    // with review feedback: the round's key is then a combined one) or was skipped.
    const sent = (key: string) => seenWake(row.id, key) || (checkpoint.sentCi ?? []).includes(key)
    const ci = plan.kind === "fix" && !sent(plan.key) && !checkpoint.skipped?.includes(plan.key) ? plan : null
    const key = [ci?.key, items.length > 0 ? feedbackKey(items) : null].filter(Boolean).join("|")
    // Only a countdown for this very evidence keeps a pending round, or a Send now.
    if (checkpoint.pending?.key !== key) forgetPending(checkpoint)
    if (checkpoint.logMisses && checkpoint.logMisses.key !== key) delete checkpoint.logMisses
    if (!key) return this.nothingToSend(plan, checkpoint, say)
    const summary = [ci?.summary, items.length > 0 ? feedbackSummary(items) : null].filter(Boolean).join(" and ")
    const rounds = checkpoint.rounds ?? 0
    if (rounds >= MAX_ROUNDS) {
      writeAutopilotCheckpoint(row, { ...checkpoint, by: "auto-fix" }, now)
      pauseAutopilot(getWorkflow(row.id) ?? row, `Auto-fix gave up after ${MAX_ROUNDS} rounds — resume to try again`, now)
      return null
    }
    // A short delay after the task goes idle, and after the newest review
    // words (a reviewer's burst goes as one): time to read what it did and
    // steer by hand first. Send now or Skip act on it.
    const settled = Math.max(Date.parse(checkpoint.idleSince ?? now.toISOString()), ...items.map((item) => Date.parse(item.at)).filter(Number.isFinite))
    const sendsAt = settled + SEND_DELAY_MS
    if (checkpoint.sendNow !== key && now.getTime() < sendsAt) {
      checkpoint.pending = { key, summary, sendsAt: new Date(sendsAt).toISOString() }
      return say("waiting", `Auto-fix will send: ${summary}`, Math.max(5_000, sendsAt - now.getTime()))
    }
    return this.sendRound({ ...ctx, content: { ci, items, summary }, key, round: rounds + 1 })
  }

  /** No round to send: what CI alone says. */
  private nothingToSend(plan: FixPlan, checkpoint: AutopilotCheckpoint, say: (state: AutopilotState, reason: string, delayMs: number) => null): string | null {
    if (plan.kind === "none") return plan.reason
    if (plan.kind === "wait") return say("waiting", plan.reason, MOVING_MS)
    if (plan.kind === "needs-you") return say("needs-you", plan.reason, WAITING_ON_YOU_MS)
    if (plan.kind !== "fix") return null
    // The same evidence already reached a turn and the head did not move:
    // another round would only repeat itself.
    if (checkpoint.skipped?.includes(plan.key)) return say("needs-you", `${plan.reason} (auto-fix skipped)`, WAITING_ON_YOU_MS)
    return say("needs-you", `Still ${plan.summary} after round ${Math.max(checkpoint.rounds ?? 0, 1)}, with no new push`, WAITING_ON_YOU_MS)
  }

  /** Review feedback the agent has not seen, from people and bots it may take instructions from. */
  private async feedbackFor(ctx: FixContext): Promise<FeedbackItem[]> {
    const { pr, task, row, checkpoint } = ctx
    const people = new Set<string>()
    for (const words of [...pr.reviews, ...pr.comments, ...pr.threads.flatMap((thread) => thread.comments)]) {
      if (words.author && !words.bot && words.author !== pr.viewer) people.add(words.author)
    }
    const pushers = new Set<string>()
    await Promise.all([...people].map(async (login) => {
      if (await this.canPush(ctx.repository, login, task.repo_path, ctx.signal)) pushers.add(login)
    }))
    const trusts = ({ author, bot }: { author: string | null; bot: boolean }) =>
      author !== null && (author === pr.viewer || (bot && author !== "github-actions") || pushers.has(author))
    // Turns that began before auto-fix was armed were never asked to mark
    // their posts: the owner's-account comments inside them are the agent's.
    const windows = unmarkedTurns(task.id, checkpoint.fixArmedAt ?? row.created_at, checkpoint.unmarkedTurns ?? [])
    const self = (comment: PrComment) => isMarked(comment.body) || (comment.author === pr.viewer && windows.some((turn) => {
      const at = Date.parse(comment.createdAt)
      return at >= Date.parse(turn.started_at) && at <= (turn.ended_at ? Date.parse(turn.ended_at) : Infinity)
    }))
    return feedbackItems({ pr, trusts, self, delivered: checkpoint.delivered ?? {} })
  }

  /** Whether a login may instruct the agent: cached an hour, and a failed read counts as no for five minutes. */
  private async canPush(repository: string, login: string, cwd: string, signal: AbortSignal): Promise<boolean> {
    const key = `${repository}#${login}`
    const hit = this.pushers.get(key)
    const now = this.now().getTime()
    if (hit && now < hit.until) return hit.ok
    const ok = await this.github.canPush(repository, login, cwd, signal).then((value) => ({ value, known: true }), () => ({ value: false, known: false }))
    this.pushers.set(key, { ok: ok.value, until: now + (ok.known ? 60 * 60_000 : 5 * 60_000) })
    return ok.value
  }

  /** Gather one round's evidence and queue it for the agent, unless something moved meanwhile. */
  private async sendRound(ctx: FixContext & { content: RoundContent; key: string; round: number }): Promise<null> {
    const { row, task, checkpoint, pr, content, key, round } = ctx
    const say = (state: AutopilotState, reason: string, delayMs: number): null => {
      saveAutopilotCheck(row, { state, reason, checkpoint, delayMs, about: "pr", by: "auto-fix" }, this.now())
      return null
    }
    // A full slot table would refuse the turn: wait for a slot rather than
    // read logs for a round that cannot start.
    if (!this.hasSlot(task)) return say("waiting", "Waiting for a free task slot", MOVING_MS)
    const signature = `— ${task.harness} via Wisp ${markerOf(task.id)}`
    const evidence = await writeEvidence({
      ...content, taskId: task.id, rowId: row.id, round, pr, repository: ctx.repository, requiredNames: ctx.required,
      github: this.github, signal: ctx.signal, cwd: task.repo_path, signature,
    })
    // Cut short (the look's deadline, shutdown): the evidence is partial. A
    // failed look backs off; shutdown is quiet (evaluate decides which).
    if (ctx.signal.aborted) throw new Error("reading the logs took too long")
    if (evidence.logsWanted > 0 && evidence.logsRead === 0) {
      const misses = (checkpoint.logMisses?.key === key ? checkpoint.logMisses.count : 0) + 1
      // GitHub usually serves a finished job's log within a minute; a round
      // with nothing to read is not worth a turn — until waiting stops paying.
      if (misses < LOG_MISS_LIMIT) {
        checkpoint.logMisses = { key, count: misses }
        return say("waiting", `Waiting for GitHub to serve the logs of ${content.ci!.summary.replace(/ failing$/, "")}`, MOVING_MS)
      }
    }
    // In the round's own checkpoint, so a withdrawn round's cancel rolls both back.
    const next: AutopilotCheckpoint = {
      ...checkpoint, rounds: round,
      delivered: withDelivered(checkpoint.delivered, Object.fromEntries(content.items.map((item) => [item.id, item.fingerprint]))),
      sentCi: content.ci ? [...(checkpoint.sentCi ?? []).slice(-20), content.ci.key] : checkpoint.sentCi,
    }
    forgetIdle(next)
    delete next.logMisses
    // From here to the turn's start nothing awaits, so the slot seen free is
    // the slot the turn takes: another look or task cannot take it between.
    if (!this.hasSlot(task)) return say("waiting", "Waiting for a free task slot", MOVING_MS)
    const id = reserveRound(row, {
      key, prompt: roundMessage({ ...content, pr, round, file: evidence.file, autoMerge: ctx.autoMerge, signature }),
      reason: `Sent ${content.summary} (round ${round} of ${MAX_ROUNDS})`, checkpoint: next, turnCount: task.turn_count,
    }, this.now())
    // A user message queued first still goes first; this round then waits,
    // and the next look withdraws it and plans again.
    if (id) startNextQueuedMessage(task.id, this.adapters, this.cfg, id)
    return null
  }

  private hasSlot(task: Task): boolean {
    try {
      assertTaskCapacity(this.cfg, task.id)
      return true
    } catch (error) {
      if (error instanceof TaskCapacityError) return false
      throw error
    }
  }

  /** GitHub's own auto-merge is on: that pause is auto-merge's, whichever switch spoke last. */
  private providerPause(row: WorkflowRow, checkpoint: AutopilotCheckpoint, pr: PrSnapshot): void {
    writeAutopilotCheckpoint(row, { ...checkpoint, by: "auto-merge" }, this.now())
    pauseAutopilot(getWorkflow(row.id) ?? row, `GitHub auto-merge was turned on for #${pr.number} — resume to let Wisp decide`, this.now())
  }

  /** The PR number to bind to, or the reason there is none yet. */
  private async bind(row: WorkflowRow, task: Task, repository: string, configured: string | undefined, signal: AbortSignal): Promise<number | string> {
    const branches = await (this.options.branches ?? ((t, s) => taskBranches(t, bunProbeSpawn, s)))(task, signal)
    const { defaultBranch, viewer, pulls } = await this.github.openPullRequests(repository, branches, task.repo_path, signal)
    const pick = choosePull(pulls, task, viewer, new Set([defaultBranch, configured].filter((b): b is string => Boolean(b))))
    if (!pick) {
      const skipped = skippedPull(pulls, task, viewer)
      return skipped ? `Waiting for this task's own PR (${skipped})` : "Waiting for a PR"
    }
    recordWorkflow(row.id, "bound", `Watching PR #${pick.number}`, this.now().toISOString())
    return pick.number
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

  /** A paused row still notices a PR that someone merged or closed, so it never sits paused on a finished PR. */
  private async pausedLifecycle(row: WorkflowRow, signal: AbortSignal): Promise<void> {
    const checkpoint = checkpointOf(row)
    const task = getTask(row.task_id)
    const repository = task && checkpoint.pr ? await (this.options.repository ?? originRepository)(task, signal) : null
    const pr = repository && task ? await this.github.snapshot(repository, checkpoint.pr!, task.repo_path, signal).catch(() => null) : null
    if (pr && pr.state !== "OPEN") { this.settle(row, checkpoint, pr); return }
    deferAutopilot(row, new Date(this.now().getTime() + BUSY_MS))
  }

  private async merge(row: WorkflowRow, checkpoint: AutopilotCheckpoint, pr: PrSnapshot, repository: string): Promise<void> {
    const now = this.now()
    // Pre-flight, with no await between it and the merging guard: a toggle,
    // a Stop, or a turn that started during the check all win.
    const task = getTask(row.task_id)
    if (!task || !taskIsIdle(task)) return
    const attempt: AutopilotCheckpoint = { ...checkpoint, mergeAttempt: { head: pr.head, at: now.toISOString() }, state: "merging", about: "pr", by: "auto-merge" }
    const merging = `Merging #${pr.number} (${pr.mergeMethod.toLowerCase()})`
    if (!writeAutopilotCheckpoint(row, attempt, now, merging)) return
    recordWorkflow(row.id, "merging", merging, now.toISOString())
    // The merge has its own deadline, not the check's: a slow read before it
    // must never be what kills `gh pr merge` halfway.
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    this.controller.signal.addEventListener("abort", abort, { once: true })
    const deadline = setTimeout(abort, 120_000)
    try {
      // Settle INSIDE the guard: a message that queued during the merge starts
      // only after the row says how it ended, so its turn is told the branch
      // is finished instead of being asked to push to a merged PR.
      await whileMerging(task.id, async () => {
        const result = await this.github.merge({ repository, number: pr.number, method: pr.mergeMethod, head: pr.head }, task.repo_path, controller.signal)
        const after = await this.github.snapshot(repository, pr.number, task.repo_path, controller.signal).catch(() => null)
        this.afterMerge(row, attempt, pr, result, after)
      }, () => { startNextQueuedMessage(task.id, this.adapters, this.cfg) })
    } finally {
      clearTimeout(deadline)
      this.controller.signal.removeEventListener("abort", abort)
    }
  }

  private afterMerge(row: WorkflowRow, attempt: AutopilotCheckpoint, pr: PrSnapshot, result: { ok: boolean; detail: string }, after: PrSnapshot | null): void {
    const current = getWorkflow(row.id)
    if (!current || current.state !== "active") return
    if (after && after.state !== "OPEN") { this.settle(current, attempt, after); return }
    if (after?.queued) { saveAutopilotCheck(current, { state: "queued", reason: "Queued to merge", checkpoint: attempt, delayMs: MOVING_MS, about: "pr" }, this.now()); return }
    if (after?.providerAutoMerge) {
      // no longer confirming anything: turns during the pause may push
      this.providerPause(current, { ...attempt, state: "waiting" }, pr)
      return
    }
    if (result.ok) {
      // gh said it merged but the read disagrees or failed (read-after-write
      // lag, a timeout): not a failure. Keep the attempt, so the next look
      // records it as Wisp's merge, and look again soon.
      saveAutopilotCheck(current, { state: "merging", reason: "Confirming the merge", checkpoint: attempt, delayMs: 15_000, about: "pr" }, this.now())
      return
    }
    const failures = attempt.mergeFailures?.head === pr.head ? attempt.mergeFailures.count + 1 : 1
    const failed: AutopilotCheckpoint = { ...attempt, mergeFailures: { head: pr.head, count: failures }, state: "waiting" }
    delete failed.mergeAttempt
    const detail = result.detail || "gh pr merge did not merge"
    if (failures >= MERGE_FAILURE_LIMIT) {
      writeAutopilotCheckpoint(current, failed, this.now())
      pauseAutopilot(getWorkflow(row.id) ?? current, `Merge failed: ${detail}`.slice(0, 300), this.now())
      return
    }
    saveAutopilotCheck(current, { state: "waiting", reason: `Merge failed, retrying: ${detail}`.slice(0, 300), checkpoint: failed, delayMs: 2 * MOVING_MS, about: "pr" }, this.now())
  }
}
