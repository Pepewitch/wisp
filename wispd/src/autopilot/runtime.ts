/**
 * The autopilot loop: for each armed task, bind it to its pull request, ask
 * GitHub where that PR stands, and merge it once the gate allows.
 *
 * It never decides anything mid-turn. A busy task is only checked on a slow
 * cadence, and only to notice that its PR was merged or closed by someone
 * else; the moment the task settles, an event brings its row forward, and so
 * does the task leaving the state a wait on it described (failed → running).
 */
import type { AutopilotState } from "../../../shared/autopilot"
import type { AdapterDef } from "../adapters"
import { repoConfigFor, type WispConfig } from "../config"
import { emit, subscribe } from "../events"
import { resolve } from "node:path"
import { backgroundPass, homeIsDraining } from "../home-lifetime"
import { bunProbeSpawn } from "../probes"
import { taskBranches } from "../pull-request-branches"
import { startNextQueuedMessage } from "../runner"
import { getTask, randomId } from "../store"
import { hasTaskCapacity, type Workload } from "../task-admission"
import { autoFixAlone, autoFixAtCap, ciToSend, nothingToSend } from "./fix-plan"
import { inheritedRightsLost } from "./subtask-policy"
import { recordAudit } from "../task-audit"
import type { Task } from "../types"
import { announceWorkflow, changeWorkflowState, getWorkflow, recordWorkflow, type WorkflowRow } from "../workflows/store"
import { mergeEvidence, mergeGate, sameReviewState, type PublishedWork } from "./gate"
import { taskIsIdle } from "./idle"
import { droppedOnNetwork, networkLook } from "./network"
import { createGhAutopilot, ghAutopilot, type AutopilotGitHub, type BaseRules, type PrComment, type PrSnapshot } from "./github"
import { githubBudget, GitHubPausedError, unlessPaused, type GitHubBudget } from "../github-budget"
import { SnapshotBatches } from "./batch"
import { PushTrust } from "./trust"
import { withReviewsSent } from "./pending-fix"
import { choosePull, originRepository, skippedPull } from "./bind"
import { BUSY_MS, MOVING_MS, WAITING_ON_YOU_MS } from "./cadence"
import { whileMerging } from "./merging"
import { publishedWork } from "./published"
import { MAX_ROUNDS, roundMessage, writeEvidence, type RoundContent } from "./evidence"
import {
  approvalCandidates, feedbackItems, feedbackKey, feedbackSummary, isMarked, judgeCandidates, markerOf, pairedChecks, relayedBlocks, reviewerPasses, withDelivered, type FeedbackItem,
} from "./feedback"
import { JUDGE_FAILURE_LIMIT, jevClient, jevKey, judgedHead, judgeLook, needsChanges, writeJudgeLog, type Judged, type JudgeClient, type JudgeLook } from "./judge"
import { headFirstSeen, headSince } from "./heads"
import { planFix, type FixPlan } from "./fix"
import {
  anySwitch, checkAutopilotOnTaskEvent, checkAutopilotSoon, checkpointOf, deferAutopilot, dueAutopilots, endMergeAttempt, finishAutopilot, paramsOf, pauseAutopilot, rebindAfterMerge,
  reserveRound, saveAutopilotCheck, unmarkedTurns, withdrawQueuedRound, writeAutopilotCheckpoint, type AutopilotCheck, type AutopilotCheckpoint,
} from "./store"
import { CONTEXT_CHANGE_PAUSE } from "./type"
import { busyReason, forgetIdle, forgetPending, nextPrReason, observe } from "./look"
import { autoReviewLook, endUnwantedReviews, supersedeStaleRounds, sweepReviews } from "./auto-review"
import { EarlyAnswers } from "./review-now"
import { reviewStartLook, type ReviewStart } from "./review-first"
import { holdForReview, reserveWith, reviewFiles, reviewKey, reviewRunning, reviewToCarry } from "./review-part"
import { createAndLaunchTask } from "../domain/task-create"
import type { ModelProbeCache } from "../model-probes"
import type { Launch } from "../verify/reviewer"
import { budgetWords, roundOfReviewer } from "../verify/rounds"

export { BUSY_MS, MOVING_MS, WAITING_ON_YOU_MS } from "./cadence"
export { choosePull, skippedPull } from "./bind"
const REQUIRED_TTL_MS = 10 * 60_000
/** How long after the task goes idle an auto-fix round waits before it is sent. */
export const SEND_DELAY_MS = 2 * 60_000
const MERGE_FAILURE_LIMIT = 3
export { QUIET_MS } from "./fix-plan"
/** After a merge, with no next PR yet: a turn settling looks at once, so this only covers a PR opened by hand. */
export const AFTER_MERGE_MS = 60 * 60_000
/** A PR that changed while a look worked is looked at again this soon, not a minute later. */
export const RECHECK_MS = 5_000
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
  /** the review judge, in place of Jev and whether a key is set */
  judge?: JudgeClient
  /** the GitHub budget the looks spend from and are paced by; the daemon's own by default */
  budget?: GitHubBudget
  /** how auto-review starts its reviewer and recipe tasks; createAndLaunchTask by default */
  launch?: Launch
  /** the daemon's model probe cache, so a reviewer gets Wisp's default model like any task */
  models?: ModelProbeCache
}

export { taskIsIdle } from "./idle"

