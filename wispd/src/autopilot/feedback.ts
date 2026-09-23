/**
 * What review feedback on a PR the agent has not seen yet. Pure: the caller
 * decides who is trusted and which posts are the agent's own; this only picks
 * the items and names them.
 *
 * - An item is sent once per FINGERPRINT (its newest trusted words), kept in a
 *   ledger in the checkpoint: a thread that gets a new reply is new again, and
 *   an edit is new again, but nothing is repeated.
 * - Words that may instruct the agent come from the owner's account (their
 *   reviewer agents post as them), from a bot, or from anyone who can push. An
 *   approval is a merge signal, never a fix item.
 * - A bot's conversation comment is usually a status board it edits on every
 *   push (previews, coverage, triage). It is feedback only when the same app's
 *   check on the head is red — then once per head — or when it says "blocking".
 */
import type { PrCheck } from "./checks"
import { classifyCheck } from "./checks"
import type { PrComment, PrReview, PrSnapshot, PrThread } from "./github"
import { parseVerdict } from "./verdict"

/** Every post the agent makes on GitHub while auto-fix is on ends with this, so Wisp can tell its words from a reviewer's. */
export const markerOf = (taskId: string): string => `<!-- wisp:task=${taskId} -->`
export const isMarked = (body: string): boolean => body.includes("<!-- wisp:task=")

interface Author { author: string | null; bot: boolean }

export interface FeedbackInput {
  pr: PrSnapshot
  /** whose words may instruct the agent */
  trusts: (author: Author) => boolean
  /** the agent's own posts: marked, or the owner's account inside a turn that was never asked to mark them */
  self: (comment: PrComment) => boolean
  /** item id → the fingerprint last sent */
  delivered: Readonly<Record<string, string>>
}

interface Base {
  /** `thread:<node id>`, `review:<node id>` or `comment:<node id>` */
  id: string
  fingerprint: string
  /** when its newest words were written: a burst is sent together, once it settles */
  at: string
}

export type FeedbackItem =
  | Base & {
    kind: "thread"; thread: PrThread; comments: PrComment[]; fresh: PrComment[]
    /** the owner or a bot started it: the agent may resolve it once it pushed a fix */
    mayResolve: boolean
    /** it was resolved, then a trusted reply came in */
    reopened: boolean
  }
  | Base & { kind: "review"; review: PrReview }
  | Base & { kind: "comment"; comment: PrComment; check: PrCheck | null }

const time = (words: { createdAt?: string; submittedAt?: string; editedAt: string | null }): string =>
  words.editedAt ?? words.createdAt ?? words.submittedAt ?? ""

const latest = <T extends { createdAt: string; editedAt: string | null }>(list: T[]): T =>
  list.reduce((a, b) => (time(b) > time(a) ? b : a))

/** "LGTM", "thanks": words that ask for nothing. */
const ACKNOWLEDGEMENT = /^(?:lgtm|looks good(?: to me)?|thanks?(?: you)?|ty|nice|great|ship it|approved?|:?\+1:?|👍|🚀|🎉|✅)[\s!.]*$/i

function words(comment: PrComment, input: FeedbackInput): boolean {
  return comment.body.trim() !== "" && input.trusts(comment) && !input.self(comment)
}

function threadItem(thread: PrThread, input: FeedbackInput): FeedbackItem | null {
  const trusted = thread.comments.filter((comment) => words(comment, input))
  if (trusted.length === 0) return null
  const newest = latest(trusted)
  const id = `thread:${thread.id}`
  const fingerprint = time(newest)
  const before = input.delivered[id]
  if (before === fingerprint) return null
  // A resolved thread Wisp never sent was settled by a person; one it sent is
  // live again only when newer trusted words arrive (a "still wrong").
  if (thread.resolved && before === undefined) return null
  const fresh = before === undefined ? trusted : trusted.filter((comment) => time(comment) > before)
  if (fresh.length === 0) return null
  const starter = thread.starter
  return {
    kind: "thread", id, fingerprint, at: time(newest), thread, comments: trusted, fresh,
    mayResolve: Boolean(starter && (starter.author === input.pr.viewer || (starter.bot && starter.author !== "github-actions"))),
    reopened: thread.resolved,
  }
}

