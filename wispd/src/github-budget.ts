/**
 * Wisp's GitHub budget. Autopilot and the PR overview read GitHub through the
 * owner's `gh`, and its hourly limits (5,000 GraphQL points and 5,000 REST
 * requests on a personal account) are shared with every other tool the owner
 * runs through it. So Wisp measures what each call costs (GraphQL's
 * `rateLimit`, REST's `x-ratelimit-*` headers), keeps its own spend to a share
 * of each limit, slows down when the account runs low whoever spent it, and
 * sends nothing while GitHub has said to stop: to that limit, for a primary
 * limit; to either, for a secondary one.
 *
 * In memory only: a restart forgets Wisp's own spend, and the first answer
 * after it reports how much of the hour is left.
 */
import { isRecord } from "./validate"

/**
 * Wisp's cap: its own spend over a rolling hour stays under this share of each
 * hourly limit, so the owner's other tools always keep the rest.
 */
export const WISP_SHARE = 0.25
/**
 * When GitHub reports less than this share of a limit left (anyone's use),
 * Wisp stretches its waits in proportion: at half the floor, twice as long.
 */
export const REMAINING_FLOOR = 0.2
/** Wisp starts stretching its waits once its own spend passes this part of its share. */
const EASE_FROM = 0.5
/** Once its share is used up, Wisp waits until its spend is back under this part of it, rather than trickling at the cap. */
const SHARE_REOPEN = 0.9
/** The most any wait is stretched. */
const MAX_STRETCH = 20
/**
 * A secondary limit pauses at least a minute (GitHub's advice with no
 * `retry-after`; repeats double it) and at most fifteen, whatever its
 * `retry-after` says: a zero would retry at once, a huge one would never.
 */
const SECONDARY_WAIT_MS = 60_000
const SECONDARY_WAIT_MAX_MS = 15 * 60_000
/** A primary limit whose reset time is unknown or already past: look again in a minute. */
const UNKNOWN_RESET_MS = 60_000
const HOUR_MS = 60 * 60_000
/** A primary limit pauses until its reset, at most an hour: a skewed clock then reads the limit again. */
const PRIMARY_WAIT_MAX_MS = HOUR_MS
/** A personal account's hourly limit, until GitHub reports the real one. */
const DEFAULT_LIMIT = 5000
/** `gh pr merge` reads the PR and merges it through GraphQL, and reports no cost: an estimate. */
export const MERGE_POINTS = 3

export type GitHubResource = "graphql" | "core"
const RESOURCES: GitHubResource[] = ["graphql", "core"]

/** What GitHub last said about one hourly limit. Times are epoch milliseconds. */
interface RateSample { limit: number; remaining: number; resetAt: number; at: number }

/**
 * One `gh api --include` answer, taken apart. `status` is null when gh printed
 * no HTTP response: the call never reached GitHub, or it had no `--include`.
 */
export interface GhReply {
  status: number | null
  headers: Map<string, string>
  body: string
  /** the body as JSON, or undefined */
  json: unknown
  stderr: string
  /** gh exited non-zero */
  failed: boolean
}

export function ghReply(out: string, stderr: string, failed: boolean): GhReply {
  const headers = new Map<string, string>()
  const status = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/.exec(out)
  let body = out
  if (status) {
    let at = status[0].length
    while (at < out.length) {
      const newline = out.indexOf("\n", at)
      const end = newline < 0 ? out.length : newline
      const line = out.slice(at, end).replace(/\r$/, "")
      at = end + 1
      if (line === "") break
      const colon = line.indexOf(":")
      if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
    }
    body = out.slice(at)
  }
  let json: unknown
  try { json = body.trim() ? JSON.parse(body) : undefined } catch { json = undefined }
  return { status: status ? Number(status[1]) : null, headers, body, json, stderr, failed }
}

/** GitHub said stop: a primary limit (the hour's budget is spent) or a secondary one (too fast). */
export interface LimitSignal { kind: "primary" | "secondary"; until: number | null }

function header(headers: Map<string, string>, name: string): number | null {
  const value = headers.get(name)
  const number = value === undefined || value === "" ? Number.NaN : Number(value)
  return Number.isFinite(number) ? number : null
}

