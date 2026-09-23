/**
 * What auto-fix should do about a PR's CI right now. Pure: the caller gathers
 * the snapshot and the required-check names; this only decides.
 *
 * It thinks in WORKFLOW RUNS, because that is how GitHub groups jobs. A red
 * counting check decides that there is something to fix; what the agent must
 * read is that check AND the jobs that failed beside it in the same run — on a
 * repository whose required check is an aggregator (`test` needing six
 * shards) the aggregator's own log only says "a required part did not
 * succeed", and the shard is what explains it. Together they are the LEAVES:
 * they drive the logs, the evidence key, and the comparison with the base.
 */
import { classifyCheck, countingChecks, missingRequired, type PrCheck } from "./checks"
import type { PrSnapshot } from "./github"

type Fix = {
  kind: "fix"; reason: string; key: string; summary: string; conflict: boolean
  /** the counting checks that decided */
  failing: PrCheck[]
  /** the jobs that failed, whose logs the agent gets */
  leaves: PrCheck[]
  /** other red checks on the head that do not count: listed as context, never as the task */
  context: PrCheck[]
}

export type FixPlan =
  /** CI is green (or its reds are not the PR's) — nothing for auto-fix to do */
  | { kind: "none"; reason: string }
  /** something moves on its own */
  | { kind: "wait"; reason: string }
  /** a token-free rerun of these workflow runs' failed jobs, once per head */
  | { kind: "rerun"; reason: string; runs: number[] }
  /** steer the agent: `key` identifies this evidence, so it is sent once */
  | Fix
  /** only a person can move this */
  | { kind: "needs-you"; reason: string }

export interface FixInput {
  pr: PrSnapshot
  requiredNames: ReadonlySet<string>
  /** workflow run ids already rerun for this head */
  rerun: ReadonlySet<number>
}

const names = (checks: PrCheck[]): string => {
  const listed = checks.slice(0, 2).map((check) => check.name).join(", ")
  return checks.length > 2 ? `${listed} and ${checks.length - 2} more` : listed
}
const red = (check: PrCheck): boolean => ["fix", "hold"].includes(classifyCheck(check))
const upper = (value: string | null | undefined): string => (value ?? "").toUpperCase()
/** held for a person: an approval gate, or an environment waiting on its reviewers */
const awaitsApproval = (check: PrCheck): boolean =>
  upper(check.conclusion) === "ACTION_REQUIRED" || (!check.conclusion && upper(check.status) === "WAITING")

function sameRun(pr: PrSnapshot, check: PrCheck): PrCheck[] {
  return check.run ? pr.checks.filter((other) => other.run?.id === check.run!.id) : [check]
}

const failed = (check: PrCheck): boolean => classifyCheck(check) === "fix"

/**
 * A red counting check and the jobs that failed beside it. When the run has a
 * real failure, its cancelled jobs are fail-fast's doing, not evidence.
 */
function leavesOf(pr: PrSnapshot, check: PrCheck): PrCheck[] {
  const run = sameRun(pr, check).filter((other) => other !== check && red(other))
  const real = run.filter(failed)
  return [check, ...(real.length > 0 ? real : run)]
}

/** Real failures before jobs that did not finish, counting checks first within each: the order logs are read in. */
function ordered(leaves: PrCheck[], counting: ReadonlySet<PrCheck>): PrCheck[] {
  const rank = (check: PrCheck) => (failed(check) ? 0 : 2) + (counting.has(check) ? 0 : 1)
  return [...leaves].sort((a, b) => rank(a) - rank(b))
}

/** A job that did not finish in a run with a real failure: fail-fast cancelled it, so it explains nothing. */
function failFast(pr: PrSnapshot, check: PrCheck): boolean {
  return !failed(check) && Boolean(check.run) && sameRun(pr, check).some(failed)
}

function unique(checks: PrCheck[]): PrCheck[] {
  return [...new Set(checks)]
}

/**
 * A run Wisp may rerun without anyone's say: an ordinary PR run, not rerun on
 * this head yet, with no deployment job in it (a rerun reruns dependents too).
 * A run whose jobs were cancelled with no real failure among them (a lost
 * runner, a superseded run) earns one; one with a real failure only when there
 * are no required checks, where every check counts and a flake would
 * otherwise cost a turn. A failure that fail-fast cancelled the rest for is
 * trusted, not retried.
 */
function rerunnable(pr: PrSnapshot, check: PrCheck, input: FixInput): boolean {
  if (!check.run || check.run.event !== "pull_request" || input.rerun.has(check.run.id)) return false
  const jobs = sameRun(pr, check)
  if (jobs.some((job) => job.deployment)) return false
  if (jobs.some(failed)) return input.requiredNames.size === 0
  return jobs.some((job) => ["CANCELLED", "STALE"].includes(upper(job.conclusion)))
}

