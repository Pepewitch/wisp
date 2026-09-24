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
  /** something that moves on its own; check again soon — or, `slow`, a person who has to act first */
  | { kind: "wait"; reason: string; slow?: boolean }
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
  /** bots whose latest verdict, about this head, the review judge read as asking for changes (judge.ts) */
  reviewerProblems?: { author: string; url: string }[]
  /** bots whose latest such verdict is about an earlier head: their pass on this one is awaited */
  reviewersAwaited?: string[]
  /** a bot's newest words are not judged yet */
  judgePending?: boolean
}

const short = (sha: string): string => sha.slice(0, 7)

function names(checks: PrCheck[]): string {
  const listed = checks.slice(0, 2).map((check) => check.name).join(", ")
  return checks.length > 2 ? `${listed} and ${checks.length - 2} more` : listed
}

function checksGate(input: GateInput): GateResult | null {
  const { pr, requiredNames } = input
  // A head Wisp has not timed (NaN) is as fresh as it gets.
  const fresh = !(input.nowMs - input.headFirstSeenMs >= FRESH_HEAD_MS)
  if (fresh || pr.actionsSuitesPending > 0) {
    const running = pr.checks.filter((check) => classifyCheck(check) === "pending").length
    // A run held for an environment's reviewers never starts on its own.
    if (!fresh && running === 0 && pr.actionsSuitesWaiting > 0) {
      return { kind: "needs-you", reason: "A workflow run is waiting for approval" }
    }
    return running > 0
      ? { kind: "wait", reason: `Waiting for checks (${running} running)` }
      : { kind: "wait", reason: "Waiting for checks to start" }
  }
  const counting = countingChecks(pr.checks, requiredNames)
  const fixes = counting.filter((check) => classifyCheck(check) === "fix")
  if (fixes.length > 0) return { kind: "needs-you", reason: `${names(fixes)} failed` }
  const holds = counting.filter((check) => classifyCheck(check) === "hold")
  if (holds.length > 0) {
    const approval = holds.filter((check) => check.conclusion?.toUpperCase() === "ACTION_REQUIRED" ||
      (!check.conclusion && check.status.toUpperCase() === "WAITING"))
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
  // A formal change request is never overridden by what its body says.
  if (review.state === "CHANGES_REQUESTED") return "state-block"
  const verdict = parseVerdict(review.body)
  if (verdict === "approve") return "approve"
  if (verdict === "blocking") return "block"
  if (verdict === "unparseable") return "unparseable"
  if (review.state === "APPROVED") return "approve"
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
    return { kind: "wait", reason: `Waiting for the reviewer to pass ${short(pr.head)}`, slow: true }
  }
  return null
}

/**
 * A bot the review judge heard ask for changes on this head holds the merge,
 * as a blocking verdict would: its next pass, on a new head, speaks again.
 */
function judgedGate(input: GateInput): GateResult | null {
  const listed = (authors: string[]) =>
    `${authors.slice(0, 2).map((author) => `@${author}`).join(" and ")}${authors.length > 2 ? ` and ${authors.length - 2} more` : ""}`
  const problems = [...new Set((input.reviewerProblems ?? []).map((problem) => problem.author))]
  if (problems.length > 0) return { kind: "needs-you", reason: `${listed(problems)} reported problems on ${short(input.pr.head)}` }
  if (input.judgePending) return { kind: "wait", reason: "Waiting for the review judge" }
  const awaited = [...new Set(input.reviewersAwaited ?? [])]
  if (awaited.length > 0) return { kind: "wait", reason: `Waiting for ${listed(awaited)} to review ${short(input.pr.head)}`, slow: true }
  return null
}

/**
 * Open conversations hold this PR's merge: the repository requires them
 * resolved, or its rule cannot be read (classic protection, not an admin) and
 * GitHub blocks the PR with nothing else to explain it.
 */
export function conversationsBlock(pr: PrSnapshot): boolean {
  if (pr.unresolvedThreads === 0) return false
  if (pr.conversationRule === "required") return true
  return pr.conversationRule === "unknown" && pr.mergeState === "BLOCKED" &&
    pr.reviewDecision !== "REVIEW_REQUIRED" && pr.reviewDecision !== "CHANGES_REQUESTED"
}

/** A required approval the reviewers have had a while to give needs asking for. */
export const APPROVAL_GRACE_MS = 15 * 60_000

function approvalGate(input: GateInput): GateResult {
  const { pr } = input
  // An app that has approved this PR before usually approves again on its next
  // pass: it gets twice the wait, no more. A push dismisses a stale approval,
  // and GitHub only dismisses approvals and change requests, so a DISMISSED
  // app review counts. An app that only comments never approves: nothing.
  const appApproves = pr.reviews.some((review) => review.bot && review.author !== "github-actions" && (review.state === "APPROVED" || review.state === "DISMISSED"))
  const grace = appApproves ? 2 * APPROVAL_GRACE_MS : APPROVAL_GRACE_MS
  const waited = input.nowMs - input.headFirstSeenMs
  if (!(waited >= grace)) return { kind: "wait", reason: "Waiting for an approving review", slow: true }
  return { kind: "needs-you", reason: "Needs an approving review" }
}

function mergeStateGate(input: GateInput): GateResult | null {
  const { pr, requiredNames } = input
  switch (pr.mergeState) {
    case "CLEAN":
    case "HAS_HOOKS":
      return null
    case "UNSTABLE":
      // With required checks, UNSTABLE means only optional ones are red, which
      // the checks gate already weighed. Without any, it is GitHub saying
      // something is red that Wisp did not see: never read that as mergeable.
      return requiredNames.size > 0 ? null : { kind: "needs-you", reason: "GitHub reports a failing check" }
    case "DIRTY":
      return { kind: "needs-you", reason: `Conflicts with ${pr.baseRefName}` }
    case "BEHIND":
      return { kind: "needs-you", reason: `Branch is behind ${pr.baseRefName} — update it` }
    case "BLOCKED": {
      const conversations = { kind: "needs-you", reason: `${pr.unresolvedThreads} unresolved conversation${pr.unresolvedThreads === 1 ? "" : "s"}` } as const
      // only a repository that requires them resolved is blocked by open conversations
      if (pr.unresolvedThreads > 0 && pr.conversationRule === "required") return conversations
      if (pr.reviewDecision === "REVIEW_REQUIRED") return approvalGate(input)
      if (pr.reviewDecision === "CHANGES_REQUESTED") return { kind: "needs-you", reason: "Changes requested" }
      // a rule Wisp cannot read, and nothing else explains the block: the open conversations likely do
      if (conversationsBlock(pr)) return conversations
      return { kind: "needs-you", reason: "Blocked by a branch rule" }
    }
    default:
      return { kind: "wait", reason: "Waiting for GitHub to work out mergeability" }
  }
}

export function mergeGate(input: GateInput): GateResult {
  const { pr } = input
  if (pr.isDraft) return { kind: "needs-you", reason: "Draft — mark it ready for review" }
  if (!input.allowedBases.has(pr.baseRefName)) {
    return { kind: "needs-you", reason: `Targets ${pr.baseRefName}; auto-merge only merges into ${pr.defaultBranch}` }
  }
  return checksGate(input) ?? reviewGate(pr) ?? judgedGate(input) ?? mergeStateGate(input) ??
    (input.published.ok ? { kind: "merge" } : { kind: "needs-you", reason: input.published.reason })
}