interface FixContext {
  row: WorkflowRow; task: Task; checkpoint: AutopilotCheckpoint; pr: PrSnapshot; required: ReadonlySet<string>
  repository: string; autoMerge: boolean; signal: AbortSignal
  /** the review judge's answers, only while a judge is configured */
  judged?: Record<string, Judged>
  /** a look that reviews early keeps auto-fix's words to weigh (review-now.ts) instead of saving them */
  speak?: (check: AutopilotCheck) => void
  /** auto-review is on: a round running on the head holds auto-fix, and a settled rejection goes out with its next round */
  autoReview?: boolean
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
  private readonly budget: GitHubBudget
  private readonly required = new Map<string, { rules: Promise<BaseRules>; at: number }>()
  /** whose words may instruct the agent (trust.ts) */
  private readonly trust: PushTrust
  /** this pass's shared snapshots, and each repository path's origin */
  private batches: SnapshotBatches | null = null
  private origins = new Map<string, Promise<string | null>>()

  constructor(private cfg: WispConfig, private adapters: Record<string, AdapterDef>, private options: AutopilotRuntimeOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.budget = options.budget ?? githubBudget
    this.github = options.github ?? (options.budget ? createGhAutopilot({ budget: options.budget }) : ghAutopilot)
    this.trust = new PushTrust(this.github, this.now)
  }

  /** Every look's save: its wait stretched as the GitHub budget runs low. */
  private saveCheck(row: WorkflowRow, check: AutopilotCheck): boolean {
    return saveAutopilotCheck(row, { stretch: this.budget.stretch(), ...check }, this.now())
  }

  /** The task's GitHub repository, asked of git once per repository path a pass. */
  private repositoryOf(task: Task, signal: AbortSignal): Promise<string | null> {
    if (!this.origins.has(task.repo_path)) this.origins.set(task.repo_path, (this.options.repository ?? originRepository)(task, signal))
    return this.origins.get(task.repo_path)!
  }