type BaseVerdict = "red" | "not-red" | "pending"

/** Is this failing job red on the base branch's head too? */
function onBase(pr: PrSnapshot, leaf: PrCheck): BaseVerdict {
  const base = pr.baseChecks.find((candidate) => candidate.name === leaf.name)
  if (!base) return "not-red"
  const state = classifyCheck(base)
  return state === "pending" ? "pending" : state === "fix" ? "red" : "not-red"
}

/**
 * A red counting check is the base's, not the PR's, only when every leaf is
 * red on the base too. One leaf that is not settles it without waiting; the
 * base's still-running jobs are waited for only when they could decide.
 */
function baseVerdict(pr: PrSnapshot, leaves: PrCheck[]): BaseVerdict {
  const verdicts = leaves.map((leaf) => onBase(pr, leaf))
  if (verdicts.includes("not-red")) return "not-red"
  return verdicts.includes("pending") ? "pending" : "red"
}

export function planFix(input: FixInput): FixPlan {
  const { pr } = input
  if (pr.mergeState === "DIRTY") {
    return {
      kind: "fix", reason: `Conflicts with ${pr.baseRefName}`, conflict: true, failing: [], leaves: [], context: [],
      key: `conflict:${pr.head}:${pr.baseHead ?? ""}`, summary: `a merge conflict with ${pr.baseRefName}`,
    }
  }
  const counting = countingChecks(pr.checks, input.requiredNames)
  const approval = counting.filter(awaitsApproval)
  if (approval.length > 0) return { kind: "needs-you", reason: `${names(approval)} needs approval` }
  const missing = missingRequired(pr.checks, input.requiredNames)
  if (missing.length > 0) return { kind: "wait", reason: `Waiting for ${missing.slice(0, 2).join(", ")} to report` }
  const running = counting.filter((check) => classifyCheck(check) === "pending")
  // All of a head's results in one round, never a piece now and a piece later.
  // Without required checks every check counts, so a suite that has not
  // reported yet is one; with them, missingRequired already said so.
  if (running.length > 0) return { kind: "wait", reason: `Waiting for checks (${running.length} running)` }
  if (input.requiredNames.size === 0 && pr.actionsSuitesPending > pr.actionsSuitesWaiting) return { kind: "wait", reason: "Waiting for checks to start" }
  const deciding = counting.filter(red)
  if (deciding.length === 0) return { kind: "none", reason: "Nothing to fix" }
  // The runs behind a red must be finished, and their jobs read, before anything is decided.
  if (deciding.some((check) => sameRun(pr, check).some((job) => classifyCheck(job) === "pending"))) {
    return { kind: "wait", reason: "Waiting for the failing run to finish" }
  }
  const held = unique(deciding.flatMap((check) => leavesOf(pr, check))).filter(awaitsApproval)
  if (held.length > 0) return { kind: "needs-you", reason: `${names(held)} needs approval` }
  const retry = [...new Set(deciding.filter((check) => rerunnable(pr, check, input)).map((check) => check.run!.id))]
  if (retry.length > 0) {
    const jobs = unique(deciding.filter((check) => check.run && retry.includes(check.run.id)).flatMap((check) => leavesOf(pr, check)))
    return { kind: "rerun", reason: `Rerunning ${names(jobs)}`, runs: retry }
  }
  const failing: PrCheck[] = []
  for (const check of deciding) {
    const verdict = baseVerdict(pr, leavesOf(pr, check))
    if (verdict === "pending") return { kind: "wait", reason: `Waiting for ${pr.baseRefName}'s checks, to compare` }
    if (verdict === "not-red") failing.push(check)
  }
  if (failing.length === 0) {
    return { kind: "none", reason: `${names(deciding)} ${deciding.length === 1 ? "is" : "are"} red on ${pr.baseRefName} too` }
  }
  // Where every check counts (or a matrix's entries are each required), a
  // cancelled job is a deciding check of its own: fail-fast's are still noise.
  const deciders = failing.some((check) => !failFast(pr, check)) ? failing.filter((check) => !failFast(pr, check)) : failing
  const leaves = ordered(unique(deciders.flatMap((check) => leavesOf(pr, check))).filter((leaf) => !failFast(pr, leaf)), new Set(counting))
  if (leaves.every((leaf) => classifyCheck(leaf) === "hold")) {
    return { kind: "needs-you", reason: `${names(leaves)} did not finish — rerun it` }
  }
  const context = pr.checks.filter((check) => red(check) && !leaves.includes(check) && !failFast(pr, check))
  return {
    kind: "fix", reason: `${names(leaves)} failed`, conflict: false, failing: deciders, leaves, context,
    key: `ci:${pr.head}:${leaves.map((leaf) => leaf.name).sort().join(",")}`, summary: `${names(leaves)} failing`,
  }
}