function reviewItem(review: PrReview, input: FeedbackInput): FeedbackItem | null {
  if (review.state === "PENDING" || review.state === "DISMISSED" || review.body.trim() === "") return null
  if (!input.trusts(review) || isMarked(review.body)) return null
  const verdict = parseVerdict(review.body)
  // An approval is the merge gate's business; an unreadable verdict is sent,
  // so the agent can read what the reviewer meant.
  if (verdict === "approve" || (verdict === null && review.state === "APPROVED")) return null
  const id = `review:${review.id}`
  const fingerprint = review.editedAt ?? review.submittedAt
  if (input.delivered[id] === fingerprint) return null
  return { kind: "review", id, fingerprint, at: fingerprint, review }
}

function commentItem(comment: PrComment, input: FeedbackInput): FeedbackItem | null {
  if (!words(comment, input) || ACKNOWLEDGEMENT.test(comment.body.trim())) return null
  const id = `comment:${comment.id}`
  if (comment.bot) {
    const paired = input.pr.checks.filter((check) => check.app === comment.author)
    const red = paired.find((check) => classifyCheck(check) === "fix") ?? null
    if (paired.length > 0) {
      // its check is the verdict: green says nothing, red is sent once per head
      if (!red) return null
      const fingerprint = `head:${input.pr.head}`
      if (input.delivered[id] === fingerprint) return null
      return { kind: "comment", id, fingerprint, at: time(comment), comment, check: red }
    }
    if (parseVerdict(comment.body) !== "blocking") return null
  } else if (parseVerdict(comment.body) === "approve") {
    return null
  }
  const fingerprint = time(comment)
  if (input.delivered[id] === fingerprint) return null
  return { kind: "comment", id, fingerprint, at: fingerprint, comment, check: null }
}

export function feedbackItems(input: FeedbackInput): FeedbackItem[] {
  const { pr } = input
  const items = [
    ...pr.threads.map((thread) => threadItem(thread, input)),
    ...pr.reviews.map((review) => reviewItem(review, input)),
    ...pr.comments.map((comment) => commentItem(comment, input)),
  ].filter((item): item is FeedbackItem => item !== null)
  return items.sort((a, b) => a.at.localeCompare(b.at))
}

/** Checks a bot reports its verdict through, beside a comment it keeps on the PR: the review flow sends those, not CI. */
export function pairedChecks(pr: PrSnapshot): Set<string> {
  const bots = new Set(pr.comments.filter((comment) => comment.bot && comment.author && comment.author !== "github-actions").map((comment) => comment.author!))
  return new Set(pr.checks.filter((check) => check.app && bots.has(check.app)).map((check) => check.name))
}

/**
 * A round's evidence key names every item and its fingerprint, so the same
 * feedback is never sent twice and a Skip or a cancel can mark exactly those
 * items handled. Parts are joined with `|`: `ci:…`, `conflict:…`, `fb:…`.
 */
export function feedbackKey(items: FeedbackItem[]): string {
  return `fb:${items.map((item) => `${item.id}@${item.fingerprint}`).sort().join(";")}`
}

export interface KeyParts {
  ci: string | null
  delivered: Record<string, string>
}

export function keyParts(key: string): KeyParts {
  const parts: KeyParts = { ci: null, delivered: {} }
  for (const part of key.split("|")) {
    if (!part.startsWith("fb:")) { parts.ci = part; continue }
    for (const entry of part.slice(3).split(";").filter(Boolean)) {
      const at = entry.lastIndexOf("@")
      if (at > 0) parts.delivered[entry.slice(0, at)] = entry.slice(at + 1)
    }
  }
  return parts
}

/** Keep the ledger bounded: the oldest entries go first. */
export function withDelivered(ledger: Readonly<Record<string, string>> | undefined, added: Record<string, string>): Record<string, string> {
  const merged = { ...ledger }
  for (const [id, fingerprint] of Object.entries(added)) {
    delete merged[id]
    merged[id] = fingerprint
  }
  return Object.fromEntries(Object.entries(merged).slice(-200))
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export function feedbackSummary(items: FeedbackItem[]): string {
  const threads = items.filter((item) => item.kind === "thread").length
  const reviews = items.filter((item) => item.kind === "review").length
  const comments = items.filter((item) => item.kind === "comment").length
  return [
    threads > 0 && count(threads, "review thread", "review threads"),
    reviews > 0 && count(reviews, "review", "reviews"),
    comments > 0 && count(comments, "comment", "comments"),
  ].filter(Boolean).join(", ")
}