  start(): void {
    const kick = (): void => { void backgroundPass("autopilot check", () => this.tick(), { loop: true }) }
    this.timer = setInterval(kick, 10_000)
    this.timer.unref?.()
    // A task that settles is the moment auto-merge usually has something to do;
    // one that moved on from a wait's state makes that wait's reason stale.
    // A reviewer settling (or stopping to ask) is its author's moment.
    this.unsubscribe = subscribe((event) => {
      if (event.type !== "task") return
      const task = getTask(event.taskId)
      // so is a turn that ended on the network: its countdown to a resume starts now (network.ts)
      if (checkAutopilotOnTaskEvent(event.taskId, event.state, this.now()) || (droppedOnNetwork(event.state, task) && checkAutopilotSoon(event.taskId, this.now()))) kick()
      if (["done", "failed", "needs-input"].includes(event.state)) {
        const round = roundOfReviewer(event.taskId)
        if (round && checkAutopilotSoon(round.task_id, this.now())) kick()
      }
      // a recipe task's state is its project's verification state ("a recipe task is working")
      if (task?.verify_role === "recipe") emit({ type: "project", action: "update", path: resolve(task.repo_path) })
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
    await sweepReviews(this.cfg, this.now())
    const rows = dueAutopilots(this.now())
    let cursor = 0
    this.origins = new Map()
    this.batches = new SnapshotBatches(rows, { github: this.github, repository: (task, signal) => this.repositoryOf(task, signal), now: () => this.now().getTime() })
    try {
      await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
        while (cursor < rows.length && !this.stopped && !homeIsDraining()) await this.evaluate(rows[cursor++]!)
      }))
    } finally {
      this.batches = null
    }
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
      const checkpoint = checkpointOf(current)
      if (error instanceof GitHubPausedError) {
        // GitHub (or Wisp's own share) said wait: no failure, and back at the minute it resumes. A merge
        // attempt stays: one that may have gone out (before a restart, say) is confirmed by the next look.
        const delayMs = Math.max(error.until - this.now().getTime(), 1000)
        this.saveCheck(current, { state: "waiting", reason: error.message, checkpoint, failures: current.failures, delayMs, stretch: 1, patient: false })
        return
      }
      const failures = current.failures + 1
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 200)
      this.saveCheck(current, {
        state: "waiting", reason: message.startsWith("GitHub") ? message : `Check failed: ${message}`,
        checkpoint, failures,
        delayMs: Math.min(MOVING_MS * 2 ** Math.min(failures, 5), 30 * 60_000),
      })
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
    const params = paramsOf(row)
    endUnwantedReviews(row.task_id, task, params.autoReview, this.cfg, now)
    if (!task || task.archived) { changeWorkflowState(row.id, "completed", "Task archived", now); return }
    if (!anySwitch(params)) { changeWorkflowState(row.id, "completed", "Auto-merge off", now); return }
    // A round reserved but never started goes back; the next look plans it
    // afresh from current evidence rather than sending a stale one.
    if (withdrawQueuedRound(row)) return
    const checkpoint: AutopilotCheckpoint = checkpointOf(row)
    // what offers Review now is each look's to find again; with auto-review off, a click is moot
    delete checkpoint.reviewOpen
    if (!params.autoReview) delete checkpoint.reviewNow
    const idle = taskIsIdle(task)
    const save = (state: AutopilotState, reason: string, delayMs: number, about: "pr" | "task" = "task", patient?: boolean) =>
      this.saveCheck(row, { state, reason, checkpoint, delayMs, about, patient })

    if (checkpoint.stopHold) {
      // the person's next turn releases the hold; an unread report waits for that release, so it cannot block it
      if (taskIsIdle(task, "ignore") && task.turn_count > checkpoint.stopHold.turnCount) delete checkpoint.stopHold
      else {
        // Held, but a merge was already under way: record it if it landed,
        // so the next turn is not told to push to a merged branch.
        if (checkpoint.mergeAttempt && checkpoint.pr && await this.settledWhileHeld(row, task, checkpoint, signal)) return
        save("held", "Held — you pressed Stop; continues after your next turn", BUSY_MS)
        return
      }
    }

    // A turn that ended on the network is resumed before anything asks GitHub, which is as unreachable.
    if (networkLook(row, task, checkpoint, {
      now, hasSlot: (t) => this.hasSlot(t), start: (id) => startNextQueuedMessage(task.id, this.adapters, this.cfg, id),
      // no GitHub call goes out while it waits, so the budget does not stretch the wait;
      // and it describes a failed task, so a person's message (failed → running) re-looks at once
      say: (reason, delayMs) => this.saveCheck(row, { state: "waiting", reason, checkpoint, delayMs, stretch: 1, patient: false, busyOn: "failed" }),
    })) return

    const repository = await this.repositoryOf(task, signal)
    if (!repository) { save("needs-you", "Not a GitHub repository", BUSY_MS); return }
    const cwd = task.repo_path
    const configured = repoConfigFor(this.cfg, task.repo_path)?.baseBranch?.replace(/^origin\//, "")

    if (!checkpoint.pr) {
      if (!idle) {
        // a turn is running: its end is when a next PR appears, so the quick retries start over
        delete checkpoint.nextPrMisses
        const reason = checkpoint.lastMerged ? nextPrReason(checkpoint.lastMerged, busyReason(task)) : busyReason(task)
        this.saveCheck(row, { state: "waiting", reason, checkpoint, delayMs: BUSY_MS, busyOn: task.state })
        return
      }
      const mergedHere = checkpoint.mergedHere === true
      const bound = await this.bind(row, task, repository, configured, checkpoint, signal)
      // After a merge the next PR comes from a turn, whose settling kicks a
      // look at once: the slow fallback only covers a PR opened by hand.
      if (typeof bound === "string") {
        // GitHub's list can lag a PR the turn just opened: two more quick
        // looks before the slow fallback.
        const misses = checkpoint.lastMerged ? (checkpoint.nextPrMisses ?? 0) + 1 : 0
        if (checkpoint.lastMerged) checkpoint.nextPrMisses = misses
        // its PR merged on this row and nothing new has come: done for now (the violet rail)
        this.saveCheck(row, {
          state: "waiting", reason: checkpoint.lastMerged ? nextPrReason(checkpoint.lastMerged, bound) : bound, checkpoint,
          delayMs: checkpoint.lastMerged && misses > 2 ? AFTER_MERGE_MS : WAITING_ON_YOU_MS, done: mergedHere,
        })
        return
      }
      delete checkpoint.nextPrMisses
      delete checkpoint.mergedHere
      checkpoint.pr = bound.number
    }

    const pr = await this.batches?.take(row.id, checkpoint.pr, signal) ?? await this.github.snapshot(repository, checkpoint.pr, cwd, signal)
    await this.lookAt({ row, task, checkpoint, pr, repository, configured, idle, save, autoFix: params.autoFix, autoMerge: params.autoMerge, autoReview: params.autoReview, signal })
  }

  /** Everything after the bound PR has been read: settle it, fix it, or merge it. */
  private async lookAt(ctx: {
    row: WorkflowRow; task: Task; checkpoint: AutopilotCheckpoint; pr: PrSnapshot; repository: string
    configured: string | undefined; idle: boolean; autoFix: boolean; autoMerge: boolean; autoReview: boolean; signal: AbortSignal
    save: (state: AutopilotState, reason: string, delayMs: number, about?: "pr" | "task", patient?: boolean) => boolean
  }): Promise<void> {
    const { row, task, checkpoint, pr, repository, configured, save, signal } = ctx
    const now = this.now()
    const cwd = task.repo_path
    if (pr.state !== "OPEN") { this.settle(row, checkpoint, pr); return }
    if (pr.isCrossRepository) { save("needs-you", "Fork pull requests are not supported", BUSY_MS, "pr"); return }
    if (pr.providerAutoMerge) { this.providerPause(row, checkpoint, pr); return }
    if (pr.queued) { save("queued", "Queued to merge", MOVING_MS, "pr"); return }
    observe(checkpoint, pr, now)
    // a push or retarget ends an obsolete reviewer at once (none run while auto-review is off)
    supersedeStaleRounds(row, pr, this.cfg, now)
    if (!ctx.idle) {
      forgetIdle(checkpoint)
      this.saveCheck(row, { state: "waiting", reason: busyReason(task), checkpoint, delayMs: BUSY_MS, busyOn: task.state })
      return
    }
    // The delay runs from the end of the task's LATEST turn: one the owner
    // started and finished between two looks restarts it.
    if (checkpoint.idleTurn !== task.turn_count || !checkpoint.idleSince) {
      forgetIdle(checkpoint)
      checkpoint.idleSince = now.toISOString()
      checkpoint.idleTurn = task.turn_count
    }

    const judging = await this.judgeReviews({ row, task, checkpoint, pr, repository, autoFix: ctx.autoFix, signal })
    const rules = await this.baseRules(repository, pr.baseRefName, cwd, signal)
    const required = rules.checks
    // a rule the snapshot could not read is "not required" when the branch has no classic protection at all
    if (pr.conversationRule === "unknown" && rules.classicProtection === false) pr.conversationRule = "not-required"
    const nothingToFix = await this.fixThenReview({
      row, task, checkpoint, pr, required: new Set(required), repository, autoMerge: ctx.autoMerge, signal, judged: judging?.judged, autoFix: ctx.autoFix, autoReview: ctx.autoReview,
    })
    if (nothingToFix === null) return
    if (!ctx.autoMerge) {
      if (ctx.autoFix) autoFixAlone((state, reason, delayMs, done, patient) => this.saveCheck(row, { state, reason, checkpoint, delayMs, about: "pr", by: "auto-fix", done, patient }), checkpoint, pr, nothingToFix, now)
      else this.saveCheck(row, { state: "waiting", reason: `Auto-review passed ${pr.head.slice(0, 7)}`, checkpoint, delayMs: WAITING_ON_YOU_MS, about: "pr", by: "auto-review", done: true, patient: true })
      return
    }
    const verdicts = judging
      ? judgedHead(judging, pr, { sinceMs: headSince(checkpoint, pr), firstSeenMs: headFirstSeen(checkpoint, pr, now.getTime()), nowMs: now.getTime() })
      : { problems: [], awaited: [], pending: false }
    const published = await (this.options.published ?? publishedWork)(task, pr.headRefName, pr.head, signal)
    const gate = mergeGate({
      pr, requiredNames: new Set(required),
      allowedBases: new Set([pr.defaultBranch, configured].filter((b): b is string => Boolean(b))),
      // observe() recorded both; a missing one parses as NaN, which the gate reads as fresh
      headFirstSeenMs: Math.max(Date.parse(checkpoint.heads?.[pr.head] ?? ""), Date.parse(checkpoint.readySince ?? "")),
      nowMs: now.getTime(), published,
      reviewerProblems: verdicts.problems, reviewersAwaited: verdicts.awaited, judgePending: verdicts.pending,
      // only reached once auto-review passed this head
      autoReviewPassed: ctx.autoReview ? true : undefined,
    })
    // waiting on reviewers backs off from a minute, like needs-you (cadence.ts)
    if (gate.kind === "wait") { save("waiting", gate.reason, gate.slow ? WAITING_ON_YOU_MS : MOVING_MS, "pr", gate.slow === true); return }
    if (gate.kind === "needs-you") { save("needs-you", gate.reason, WAITING_ON_YOU_MS, "pr"); return }
    // One more read right before merging: words or checks that arrived while
    // this look judged and gated are looked at (and judged) first, not merged over.
    const fresh = await this.github.snapshot(repository, pr.number, cwd, signal).catch(unlessPaused(null))
    if (!fresh || !sameReviewState(pr, fresh)) { save("waiting", "The PR changed while it was checked; checking again", RECHECK_MS, "pr"); return }
    await this.merge(row, checkpoint, pr, repository, {
      turnCount: task.turn_count, evidence: mergeEvidence(pr, new Set(required), judging !== null,
        ctx.autoReview ? `auto-review passed (${budgetWords(checkpoint.reviewRounds ?? 1, checkpoint.reviewSpent ?? 0)})` : undefined),
    })
  }

  /**
   * Auto-fix, then auto-review. Returns the reason there is nothing to fix
   * once both let the head through, or null when either acted or explained
   * itself. While a round on the head runs or is about to start, or its
   * rejection is still to go out, auto-review goes first and the look saves
   * one answer for both (review-first.ts, review-now.ts).
   */
  private async fixThenReview(ctx: FixContext & { autoFix: boolean; autoReview: boolean }): Promise<string | null> {
    const { row, task, checkpoint, pr, required } = ctx
    const start = ctx.autoReview ? await reviewStartLook({
      row, task, checkpoint, pr, required, now: this.now(), cfg: this.cfg, autoFix: ctx.autoFix,
      // auto-fix's own test for a CI fix it sends now, so the two cannot drift
      ciReady: async () => ctx.autoFix && !autoFixAtCap(checkpoint) && ciToSend((await this.fixPlan(ctx)).plan, checkpoint, row.id) !== null,
    }) : null
    const answers = start?.first ? new EarlyAnswers() : null
    const reviewed = answers ? await this.autoReview(row, task, checkpoint, pr, required, ctx.autoFix, start!, answers.onReview) : null
    // it sent the author its findings, or paused: nothing else acts on this read
    if (answers && getWorkflow(row.id)?.revision !== row.revision) return null
    // Auto-fix acts first: a red check or a conflict is fixed before anything merges.
    const nothingToFix = ctx.autoFix ? await this.autoFix({ ...ctx, speak: answers?.onFix }) : "Nothing to fix"
    if (answers) return answers.finish(reviewed === "passed", nothingToFix, (check) => this.saveCheck(row, check), reviewed === "deferred") ? null : nothingToFix
    if (nothingToFix === null) return null
    // Then the independent reviewer: nothing merges past a head it has not passed.
    return ctx.autoReview && await this.autoReview(row, task, checkpoint, pr, required, ctx.autoFix) !== "passed" ? null : nothingToFix
  }

  /** What auto-fix would act on: the unseen review feedback, and CI's plan beside it. */
  private async fixPlan(ctx: FixContext): Promise<{ plan: FixPlan; items: FeedbackItem[]; relayed: PrComment[]; rerun: number[] }> {
    const { checkpoint, pr } = ctx
    const rerun = checkpoint.rerun?.head === pr.head ? checkpoint.rerun.runs : []
    const { items, relayed } = await this.feedbackFor(ctx)
    // A bot's verdict check beside the sticky comment being sent is the review flow's.
    const paired = pairedChecks(pr, items, checkpoint.delivered ?? {})
    const plan = planFix({ pr: { ...pr, checks: pr.checks.filter((check) => !paired.has(check.name)) }, requiredNames: ctx.required, rerun: new Set(rerun) })
    return { plan, items, relayed, rerun }
  }

  /**
   * One auto-fix look. Returns null when it acted or explained itself (a rerun,
   * a round, a wait, a needs-you), or the reason there is nothing to fix — in
   * which case auto-merge, if it is on, takes over.
   */
  private async autoFix(ctx: FixContext): Promise<string | null> {
    const { row, task, checkpoint, pr } = ctx
    const now = this.now()
    const say = this.fixSay(ctx)
    const { plan, items, relayed, rerun } = await this.fixPlan(ctx)
    // running, red or rerun: the quiet since it went green starts over at its next green
    if (plan.kind !== "none") { delete checkpoint.greenHead; delete checkpoint.greenAt }
    if (plan.kind === "rerun") {
      forgetPending(checkpoint)
      // Token-free, once per run and head: a flake gets a second chance
      // before anyone spends an agent turn on it.
      const accepted = await Promise.all(plan.runs.map((run) => this.github.rerunRun(ctx.repository, run, task.repo_path, ctx.signal).catch((error: unknown) => {
        // a pause is no refusal: the run is not marked tried, and the look pauses
        if (error instanceof GitHubPausedError) throw error
        // The history can only say "Could not rerun"; the daemon log keeps why.
        console.error(`[wisp] autopilot: could not rerun workflow run ${run} of ${ctx.repository}: ${error instanceof Error ? error.message : String(error)}`)
        return false
      })))
      // Tried is tried: a refused rerun is not asked for again, and the next look moves on.
      checkpoint.rerun = { head: pr.head, runs: [...rerun, ...plan.runs] }
      const reason = accepted.some(Boolean) ? plan.reason : plan.reason.replace(/^Rerunning/, "Could not rerun")
      recordWorkflow(row.id, "rerun", reason, now.toISOString(), null, { pr: pr.number, sha: pr.head })
      // the entry is news even when the reason reads the same as the last look's
      announceWorkflow(row.task_id)
      return say("waiting", reason, MOVING_MS)
    }
    const ci = ciToSend(plan, checkpoint, row.id)
    // read here, not left to auto-review's part of the look: its findings travel with the rest
    const review = ctx.autoReview ? reviewToCarry(row.id, checkpoint, pr) : null
    const key = [ci?.key, items.length > 0 ? feedbackKey(items) : null, review ? reviewKey(review) : null].filter(Boolean).join("|")
    // Only a countdown for this very evidence keeps a pending round, or a Send now.
    if (checkpoint.pending?.key !== key) forgetPending(checkpoint)
    if (checkpoint.logMisses && checkpoint.logMisses.key !== key) delete checkpoint.logMisses
    if (!key) {
      // Words that would ask for changes, relayed from someone the agent does
      // not take instructions from: never sent, and never merged past either.
      if (plan.kind === "none" && relayed.length > 0) {
        const bots = [...new Set(relayed.map((comment) => `@${comment.author}`))].slice(0, 2).join(" and ")
        return say("needs-you", `${bots} relayed a blocking comment from someone Wisp takes no instructions from`, WAITING_ON_YOU_MS)
      }
      return nothingToSend(plan, checkpoint, say)
    }
    const summary = [review ? "auto-review's findings" : null, ci?.summary, items.length > 0 ? feedbackSummary(items) : null].filter(Boolean).join(" and ")
    // A push would end the round running on this head: what auto-fix holds goes once it settles,
    // unless a person says Send now. Before the cap's pause, which would strand the round.
    if (ctx.autoReview && checkpoint.sendNow !== key && reviewRunning(row.id, pr)) return holdForReview(checkpoint, key, summary, now, say)
    if (checkpoint.pending) delete checkpoint.pending.afterReview
    const rounds = checkpoint.rounds ?? 0
    if (rounds >= MAX_ROUNDS) {
      writeAutopilotCheckpoint(row, { ...checkpoint, by: "auto-fix" }, now)
      pauseAutopilot(getWorkflow(row.id) ?? row, `Auto-fix gave up after ${MAX_ROUNDS} rounds — resume to try again`, now)
      return null
    }
    // A reviewer bot still at work on this head: the whole round, CI's part too, waits for its pass.
    const passes = reviewerPasses(pr, items, { headSeenMs: headFirstSeen(checkpoint, pr, now.getTime()), nowMs: now.getTime() })
    if (passes.wait) { forgetPending(checkpoint); return say("waiting", passes.wait, MOVING_MS) }
    // A short delay after the task goes idle, after the newest review words
    // (a reviewer's burst goes as one), and after a reviewer bot's check
    // ends (it may rewrite its summary a moment later): time to read what
    // it did and steer by hand first. Send now or Skip act on it.
    const settled = Math.max(Date.parse(checkpoint.idleSince ?? now.toISOString()), ...[...items.map((item) => item.at), ...passes.finished].map((at) => Date.parse(at)).filter(Number.isFinite))
    const sendsAt = settled + SEND_DELAY_MS
    if (checkpoint.sendNow !== key && now.getTime() < sendsAt) {
      checkpoint.pending = { key, summary, sendsAt: new Date(sendsAt).toISOString() }
      return say("waiting", `Auto-fix will send: ${summary}`, Math.max(5_000, sendsAt - now.getTime()))
    }
    return this.sendRound({ ...ctx, content: { ci, items, review, summary }, key, round: rounds + 1 })
  }

  /** Auto-fix's words: saved, or kept for a look that reviews early to weigh. */
  private fixSay(ctx: FixContext): (state: AutopilotState, reason: string, delayMs: number) => null {
    return (state, reason, delayMs) => {
      const check: AutopilotCheck = { state, reason, checkpoint: ctx.checkpoint, delayMs, about: "pr", by: "auto-fix" }
      if (ctx.speak) ctx.speak(check)
      else this.saveCheck(ctx.row, check)
      return null
    }
  }

  /** Auto-review's look at this head (auto-review.ts): "passed", "deferred" (auto-fix sends its findings), or null when it acted or explained itself. */
  private autoReview(
    row: WorkflowRow, task: Task, checkpoint: AutopilotCheckpoint, pr: PrSnapshot, required: ReadonlySet<string>, autoFix: boolean,
    start: Pick<ReviewStart, "early" | "by"> = { early: null, by: null }, speak?: (check: AutopilotCheck) => void,
  ): Promise<"passed" | "deferred" | null> {
    const launch: Launch = this.options.launch ?? ((input) => createAndLaunchTask(input, this.cfg, this.adapters, this.options.models ?? null))
    return autoReviewLook({
      row, task, checkpoint, pr, required, autoFix, early: start.early, startedBy: start.by, now: this.now(), start: { cfg: this.cfg, adapters: this.adapters, launch },
      hasSlot: (t, workload) => this.hasSlot(t, workload),
      say: (state, reason, delayMs, patient) => {
        const check: AutopilotCheck = { state, reason, checkpoint, delayMs, about: "pr", by: "auto-review", patient }
        if (speak) speak(check)
        else this.saveCheck(row, check)
        return null
      },
    })
  }

  /** Review feedback the agent has not seen, from people and bots it may take instructions from. */
  private async feedbackFor(ctx: FixContext): Promise<{ items: FeedbackItem[]; relayed: PrComment[] }> {
    const { pr, task, row, checkpoint } = ctx
    const trusts = await this.trust.trustsFor(pr, ctx.repository, task, ctx.signal)
    // Turns that began before auto-fix was armed were never asked to mark
    // their posts: the owner's-account comments inside them are the agent's.
    const windows = unmarkedTurns(task.id, checkpoint.fixArmedAt ?? row.created_at, checkpoint.unmarkedTurns ?? [])
    const self = (comment: PrComment) => isMarked(comment.body) || (comment.author === pr.viewer && windows.some((turn) => {
      const at = Date.parse(comment.createdAt)
      return at >= Date.parse(turn.started_at) && at <= (turn.ended_at ? Date.parse(turn.ended_at) : Infinity)
    }))
    const input = { pr, trusts, self, delivered: checkpoint.delivered ?? {}, judged: ctx.judged }
    return { items: feedbackItems(input), relayed: relayedBlocks(input) }
  }

  /**
   * The review judge's reading of bot words GitHub's signals leave undecided
   * (judge.ts), or null without a key: then no stored answer counts either.
   */
  private async judgeReviews(ctx: {
    row: WorkflowRow; task: Task; checkpoint: AutopilotCheckpoint; pr: PrSnapshot; repository: string; autoFix: boolean; signal: AbortSignal
  }): Promise<JudgeLook | null> {
    const { row, task, checkpoint, pr, signal } = ctx
    const key = this.options.judge ? null : jevKey(this.cfg)
    const client = this.options.judge ?? (key ? jevClient(key.key) : null)
    if (!client) return null
    // only bots' words are ever candidates for the kind question; the agent never posts as one
    const candidates = judgeCandidates({ pr, trusts: ({ author, bot }) => bot && author !== null && author !== "github-actions", self: (comment) => isMarked(comment.body) })
    // an approval's notes can only become an auto-fix round, so they are asked about only then
    if (ctx.autoFix) candidates.push(...approvalCandidates({ pr, trusts: await this.trust.trustsFor(pr, ctx.repository, task, signal) }))
    const look = await judgeLook({
      candidates, checkpoint, client, pr, signal, now: this.now,
      log: (entry) => {
        writeJudgeLog(task.id, row.id, entry)
        // only what can change what happens: status boards would crowd the history out
        if (entry.answer && needsChanges(entry.answer)) {
          recordWorkflow(row.id, "judged", `@${entry.author ?? "ghost"}'s ${entry.postedAs}: needs changes (${entry.answer.confidence.toFixed(2)})`, entry.at)
          announceWorkflow(row.task_id)
        }
      },
    })
    for (const id of look.gaveUp) {
      recordWorkflow(row.id, "judge-unavailable", `The review judge failed ${JUDGE_FAILURE_LIMIT} times on ${id}; auto-merge no longer waits for it`, this.now().toISOString())
    }
    if (look.gaveUp.length > 0) announceWorkflow(row.task_id)
    return look
  }

  /** Gather one round's evidence and queue it for the agent, unless something moved meanwhile. */
  private async sendRound(ctx: FixContext & { content: RoundContent; key: string; round: number }): Promise<null> {
    const { row, task, checkpoint, pr, content, key, round } = ctx
    const say = this.fixSay(ctx)
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
    // review findings never wait on CI's logs: that part goes with links only
    if (evidence.logsWanted > 0 && evidence.logsRead === 0 && !content.review) {
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
      ...checkpoint, rounds: round, lastRoundAt: this.now().toISOString(), done: undefined, greenHead: undefined, greenAt: undefined,
      delivered: withDelivered(checkpoint.delivered, Object.fromEntries(content.items.map((item) => [item.id, item.fingerprint]))),
      sentCi: content.ci ? [...(checkpoint.sentCi ?? []).slice(-20), content.ci.key] : checkpoint.sentCi,
      reviewsSent: content.review ? withReviewsSent(checkpoint.reviewsSent, [content.review.id]) : checkpoint.reviewsSent,
    }
    forgetIdle(next)
    delete next.logMisses
    // From here to the turn's start nothing awaits, so the slot seen free is
    // the slot the turn takes: another look or task cannot take it between.
    if (!this.hasSlot(task)) return say("waiting", "Waiting for a free task slot", MOVING_MS)
    // after every await: a paused log read or an abort above cannot leave the review's images behind
    const messageId = randomId("m", 12)
    const review = content.review ? reviewFiles(this.adapters, { task, row, checkpoint: next, pr }, content.review, messageId) : null
    const id = reserveWith(review, () => reserveRound(row, {
      key, prompt: roundMessage({ ...content, pr, round, file: evidence.file, autoMerge: ctx.autoMerge, signature, reviewLines: review?.lines }),
      reason: `Sent ${content.summary} (round ${round} of ${MAX_ROUNDS}${review ? `; auto-review ${review.words}` : ""})`, checkpoint: next, turnCount: task.turn_count,
      messageId, attachments: review?.attachments, source: { by: "autopilot", kind: "auto-fix", pr: pr.number, round, rounds: MAX_ROUNDS },
    }, this.now()))
    // A user message queued first still goes first; this round then waits,
    // and the next look withdraws it and plans again.
    if (id) startNextQueuedMessage(task.id, this.adapters, this.cfg, id)
    return null
  }

  /** A reviewer or recipe launch is held to the global limit only; the task's own turn also to its parent's cap. */
  private hasSlot(task: Task, workload: Workload = "turn"): boolean {
    return hasTaskCapacity(this.cfg, task.id, { workload })
  }

  /** A held row whose merge was under way: settle it if the PR is no longer open. */
  private async settledWhileHeld(row: WorkflowRow, task: Task, checkpoint: AutopilotCheckpoint, signal: AbortSignal): Promise<boolean> {
    const repository = await this.repositoryOf(task, signal)
    const pr = repository ? await this.github.snapshot(repository, checkpoint.pr!, task.repo_path, signal).catch(() => null) : null
    if (!pr || pr.state === "OPEN") return false
    this.settle(row, checkpoint, pr)
    return true
  }

  /** GitHub's own auto-merge is on: that pause is auto-merge's, whichever switch spoke last. */
  private providerPause(row: WorkflowRow, checkpoint: AutopilotCheckpoint, pr: PrSnapshot): void {
    writeAutopilotCheckpoint(row, { ...checkpoint, by: "auto-merge" }, this.now())
    pauseAutopilot(getWorkflow(row.id) ?? row, `GitHub auto-merge was turned on for #${pr.number} — resume to let Wisp decide`, this.now())
  }

  /** The PR number to bind to, or the reason there is none yet. */
  private async bind(
    row: WorkflowRow, task: Task, repository: string, configured: string | undefined, checkpoint: AutopilotCheckpoint, signal: AbortSignal,
  ): Promise<{ number: number } | string> {
    const branches = await (this.options.branches ?? ((t, s) => taskBranches(t, bunProbeSpawn, s)))(task, signal)
    const { defaultBranch, viewer, pulls } = await this.github.openPullRequests(repository, branches, task.repo_path, signal)
    const mergedPr = checkpoint.lastMerged?.pr
    const pick = choosePull(pulls, task, viewer, new Set([defaultBranch, configured].filter((b): b is string => Boolean(b))), mergedPr)
    if (!pick) {
      const skipped = skippedPull(pulls, task, viewer, mergedPr)
      return skipped ? `Waiting for this task's own PR (${skipped})` : "Waiting for a PR"
    }
    recordWorkflow(row.id, "bound", `Watching PR #${pick.number}`, this.now().toISOString(), null, { pr: pick.number })
    return { number: pick.number }
  }

  /**
   * The bound PR is no longer open. A merge is the task moving on, so the
   * switches stay on for its next PR; closing one is how its owner abandons
   * an approach, so that stands them down.
   */
  private settle(row: WorkflowRow, checkpoint: AutopilotCheckpoint, pr: PrSnapshot): void {
    const now = this.now()
    if (pr.state === "MERGED") {
      const ours = checkpoint.mergeAttempt?.head === pr.head
      rebindAfterMerge(row, { pr: pr.number, base: pr.baseRefName, byWisp: ours }, now, pr.head)
      if (ours) recordAudit(row.task_id, "merge", "autopilot", `#${pr.number} at ${pr.head.slice(0, 7)} into ${pr.baseRefName}`, now)
      return
    }
    // Closing a PR is how its owner abandons an approach: never move on to another.
    finishAutopilot(row, "closed", `Auto-merge off — #${pr.number} was closed`, now)
    recordAudit(row.task_id, "autopilot", "autopilot", `auto-merge and auto-fix off: #${pr.number} was closed`, now)
  }

  private async baseRules(repository: string, base: string, cwd: string, signal: AbortSignal): Promise<BaseRules> {
    const key = `${repository}#${base}`
    const hit = this.required.get(key)
    if (hit && this.now().getTime() - hit.at < REQUIRED_TTL_MS) return hit.rules
    // Unreadable protection counts as no required checks, which is the
    // STRICTER branch: every check then counts. Cached briefly so a flaky
    // read retries soon. The read itself is shared by looks side by side.
    const at = this.now().getTime()
    const rules = this.github.requiredChecks(repository, base, cwd, signal).catch((error: unknown) => {
      // REST paused: the last rules read stand in until it resumes; with none, the look pauses
      if (error instanceof GitHubPausedError && hit) { this.required.set(key, hit); return hit.rules }
      if (error instanceof GitHubPausedError) { this.required.delete(key); throw error }
      const none: BaseRules = { checks: [], classicProtection: null }
      this.required.set(key, { rules: Promise.resolve(none), at: at - REQUIRED_TTL_MS + 60_000 })
      return none
    })
    this.required.set(key, { rules, at })
    return rules
  }

  /** A paused row still notices a PR that someone merged or closed, so it never sits paused on a finished PR. */
  private async pausedLifecycle(row: WorkflowRow, signal: AbortSignal): Promise<void> {
    const checkpoint = checkpointOf(row)
    const task = getTask(row.task_id)
    const repository = task && checkpoint.pr ? await this.repositoryOf(task, signal) : null
    const pr = repository && task ? await this.github.snapshot(repository, checkpoint.pr!, task.repo_path, signal).catch(() => null) : null
    if (pr && pr.state !== "OPEN") { this.settle(row, checkpoint, pr); return }
    deferAutopilot(row, new Date(this.now().getTime() + BUSY_MS))
  }

  private async merge(
    row: WorkflowRow, checkpoint: AutopilotCheckpoint, pr: PrSnapshot, repository: string,
    look: { turnCount: number; evidence: string },
  ): Promise<void> {
    const now = this.now()
    // Pre-flight, with no await between it and the merging guard: a toggle,
    // a Stop, or a turn that started during the check all win — even one that
    // has already finished (it may have committed work the check never saw).
    const task = getTask(row.task_id)
    if (!task || !taskIsIdle(task) || task.turn_count !== look.turnCount) return
    // rights a parent passed on stand only while it still holds them from a person (subtask-policy.ts)
    const lost = inheritedRightsLost(task)
    if (lost) return void this.saveCheck(row, { state: "needs-you", reason: lost, checkpoint, delayMs: WAITING_ON_YOU_MS, about: "pr" })
    const attempt: AutopilotCheckpoint = { ...checkpoint, mergeAttempt: { head: pr.head, at: now.toISOString() }, state: "merging", about: "pr", by: "auto-merge" }
    delete attempt.done
    const merging = `Merging #${pr.number} (${pr.mergeMethod.toLowerCase()})`
    if (!writeAutopilotCheckpoint(row, attempt, now, merging)) return
    // the durable record of a merge on the owner's behalf: which head, into what, and on what evidence
    recordWorkflow(row.id, "merging", `Merging #${pr.number} at ${pr.head.slice(0, 7)} into ${pr.baseRefName} (${pr.mergeMethod.toLowerCase()}) · ${look.evidence}`,
      now.toISOString(), null, { pr: pr.number, sha: pr.head })
    // The merge has its own deadline, not the check's: a slow read before it
    // must never be what kills `gh pr merge` halfway. Nor does stop(): a
    // daemon shutting down lets a started merge finish and record how it
    // ended. Cancelled, gh reports a failure, and the row would say "Merge
    // failed, retrying" and forget the attempt. If the process exits first,
    // the attempt stays in the checkpoint for the next look to confirm.
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    const deadline = setTimeout(abort, 120_000)
    try {
      // Settle INSIDE the guard: a message that queued during the merge starts
      // only after the row says how it ended, so its turn is told the branch
      // is finished instead of being asked to push to a merged PR.
      await whileMerging(task.id, async () => {
        const result = await this.github.merge({ repository, number: pr.number, method: pr.mergeMethod, head: pr.head }, task.repo_path, controller.signal).catch((error: unknown) => {
          // held back before it went out: there was no merge, so there is no attempt to confirm
          if (error instanceof GitHubPausedError && !error.sent) endMergeAttempt(getWorkflow(row.id) ?? row, false)
          throw error
        })
        const after = await this.github.snapshot(repository, pr.number, task.repo_path, controller.signal).catch(() => null)
        this.afterMerge(row, attempt, pr, result, after)
      }, () => { startNextQueuedMessage(task.id, this.adapters, this.cfg) })
    } finally {
      clearTimeout(deadline)
    }
  }

  private afterMerge(row: WorkflowRow, started: AutopilotCheckpoint, pr: PrSnapshot, result: { ok: boolean; detail: string }, after: PrSnapshot | null): void {
    const current = getWorkflow(row.id)
    if (!result.ok && after?.state !== "MERGED" && current) {
      recordWorkflow(current.id, "merge-failed", `Merge of #${pr.number} at ${pr.head.slice(0, 7)} failed: ${result.detail || "gh pr merge did not merge"}`,
        this.now().toISOString(), null, { pr: pr.number, sha: pr.head })
      // a paused or switched-off row saves no check after this, so nothing else would say it
      announceWorkflow(current.task_id)
    }
    // Switched off (or archived) while gh ran, and it merged: still record
    // whose merge it was. rebindAfterMerge never re-arms a finished row.
    if (current && current.state !== "active" && after?.state === "MERGED") { this.settle(current, started, after); return }
    if (!current) return
    if (current.state !== "active") { endMergeAttempt(current, result.ok); return }
    // What changed about the task while gh ran (a Stop hold, auto-fix armed,
    // an unsigned turn) is kept: only the merge's own fields come from before.
    const fresh = checkpointOf(current)
    const attempt: AutopilotCheckpoint = { ...started, stopHold: fresh.stopHold, fixArmedAt: fresh.fixArmedAt, reviewArmedAt: fresh.reviewArmedAt, unmarkedTurns: fresh.unmarkedTurns }
    for (const key of ["stopHold", "fixArmedAt", "reviewArmedAt", "unmarkedTurns"] as const) if (attempt[key] === undefined) delete attempt[key]
    if (after && after.state !== "OPEN") { this.settle(current, attempt, after); return }
    if (after?.queued) { this.saveCheck(current, { state: "queued", reason: "Queued to merge", checkpoint: attempt, delayMs: MOVING_MS, about: "pr" }); return }
    if (after?.providerAutoMerge) {
      // no longer confirming anything: turns during the pause may push
      this.providerPause(current, { ...attempt, state: "waiting" }, pr)
      return
    }
    if (result.ok) {
      // gh said it merged but the read disagrees or failed (read-after-write
      // lag, a timeout): not a failure. Keep the attempt, so the next look
      // records it as Wisp's merge, and look again soon.
      const confirming: AutopilotCheckpoint = { ...attempt, mergeAttempt: { ...attempt.mergeAttempt!, reported: true } }
      this.saveCheck(current, { state: "merging", reason: "Confirming the merge", checkpoint: confirming, delayMs: 15_000, about: "pr" })
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
    this.saveCheck(current, { state: "waiting", reason: `Merge failed, retrying: ${detail}`.slice(0, 300), checkpoint: failed, delayMs: 2 * MOVING_MS, about: "pr" })
  }
}