/** The error text GitHub and gh gave: gh's stderr, a REST `message`, GraphQL `errors`. */
function errorText(reply: GhReply): { text: string; graphqlLimited: boolean } {
  const parts = [reply.stderr]
  let graphqlLimited = false
  if (isRecord(reply.json)) {
    if (typeof reply.json.message === "string") parts.push(reply.json.message)
    if (Array.isArray(reply.json.errors)) {
      for (const error of reply.json.errors.filter(isRecord)) {
        if (error.type === "RATE_LIMITED") graphqlLimited = true
        if (typeof error.message === "string") parts.push(error.message)
      }
    }
  }
  return { text: parts.join("\n"), graphqlLimited }
}

/**
 * Whether a failed call was GitHub limiting the rate. A 403 is also how GitHub
 * refuses a permission, so a 403 counts only with a rate-limit header or
 * message; a 429 always does.
 */
export function limitSignal(reply: GhReply, now: number): LimitSignal | null {
  if (!reply.failed) return null
  const { text, graphqlLimited } = errorText(reply)
  const retryAfter = header(reply.headers, "retry-after")
  const reset = header(reply.headers, "x-ratelimit-reset")
  const exhausted = header(reply.headers, "x-ratelimit-remaining") === 0
  const refused = reply.status === 403 || reply.status === 429
  const secondary = /secondary rate limit|abuse detection/i.test(text)
  const resetAt = reset !== null && reset * 1000 > now ? reset * 1000 : null
  if (retryAfter !== null && (refused || secondary)) return { kind: secondary || !exhausted ? "secondary" : "primary", until: now + retryAfter * 1000 }
  if (secondary) return { kind: "secondary", until: null }
  if ((refused && exhausted) || graphqlLimited || /API rate limit exceeded|rate limit exceeded/i.test(text)) return { kind: "primary", until: resetAt }
  if (reply.status === 429 || /\(HTTP 429\)/.test(text)) return { kind: "secondary", until: null }
  return null
}

export type PauseReason = "primary" | "secondary" | "share"

/**
 * Nothing goes to GitHub until `until`: GitHub said so, or Wisp's share of
 * the hour is spent. `sent`: the call went out and GitHub refused it, rather
 * than being held back before it went.
 */
export class GitHubPausedError extends Error {
  constructor(readonly until: number, readonly why: PauseReason, readonly sent = false) {
    super(`${why === "share" ? "Paused: Wisp's share of the GitHub rate limit is used up" : "Paused: GitHub rate limit"}, resumes ${clockTime(until)}`)
    this.name = "GitHubPausedError"
  }
}

/** A catch for a GitHub call whose failure is soft: a pause still stops the whole look. */
export function unlessPaused<T>(fallback: T): (error: unknown) => T {
  return (error) => {
    if (error instanceof GitHubPausedError) throw error
    return fallback
  }
}

