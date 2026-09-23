/**
 * What auto-fix should do about a PR's CI right now. Pure: the caller gathers
 * the snapshot and the required-check names; this only decides.
 *
 * Deciding and showing are separate on purpose. Whether to steer is decided by
 * the COUNTING checks — the required ones when the base has any — but the
 * evidence holds every failing job on the head. On a repository whose required
 * check is an aggregator (`test` needing six shards), the aggregator's own log
 * only says "a required part did not succeed"; the shard that failed is the
 * one the agent needs to read.
 */
import { classifyCheck, countingChecks, type PrCheck } from "./checks"
import type { PrSnapshot } from "./github"

export type FixPlan =
  /** CI is green (or still running) — nothing for auto-fix to do */
  | { kind: "none"; reason: string }
  /** something moves on its own */
  | { kind: "wait"; reason: string }
  /** a token-free rerun first: these jobs, once each per head */
  | { kind: "rerun"; reason: string; checks: PrCheck[] }
  /** steer the agent: `key` identifies this evidence, so it is sent once */
  | { kind: "fix"; reason: string; key: string; summary: string; failing: PrCheck[]; evidence: PrCheck[]; conflict: boolean }
  /** only a person can move this */
  | { kind: "needs-you"; reason: string }

export interface FixInput {
  pr: PrSnapshot
  requiredNames: ReadonlySet<string>
  /** `${head}:${check name}` for every job already rerun */
  rerun: ReadonlySet<string>
}

const names = (checks: PrCheck[]): string => {
  const listed = checks.slice(0, 2).map((check) => check.name).join(", ")
  return checks.length > 2 ? `${listed} and ${checks.length - 2} more` : listed
}

/** Red on the base branch's head as well, with both runs finished: not this PR's to fix. */
function redOnBase(check: PrCheck, pr: PrSnapshot): boolean {
  const base = pr.baseChecks.find((candidate) => candidate.name === check.name)
  return base !== undefined && classifyCheck(base) === "fix"
}

/** A rerun Wisp may start without anyone's say: an ordinary PR job, finished. */
function rerunnable(check: PrCheck, input: FixInput): boolean {
  if (!check.checkRunId || !check.run || check.run.event !== "pull_request" || check.deployment) return false
  if (input.rerun.has(`${input.pr.head}:${check.name}`)) return false
  const conclusion = check.conclusion?.toUpperCase()
  // With required checks the red is trusted: only a cancelled job is rerun.
  // Without any, every check counts, so a flaky one gets one free retry.
  if (conclusion === "CANCELLED") return true
  return input.requiredNames.size === 0 && (conclusion === "FAILURE" || conclusion === "TIMED_OUT")
}

export function planFix(input: FixInput): FixPlan {
  const { pr } = input
  if (pr.mergeState === "DIRTY") {
    return {
      kind: "fix", reason: `Conflicts with ${pr.baseRefName}`, conflict: true, failing: [], evidence: [],
      key: `conflict:${pr.head}:${pr.baseHead ?? ""}`, summary: `a merge conflict with ${pr.baseRefName}`,
    }
  }
  const counting = countingChecks(pr.checks, input.requiredNames)
  const running = counting.filter((check) => classifyCheck(check) === "pending")
  // All of a head's results in one round, never a piece now and a piece later.
  if (running.length > 0 || pr.actionsSuitesPending > pr.actionsSuitesWaiting) {
    return { kind: "wait", reason: running.length > 0 ? `Waiting for checks (${running.length} running)` : "Waiting for checks to start" }
  }
  const approval = counting.filter((check) => check.conclusion?.toUpperCase() === "ACTION_REQUIRED")
  if (approval.length > 0) return { kind: "needs-you", reason: `${names(approval)} needs approval` }
  const red = counting.filter((check) => ["fix", "hold"].includes(classifyCheck(check)))
  const retry = red.filter((check) => rerunnable(check, input))
  if (retry.length > 0) return { kind: "rerun", reason: `Rerunning ${names(retry)}`, checks: retry }
  const stuck = red.filter((check) => classifyCheck(check) === "hold")
  if (stuck.length > 0) return { kind: "needs-you", reason: `${names(stuck)} did not finish — rerun it` }
  const failing = red.filter((check) => !redOnBase(check, pr))
  if (failing.length === 0) {
    return red.length > 0
      ? { kind: "none", reason: `${names(red)} ${red.length === 1 ? "is" : "are"} red on ${pr.baseRefName} too` }
      : { kind: "none", reason: "Nothing to fix" }
  }
  // Every failing job on the head, the deciding ones first: the log that says
  // why lives in a job, not necessarily in the check that decided.
  const evidence = [...failing, ...pr.checks.filter((check) => classifyCheck(check) === "fix" && !failing.includes(check))]
  const signature = failing.map((check) => check.name).sort().join(",")
  return {
    kind: "fix", reason: `${names(failing)} failed`, conflict: false, failing, evidence,
    key: `ci:${pr.head}:${signature}`, summary: `${names(failing)} failing`,
  }
}
