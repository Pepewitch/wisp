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
 * - What those signals leave undecided (a bot's summary under no red check of
 *   its own, a bot's review body with no verdict) is feedback only when the
 *   optional review judge (judge.ts) read that version as asking for changes.
 */
import type { PrCheck } from "./checks"
import { classifyCheck } from "./checks"
import type { PrComment, PrReview, PrSnapshot, PrThread } from "./github"
import { needsChanges, type JudgeCandidate, type Judged, type Judgment } from "./judge"
import { parseVerdict } from "./verdict"

/** Every post the agent makes on GitHub while auto-fix is on ends with this, so Wisp can tell its words from a reviewer's. */
export const markerOf = (taskId: string): string => `<!-- wisp:task=${taskId} -->`
/**
 * Signed by a Wisp agent: the marker on a line of its own words. A quote of
 * one (`> …`) is someone answering it, and one inside a code block is someone
 * showing it.
 */
export function isMarked(body: string): boolean {
  let fenced = false
  for (const line of body.split(/\r?\n/)) {
    const text = line.trimStart()
    if (/^(?:```|~~~)/.test(text)) { fenced = !fenced; continue }
    if (!fenced && !text.startsWith(">") && /<!-- wisp:task=[a-z0-9]+ -->/.test(text)) return true
  }
  return false
}

interface Author { author: string | null; bot: boolean }

export interface FeedbackInput {
  pr: PrSnapshot
  /** whose words may instruct the agent */
  trusts: (author: Author) => boolean
  /** the agent's own posts: marked, or the owner's account inside a turn that was never asked to mark them */
  self: (comment: PrComment) => boolean
  /** item id → the fingerprint last sent */
  delivered: Readonly<Record<string, string>>
  /** item id → the review judge's answer for one version of it; absent without a key */
  judged?: Readonly<Record<string, Judged>>
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
  | Base & {
    kind: "review"; review: PrReview
    /** the review judge's answer, when that and not a verdict is why it is sent */
    judged?: Judgment
  }
  | Base & {
    kind: "comment"; comment: PrComment; check: PrCheck | null
    /** the review judge's answer, when that and not a red check is why it is sent */
    judged?: Judgment
  }

const time = (words: { createdAt?: string; submittedAt?: string; editedAt: string | null }): string =>
  words.editedAt ?? words.createdAt ?? words.submittedAt ?? ""

const latest = <T extends { createdAt: string; editedAt: string | null }>(list: T[]): T =>
  list.reduce((a, b) => (time(b) > time(a) ? b : a))

const ACK_PHRASES = [["looks", "good", "to", "me"], ["looks", "great", "to", "me"], ["looks", "good"], ["looks", "great"], ["thank", "you"], ["nice", "work"], ["nice", "one"], ["great", "work"], ["ship", "it"]]
const ACK_WORDS = new Set(["lgtm", "thanks", "thank", "thx", "ty", "nice", "great", "approve", "approved", "resolved", "done", "+1", "👍", "🚀", "🎉", "✅", "🙏", "❤", "💯"])
const ACK_EMOJI = /(👍|🚀|🎉|✅|🙏|❤|💯)/gu

/**
 * "LGTM, thanks!", "👍": words that ask for nothing, in any combination.
 * Linear by construction — a token walk, never a backtracking pattern — and
 * bounded: it may see any commenter's text.
 */
export function acknowledgement(body: string): boolean {
  if (body.length > 120) return false
  const text = body.toLowerCase().replace(/\uFE0F/g, "").replace(/\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF}/gu, "").replace(ACK_EMOJI, " $1 ").replace(/[\s!.,:;]+/g, " ").trim()
  if (text === "") return false
  const tokens = text.split(" ")
  for (let index = 0; index < tokens.length;) {
    const phrase = ACK_PHRASES.find((words) => words.every((word, offset) => tokens[index + offset] === word))
    if (phrase) { index += phrase.length; continue }
    if (!ACK_WORDS.has(tokens[index]!)) return false
    index++
  }
  return true
}

/** Words that may instruct the agent: trusted, not its own, not a draft or hidden, and asking for something. */
function words(comment: PrComment, input: Pick<FeedbackInput, "trusts" | "self">): boolean {
  // trust first: nothing a stranger wrote is parsed further
  return comment.body.trim() !== "" && !comment.hidden && input.trusts(comment) && !input.self(comment) && !acknowledgement(comment.body)
}

/**
 * The thread's words that may instruct the agent. A bot answering someone
 * untrusted in the thread (a chat-style reviewer) only relays them, so its
 * reply is not trusted either.
 */
function threadWords(thread: PrThread, input: FeedbackInput): PrComment[] {
  return thread.comments.filter((comment, index) => {
    if (!words(comment, input)) return false
    if (!comment.bot) return true
    // the person the bot is answering: the nearest earlier comment by someone, past other bot
    // posts, hidden comments, thank-yous, and the agent's own replies
    const asker = thread.comments.slice(0, index).reverse().find((before) =>
      !before.bot && !before.hidden && !input.self(before) && !acknowledgement(before.body))
    return !asker || input.trusts(asker)
  })
}

function threadItem(thread: PrThread, input: FeedbackInput): FeedbackItem | null {
  const trusted = threadWords(thread, input)
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
  // A thread the agent started itself is not the owner asking; its replies are someone else's.
  const ownStart = starter !== null && isMarked(starter.body)
  return {
    kind: "thread", id, fingerprint, at: time(newest), thread, comments: trusted, fresh,
    mayResolve: Boolean(starter && !ownStart && (starter.author === input.pr.viewer || (starter.bot && starter.author !== "github-actions"))),
    reopened: thread.resolved,
  }
}

/** A review worth reading at all: submitted, with a body, from someone trusted, not the agent's, asking for something. */
function readable(review: PrReview, input: Pick<FeedbackInput, "trusts">): boolean {
  if (review.state === "PENDING" || review.state === "DISMISSED" || review.body.trim() === "") return false
  return input.trusts(review) && !isMarked(review.body) && !acknowledgement(review.body)
}

/**
 * A bot's review body with no verdict and no change request: its overview
 * ("reviewed 3 files, generated 2 comments"), whose threads are the feedback.
 * GitHub says nothing more about it; only the review judge can.
 */
const undecidedReview = (review: PrReview): boolean =>
  review.bot && parseVerdict(review.body) === null && review.state !== "CHANGES_REQUESTED" && review.state !== "APPROVED"

/** The version of an item the judge answered for, when it is the current one. */
function judgedNow(input: FeedbackInput, id: string, fingerprint: string): Judged | undefined {
  const judged = input.judged?.[id]
  return judged?.fp === fingerprint ? judged : undefined
}

function reviewItem(review: PrReview, input: FeedbackInput): FeedbackItem | null {
  if (!readable(review, input)) return null
  const verdict = parseVerdict(review.body)
  // An approval is the merge gate's business; an unreadable verdict is sent,
  // so the agent can read what the reviewer meant.
  if (verdict === "approve" || (verdict === null && review.state === "APPROVED")) return null
  const id = `review:${review.id}`
  const fingerprint = review.editedAt ?? review.submittedAt
  if (input.delivered[id] === fingerprint) return null
  if (!undecidedReview(review)) return { kind: "review", id, fingerprint, at: fingerprint, review }
  const judged = judgedNow(input, id, fingerprint)
  return needsChanges(judged) ? { kind: "review", id, fingerprint, at: fingerprint, review, judged } : null
}

/** The same app's red check beside a bot's comment: its verdict, when it has one. */
const redCheckOf = (comment: PrComment, pr: PrSnapshot): PrCheck | null =>
  pr.checks.find((check) => check.app === comment.author && classifyCheck(check) === "fix") ?? null

/**
 * A bot's comment GitHub's signals leave undecided: its own check is green or
 * running, or it has none and says nothing "blocking". Usually a status board.
 */
function undecidedComment(comment: PrComment, pr: PrSnapshot): boolean {
  if (!comment.bot || redCheckOf(comment, pr)) return false
  const paired = pr.checks.some((check) => check.app === comment.author)
  return paired || parseVerdict(comment.body) !== "blocking"
}

function commentItem(comment: PrComment, input: FeedbackInput): FeedbackItem | null {
  if (!words(comment, input)) return null
  const id = `comment:${comment.id}`
  const red = comment.bot ? redCheckOf(comment, input.pr) : null
  if (red) {
    // its check is the verdict: red is sent once per head
    const fingerprint = `head:${input.pr.head}`
    if (input.delivered[id] === fingerprint) return null
    return { kind: "comment", id, fingerprint, at: time(comment), comment, check: red }
  }
  if (!comment.bot && parseVerdict(comment.body) === "approve") return null
  const fingerprint = time(comment)
  if (input.delivered[id] === fingerprint) return null
  if (!undecidedComment(comment, input.pr)) return { kind: "comment", id, fingerprint, at: fingerprint, comment, check: null }
  const judged = judgedNow(input, id, fingerprint)
  return needsChanges(judged) ? { kind: "comment", id, fingerprint, at: fingerprint, comment, check: null, judged } : null
}

/**
 * The bots' words the review judge should read: exactly those `feedbackItems`
 * would otherwise drop as a status board or an overview.
 */
export function judgeCandidates(input: Pick<FeedbackInput, "pr" | "trusts" | "self">): JudgeCandidate[] {
  const { pr } = input
  const comments = pr.comments
    .filter((comment) => words(comment, input) && undecidedComment(comment, pr))
    .map((comment): JudgeCandidate => ({ id: `comment:${comment.id}`, fp: time(comment), order: time(comment), text: comment.body, postedAs: "comment", bot: true, author: comment.author, url: comment.url }))
  const reviews = pr.reviews
    .filter((review) => readable(review, input) && undecidedReview(review))
    .map((review): JudgeCandidate => ({
      id: `review:${review.id}`, fp: review.editedAt ?? review.submittedAt, order: review.submittedAt, text: review.body, postedAs: "review", bot: true, author: review.author, url: review.url, commit: review.commit,
    }))
  return [...comments, ...reviews]
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

/**
 * Checks a bot reports its verdict through, beside a comment it keeps on the
 * PR, that the review flow is sending (or already sent) for this head: CI's
 * part leaves those out so the same finding is not sent twice. Any other red
 * check stays CI's.
 */
export function pairedChecks(pr: PrSnapshot, items: FeedbackItem[], delivered: Readonly<Record<string, string>>): Set<string> {
  const names = new Set<string>()
  for (const comment of pr.comments) {
    const sending = items.some((item) => item.kind === "comment" && item.comment.id === comment.id && item.check)
    if (!sending && delivered[`comment:${comment.id}`] !== `head:${pr.head}`) continue
    for (const check of pr.checks) if (check.app && check.app === comment.author) names.add(check.name)
  }
  return names
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
  return Object.fromEntries(Object.entries(merged).slice(-500))
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