/** The local hour and minute something resumes, rounded up so it is never early. */
export function clockTime(at: number): string {
  const date = new Date(Math.ceil(at / 60_000) * 60_000)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export interface GitHubBudgetReport {
  /** Wisp's cap and the low-remaining floor, as shares of each hourly limit */
  share: number
  floor: number
  /** how much Wisp stretches its waits right now (1: not at all) */
  stretch: number
  resources: {
    resource: GitHubResource
    /** set while Wisp sends this limit nothing: why, and until when (a secondary limit pauses both) */
    paused: { why: PauseReason; until: string } | null
    /** Wisp's own spend over the last hour: points for graphql, requests for core */
    spentLastHour: number
    requestsLastHour: number
    cap: number
    /** what GitHub last reported for the account in this daemon's run, if anything */
    limit: number | null
    remaining: number | null
    resetAt: string | null
    checkedAt: string | null
  }[]
}

export class GitHubBudget {
  private spends: { at: number; resource: GitHubResource; points: number }[] = []
  /** what calls under way are expected to cost, so looks side by side cannot together pass the cap */
  private readonly reserved: Record<GitHubResource, number> = { graphql: 0, core: 0 }
  /** the share was used up, and has not yet come back under SHARE_REOPEN */
  private readonly shut: Record<GitHubResource, boolean> = { graphql: false, core: false }
  private readonly samples = new Map<GitHubResource, RateSample>()
  /** a primary limit is one hourly limit's: REST spent by other tools leaves GraphQL reads (and merges) going */
  private readonly primaryUntil: Record<GitHubResource, number> = { graphql: 0, core: 0 }
  /** a secondary limit is about the account going too fast: it stops everything */
  private secondaryUntil = 0
  private secondaryStrikes = 0

  constructor(private readonly clock: () => number = Date.now) {}

  /** What stops calls to `resource` at `now`, from GitHub: a secondary limit first, then this limit's primary. */
  private pausedBy(resource: GitHubResource, now: number): { until: number; why: "primary" | "secondary" } | null {
    if (now < this.secondaryUntil) return { until: this.secondaryUntil, why: "secondary" }
    return now < this.primaryUntil[resource] ? { until: this.primaryUntil[resource], why: "primary" } : null
  }

  /**
   * Before a call goes out, with what it is expected to cost. Throws
   * GitHubPausedError while GitHub asked Wisp to wait, or when the call would
   * take Wisp past its share; otherwise holds `estimate` until `settle`.
   */
  reserve(resource: GitHubResource, estimate: number): void {
    const now = this.clock()
    const paused = this.pausedBy(resource, now)
    if (paused) throw new GitHubPausedError(paused.until, paused.why)
    const room = this.room(resource) - this.reserved[resource] - estimate
    if (this.spent(resource, now) > room) {
      this.shut[resource] = true
      throw new GitHubPausedError(this.freesAt(resource, Math.max(this.room(resource) - estimate, 0) + 1, now), "share")
    }
    this.shut[resource] = false
    this.reserved[resource] += estimate
  }

  /** Whether a call of about one point may go out now, without reserving it. */
  isOpen(resource: GitHubResource): boolean {
    const now = this.clock()
    if (this.pausedBy(resource, now)) return false
    return this.spent(resource, now) + this.reserved[resource] < this.room(resource)
  }

  /**
   * A call is back (`reply` null: it threw): its reservation is released, and
   * its cost, what GitHub says is left, and any limit recorded. A limit pauses
   * every call and throws GitHubPausedError. A call with no HTTP answer never
   * reached GitHub and costs nothing, unless it is one that cannot show its
   * answer (`unseen`: `gh pr merge`, a piped job log).
   */
  settle(resource: GitHubResource, reply: GhReply | null, estimate: number, unseen = 0): void {
    this.reserved[resource] = Math.max(0, this.reserved[resource] - estimate)
    if (!reply) return
    const now = this.clock()
    const data = isRecord(reply.json) && isRecord(reply.json.data) ? reply.json.data : null
    const rate = data && isRecord(data.rateLimit) ? data.rateLimit : null
    const reported = rate && typeof rate.cost === "number" ? rate.cost : null
    this.spend(resource, reported ?? (reply.status !== null ? 1 : unseen), now)
    if (rate && typeof rate.limit === "number" && typeof rate.remaining === "number" && typeof rate.resetAt === "string") {
      this.observe(resource, { limit: rate.limit, remaining: rate.remaining, resetAt: Date.parse(rate.resetAt), at: now })
    } else {
      const limit = header(reply.headers, "x-ratelimit-limit")
      const remaining = header(reply.headers, "x-ratelimit-remaining")
      const reset = header(reply.headers, "x-ratelimit-reset")
      const named = reply.headers.get("x-ratelimit-resource")
      if (limit !== null && remaining !== null && reset !== null && (named === undefined || named === resource)) {
        this.observe(resource, { limit, remaining, resetAt: reset * 1000, at: now })
      }
    }
    const signal = limitSignal(reply, now)
    if (!signal) {
      if (!reply.failed) this.secondaryStrikes = 0
      return
    }
    // a time already past (`retry-after: 0`, a reset behind a skewed clock) says nothing about when
    let until = signal.until !== null && signal.until > now ? signal.until : null
    if (signal.kind === "secondary" && until === null) {
      until = now + Math.min(SECONDARY_WAIT_MS * 2 ** this.secondaryStrikes, SECONDARY_WAIT_MAX_MS)
      this.secondaryStrikes++
    }
    if (until === null) {
      const known = this.samples.get(resource)
      until = known && known.resetAt > now ? known.resetAt : now + UNKNOWN_RESET_MS
    }
    this.pause(resource, until, signal.kind)
    const paused = this.pausedBy(resource, now)!
    throw new GitHubPausedError(paused.until, paused.why, true)
  }

  /**
   * How much to stretch a wait: 1 normally; more once Wisp's own spend passes
   * half its share (twice as long at three quarters, ten times near the cap),
   * or once GitHub reports less than the floor left.
   */
  stretch(): number {
    const now = this.clock()
    let factor = 1
    for (const resource of RESOURCES) {
      const used = this.spent(resource, now) / this.cap(resource)
      if (used > EASE_FROM) factor = Math.max(factor, (1 - EASE_FROM) / Math.max(1 - used, 0.05))
      const sample = this.current(resource, now)
      const floor = sample ? REMAINING_FLOOR * sample.limit : 0
      if (sample && sample.remaining < floor) factor = Math.max(factor, floor / Math.max(sample.remaining, sample.limit / 100))
    }
    return Math.min(factor, MAX_STRETCH)
  }

  report(): GitHubBudgetReport {
    const now = this.clock()
    const resources = RESOURCES.map((resource) => {
      const cap = this.cap(resource)
      const spentLastHour = this.spent(resource, now)
      const github = this.pausedBy(resource, now)
      const paused: { why: PauseReason; until: number } | null = github ??
        (this.isOpen(resource) ? null : { why: "share", until: this.freesAt(resource, this.room(resource), now) })
      const sample = this.samples.get(resource)
      return {
        resource, paused: paused ? { why: paused.why, until: new Date(paused.until).toISOString() } : null, spentLastHour, cap,
        requestsLastHour: this.spends.filter((spend) => spend.resource === resource).length,
        limit: sample?.limit ?? null, remaining: sample?.remaining ?? null,
        resetAt: sample ? new Date(sample.resetAt).toISOString() : null, checkedAt: sample ? new Date(sample.at).toISOString() : null,
      }
    })
    return { share: WISP_SHARE, floor: REMAINING_FLOOR, stretch: this.stretch(), resources }
  }

  private spend(resource: GitHubResource, points: number, at: number): void {
    if (points > 0) this.spends.push({ at, resource, points })
  }

  private observe(resource: GitHubResource, sample: RateSample): void {
    if (!Number.isFinite(sample.resetAt)) return
    this.samples.set(resource, sample)
    // nothing left: the next call would be refused, so none goes out until the reset
    if (sample.remaining <= 0 && sample.resetAt > sample.at) this.pause(resource, sample.resetAt, "primary")
  }

  /**
   * Hold calls back until `until`, bounded: a secondary limit to between a
   * minute and fifteen, a primary one to at most an hour, after which the next
   * answer says again how much is left. A later limit can only lengthen a
   * pause, within the same bounds, so none outlasts them.
   */
  private pause(resource: GitHubResource, until: number, why: "primary" | "secondary"): void {
    const now = this.clock()
    if (why === "secondary") {
      const bounded = now + Math.min(Math.max(until - now, SECONDARY_WAIT_MS), SECONDARY_WAIT_MAX_MS)
      this.secondaryUntil = Math.max(this.secondaryUntil, bounded)
    } else {
      this.primaryUntil[resource] = Math.max(this.primaryUntil[resource], Math.min(until, now + PRIMARY_WAIT_MAX_MS))
    }
  }

  private cap(resource: GitHubResource): number {
    return Math.max(1, Math.floor(WISP_SHARE * (this.samples.get(resource)?.limit ?? DEFAULT_LIMIT)))
  }

  /** How much of the hour Wisp may have spent for a call to go out: the cap, or less while it is coming back from it. */
  private room(resource: GitHubResource): number {
    return this.shut[resource] ? Math.floor(SHARE_REOPEN * this.cap(resource)) : this.cap(resource)
  }

  /** The sample for the current hour: once its reset passes, GitHub has refilled the limit. */
  private current(resource: GitHubResource, now: number): RateSample | null {
    const sample = this.samples.get(resource)
    return sample && sample.resetAt > now ? sample : null
  }

  private spent(resource: GitHubResource, now: number): number {
    const from = now - HOUR_MS
    if (this.spends.length > 0 && this.spends[0]!.at <= from) this.spends = this.spends.filter((spend) => spend.at > from)
    let total = 0
    for (const spend of this.spends) if (spend.resource === resource) total += spend.points
    return total
  }

  /** When enough of the last hour's spend has aged out to be under the cap again. */
  private freesAt(resource: GitHubResource, cap: number, now: number): number {
    let left = this.spent(resource, now)
    for (const spend of this.spends) {
      if (spend.resource !== resource) continue
      left -= spend.points
      if (left < cap) return spend.at + HOUR_MS
    }
    return now + HOUR_MS
  }
}

/** The daemon's one budget: autopilot and the PR overview spend from it together. */
export const githubBudget = new GitHubBudget()
