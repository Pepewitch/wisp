/**
 * Whether a pull request may be merged right now, and if not, the ONE reason
 * worth showing. Pure: the caller gathers the snapshot, the required-check
 * names, and the state of the local worktree; this only decides.
 *
 * The order is the order a person would fix things in: a draft or a wrong base
 * before checks, a red check before a review, and the local worktree last,
 * because it is the only thing Wisp can see that GitHub cannot.
 */
import { classifyCheck, countingChecks, missingRequired, type PrCheck } from "./checks"
import type { PrReview, PrSnapshot } from "./github"
import { parseVerdict } from "./verdict"

/** A fresh head gets this long before an empty or green rollup is believed. */
export const FRESH_HEAD_MS = 2 * 60_000

export type GateResult =
  | { kind: "merge" }
  /** something that moves on its own; check again soon */
  | { kind: "wait"; reason: string }
  /** blocked until a person (or a later push) changes something */
  | { kind: "needs-you"; reason: string }

export type PublishedWork = { ok: true } | { ok: false; reason: string }

export interface GateInput {
  pr: PrSnapshot
  requiredNames: ReadonlySet<string>
  /** the default branch, plus the project's configured base when it has one */
  allowedBases: ReadonlySet<string>
  headFirstSeenMs: number
  nowMs: number
  published: PublishedWork
}

const short = (sha: string): string => sha.slice(0, 7)

function names(checks: PrCheck[]): string {
  const listed = checks.slice(0, 2).map((check) => check.name).join(", ")
  return checks.length > 2 ? `${listed} and ${checks.length - 2} more` : listed
}

function checksGate(input: GateInput): GateResult | null {
  const { pr, requiredNames } = input
  if (input.nowMs - input.headFirstSeenMs < FRESH_HEAD_MS || pr.actionsSuitesPending > 0) {
    const running = pr.checks.filter((check) => classifyCheck(check) === "pending").length
    if (pr.actionsSuitesPending > 0 || running > 0) return { kind: "wait", reason: `Waiting for checks (${Math.max(running, pr.actionsSuitesPending)} running)` }
    return { kind: "wait", reason: "Waiting for checks to start" }
  }
  const counting = countingChecks(pr.checks, requiredNames)
  const fixes = counting.filter((check) => classifyCheck(check) === "fix")
  if (fixes.length > 0) return { kind: "needs-you", reason: `${names(fixes)} failed` }
  const holds = counting.filter((check) => classifyCheck(check) === "hold")
  if (holds.length > 0) {
    const approval = holds.filter((check) => check.conclusion?.toUpperCase() === "ACTION_REQUIRED")
    return approval.length > 0
      ? { kind: "needs-you", reason: `${names(approval)} needs approval` }
      : { kind: "needs-you", reason: `${names(holds)} did not finish — rerun it` }
  }
  const missing = missingRequired(pr.checks, requiredNames)
  if (missing.length > 0) return { kind: "wait", reason: `Waiting for ${missing.slice(0, 2).join(", ")} to report` }
  const pending = counting.filter((check) => classifyCheck(check) === "pending")
  if (pending.length > 0) return { kind: "wait", reason: `Waiting for checks (${pending.length} running)` }
  return null
}

function trusted(review: PrReview): boolean {
  if (review.author === null || review.author === "github-actions") return false
  if (review.state === "PENDING" || review.state === "DISMISSED") return false
  return review.bot || ["OWNER", "MEMBER", "COLLABORATOR"].includes(review.association)
}

type Signal = "approve" | "block" | "unparseable" | "state-block"

function signalOf(review: PrReview): Signal | null {
  const verdict = parseVerdict(review.body)
  if (verdict === "approve") return "approve"
  if (verdict === "blocking") return "block"
  if (verdict === "unparseable") return "unparseable"
  if (review.state === "APPROVED") return "approve"
  if (review.state === "CHANGES_REQUESTED") return "state-block"
  return null
}

/**
 * Once a reviewer has blocked, the merge waits for THAT reviewer's pass on the
 * current head. There is no timer: 39 of the owner's last 40 PRs had no review
 * at all, so waiting "a while" for one is pure delay, and when a reviewer has
 * spoken, a timer would ship a fix nobody looked at.
 */
function reviewGate(pr: PrSnapshot): GateResult | null {
  const byAuthor = new Map<string, { signal: Signal; review: PrReview }[]>()
  for (const review of pr.reviews) {
    if (!trusted(review)) continue
    const signal = signalOf(review)
    if (!signal) continue
    const list = byAuthor.get(review.author!) ?? []
    list.push({ signal, review })
    byAuthor.set(review.author!, list)
  }
  for (const [author, entries] of byAuthor) {
    entries.sort((a, b) => a.review.submittedAt.localeCompare(b.review.submittedAt))
    const lastBlock = [...entries].reverse().find((entry) => entry.signal !== "approve")
    if (!lastBlock) continue
    const passedHead = entries.some((entry) =>
      entry.signal === "approve" && entry.review.commit === pr.head && entry.review.submittedAt > lastBlock.review.submittedAt)
    if (passedHead) continue
    if (lastBlock.signal === "unparseable") return { kind: "needs-you", reason: "Couldn't read a review's verdict line" }
    if (lastBlock.signal === "state-block") {
      return lastBlock.review.body.trim() === ""
        ? { kind: "needs-you", reason: `Changes requested by @${author} with no comments` }
        : { kind: "needs-you", reason: `Changes requested by @${author}` }
    }
    // A verdict line is how the owner's own reviewer agents speak, from the
    // owner's account, so the reason names the commit rather than a login.
    return { kind: "wait", reason: `Waiting for the reviewer to pass ${short(pr.head)}` }
  }
  return null
}

function mergeStateGate(pr: PrSnapshot): GateResult | null {
  switch (pr.mergeState) {
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE":
      return null
    case "DIRTY":
      return { kind: "needs-you", reason: `Conflicts with ${pr.baseRefName}` }
    case "BEHIND":
      return { kind: "needs-you", reason: `Branch is behind ${pr.baseRefName} — update it` }
    case "BLOCKED":
      if (pr.unresolvedThreads > 0) {
        return { kind: "needs-you", reason: `${pr.unresolvedThreads} unresolved conversation${pr.unresolvedThreads === 1 ? "" : "s"}` }
      }
      if (pr.reviewDecision === "REVIEW_REQUIRED") return { kind: "wait", reason: "Waiting for an approving review" }
      if (pr.reviewDecision === "CHANGES_REQUESTED") return { kind: "needs-you", reason: "Changes requested" }
      return { kind: "needs-you", reason: "Blocked by a branch rule" }
    default:
      return { kind: "wait", reason: "Waiting for GitHub to work out mergeability" }
  }
}

export function mergeGate(input: GateInput): GateResult {
  const { pr } = input
  if (pr.isDraft) return { kind: "needs-you", reason: "Draft — mark it ready for review" }
  if (!input.allowedBases.has(pr.baseRefName)) {
    return { kind: "needs-you", reason: `Targets ${pr.baseRefName}, not ${pr.defaultBranch} — merge the parent first` }
  }
  return checksGate(input) ?? reviewGate(pr) ?? mergeStateGate(pr) ??
    (input.published.ok ? { kind: "merge" } : { kind: "needs-you", reason: input.published.reason })
}
