/**
 * The review judge: an optional call to TypeSafe's Jev for the one decision
 * GitHub's own signals leave open, whether a bot's summary comment or review
 * body asks for a fix. Red checks, review threads, change requests and
 * `Verdict:` lines never reach it.
 *
 * - Off unless a key is set (the settings API, or TYPESAFE_API_KEY / JEV_API_KEY),
 *   and with no key no stored answer counts either.
 * - Each version of a comment is judged once; the answer is kept in the
 *   checkpoint beside the delivery ledger.
 * - Only the comment's text, whether a bot or a person wrote it, and where it
 *   was posted leave the machine: no diff, repository, PR number or login.
 * - Every call is logged beside the task's round evidence (`judge.jsonl`),
 *   and a monthly count is kept for the settings API.
 * - A failure backs off. Auto-merge waits through a few failed looks, then
 *   reads the comment as it would without a key; auto-fix never waits.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TASKS_DIR, WISP_HOME, type WispConfig } from "../config"
import { classifyCheck } from "./checks"
import type { PrSnapshot } from "./github"
import { parseVerdict } from "./verdict"

export const JEV_URL = "https://api.typesafe.ai/v1/systemone"
/** Pinned: `jev-latest` could change its answers under a release that did not. */
export const JEV_MODEL = "jev-1.13.0"
export const MIN_CONFIDENCE = 0.6
/** TypeSafe's published price; output tokens are free. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000
const MAX_TEXT = 8_000
const CALL_TIMEOUT_MS = 10_000
/** A look asks about at most this many comments; the rest wait for the next look. */
const PER_LOOK = 6
const LEDGER_LIMIT = 200
const LOG_LIMIT_BYTES = 2 * 1024 * 1024

/**
 * Two questions. `kind` is asked of a bot's words GitHub's signals leave
 * undecided. `findings` is asked of an approval: not whether it is right
 * (the judge cannot see the code), only whether it lists anything at all.
 */
export type JudgeQuestion = "kind" | "findings"
export type JudgeKind = "needs_changes" | "minor_only" | "all_clear" | "status" | "reply" | "no_findings" | "one_finding" | "several_findings"
const CHOICES: Record<JudgeQuestion, Record<string, JudgeKind>> = {
  kind: { needs_changes: "needs_changes", minor_only: "minor_only", all_clear: "all_clear", status: "status", reply: "reply" },
  findings: { none: "no_findings", one: "one_finding", several: "several_findings" },
}

export interface Judgment { kind: JudgeKind; confidence: number; model: string }
/** A checkpoint entry: which version of the comment was judged, and the answer. */
export interface Judged extends Judgment { fp: string }

export interface JudgeRequest { text: string; bot: boolean; postedAs: "comment" | "review"; question?: JudgeQuestion }
export interface JudgeAnswer extends Judgment { probabilities: Record<string, number>; inputTokens: number }
export type JudgeClient = (request: JudgeRequest, signal: AbortSignal) => Promise<JudgeAnswer>

/** A bot's words GitHub's signals leave undecided (see `judgeCandidates` in feedback.ts). */
export interface JudgeCandidate {
  id: string; fp: string; text: string; postedAs: "comment" | "review"; bot: boolean; author: string | null; url: string
  /** which of a bot's words is newest: a review by when it was submitted, a comment by its last edit */
  order: string
  /** a review's commit: it is about that head and no other */
  commit?: string | null
  /** which question it is asked; `kind` unless it is an approval */
  question?: JudgeQuestion
}

const WHERE = { comment: "a conversation comment on the pull request", review: "the body of a pull request review" }

/** The question, as measured: 238 real review items, 98.7% right on "does this start a round". */
const QUESTION = {
  type: "choice",
  instructions: "Classify this pull request comment by what it asks of the pull request's author.",
  criteria: {
    needs_changes: "Reports at least one problem in the code that the author should fix before merging: a bug, a security issue, broken or missing behaviour, a failed quality gate, a blocking finding, or anything rated medium, high or critical severity. When the comment rates its own finding (medium, high, critical, blocking), follow that rating even if the text sounds mild.",
    minor_only: "Only optional or minor suggestions: nits, style, typos, refactors, low or trivial severity, or notes explicitly marked non-blocking. Nothing has to change before merging. When the comment rates its own finding as low, trivial, a nit, optional or non-blocking, follow that rating even if the problem sounds real.",
    all_clear: "A review or check that found nothing to fix: it approves, reports no issues, or confirms that an earlier finding is fixed or withdrawn.",
    status: "Automated status rather than a review of the code: preview or deploy links, coverage or CI reports, linked issues, deploy approval prompts, bot usage notes, walkthroughs, or pointers to another comment.",
    reply: "Someone answering review feedback: says it is fixed or addressed, explains or disputes a finding, thanks the reviewer, or asks a bot to review again.",
  },
}

/**
 * Asked of an approval, measured on the owner's 26 real approving reviews: it
 * matched every one on "lists findings or not", including a "Non-blocking:
 * none." A judgment ("is any of it a real defect?") was not reliable: it
 * followed the reviewer's wording, so the agent, which can read the code,
 * makes that call.
 */
const FINDINGS_QUESTION = {
  type: "choice",
  instructions: "How many distinct findings or concerns about this pull request's own code does the review raise? Count ones the reviewer accepts, marks non-blocking, optional or low, but not summaries, confirmations that something works, or follow-ups for other work.",
  criteria: {
    none: "No finding or concern about this pull request's code: a summary, approval, confirmations, or follow-ups for other work only.",
    one: "Exactly one finding or concern about this pull request's code.",
    several: "Two or more distinct findings or concerns about this pull request's code.",
  },
}

/** Bumped whenever a question changes, so a log line says which one it answered. */
export const JUDGE_PROMPTS: Record<JudgeQuestion, string> = { kind: "review-kind/2", findings: "approval-findings/1" }

/** The text as sent: long bodies are cut (never inside a character), and the log keeps exactly what Jev saw. */
export function sentText(text: string): string {
  if (text.length <= MAX_TEXT) return text
  const cut = text.slice(0, MAX_TEXT)
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}\n…(truncated)`
}

/** The request body. Nothing else about the PR is sent. */
export function jevBody(request: JudgeRequest): Record<string, unknown> {
  const text = sentText(request.text)
  return {
    model: JEV_MODEL,
    state: { author: request.bot ? "a bot" : "a person", posted_as: WHERE[request.postedAs], text },
    questions: request.question === "findings" ? { findings: FINDINGS_QUESTION } : { kind: QUESTION },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

function parseAnswer(raw: unknown, question: JudgeQuestion): JudgeAnswer {
  const answer = isRecord(raw) && isRecord(raw.answers) ? raw.answers[question] : null
  const usage = isRecord(raw) && isRecord(raw.usage) ? raw.usage : null
  const kind = isRecord(answer) && typeof answer.choice === "string" ? CHOICES[question][answer.choice] : undefined
  if (!isRecord(answer) || !kind || typeof answer.confidence !== "number") {
    throw new Error("Jev answered in an unexpected shape")
  }
  const probabilities = isRecord(answer.probabilities)
    ? Object.fromEntries(Object.entries(answer.probabilities).filter((entry): entry is [string, number] => typeof entry[1] === "number"))
    : {}
  return {
    kind, confidence: answer.confidence, probabilities,
    model: isRecord(raw) && typeof raw.model === "string" ? raw.model : JEV_MODEL,
    inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : 0,
  }
}

export function jevClient(key: string, fetcher: typeof fetch = fetch): JudgeClient {
  return async (request, signal) => {
    const response = await fetcher(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(jevBody(request)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
    })
    if (!response.ok) throw new Error(`Jev answered HTTP ${response.status}`)
    return parseAnswer(await response.json(), request.question ?? "kind")
  }
}

export type JudgeKeySource = "settings" | "environment"

/** The key the judge uses: the one saved in Settings, else the environment's. */
export function jevKey(cfg: Pick<WispConfig, "jevApiKey">, env: Record<string, string | undefined> = process.env): { key: string; source: JudgeKeySource } | null {
  if (cfg.jevApiKey) return { key: cfg.jevApiKey, source: "settings" }
  const fromEnv = env.TYPESAFE_API_KEY || env.JEV_API_KEY
  return fromEnv ? { key: fromEnv, source: "environment" } : null
}

export function needsChanges(judged: Judgment | undefined): boolean {
  return judged?.kind === "needs_changes" && judged.confidence >= MIN_CONFIDENCE
}

/** An approval that lists at least one finding, confidently: its notes go to the agent once. */
export function listsFindings(judged: Judgment | undefined): boolean {
  return (judged?.kind === "one_finding" || judged?.kind === "several_findings") && judged.confidence >= MIN_CONFIDENCE
}

export interface JudgeLogEntry {
  at: string; pr: number; head: string; item: string; fp: string; author: string | null; postedAs: string
  prompt: string; ms: number; text: string
  answer?: { kind: JudgeKind; confidence: number; probabilities: Record<string, number>; model: string }
  inputTokens?: number; costUsd?: number; error?: string
}

/** A version of an item the judge could not answer: how often, and when to ask again. */
export interface JudgeMiss { fp: string; count: number; retryAt: string }

/** Failures of one version before auto-merge stops waiting for its answer. */
export const JUDGE_FAILURE_LIMIT = 3

/**
 * Judge each candidate whose current version has not been answered, unless it
 * failed recently: a failed version is asked again after 1, 2, 4 … up to 30
 * minutes, so a dead key costs a call now and then, and one body the service
 * cannot take never slows the others. A call cut short by shutdown counts for
 * nothing.
 */
export async function judgeUndecided(input: {
  candidates: JudgeCandidate[]
  judged: Readonly<Record<string, Judged>> | undefined
  misses?: Readonly<Record<string, JudgeMiss>>
  client: JudgeClient
  pr: Pick<PrSnapshot, "number" | "head">
  log: (entry: JudgeLogEntry) => void
  signal: AbortSignal
  now: () => Date
}): Promise<{ judged: Record<string, Judged>; misses: Record<string, JudgeMiss> }> {
  const ledger: Record<string, Judged> = { ...input.judged }
  const misses: Record<string, JudgeMiss> = { ...input.misses }
  const nowMs = input.now().getTime()
  const due = input.candidates
    .filter((candidate) => ledger[candidate.id]?.fp !== candidate.fp)
    .filter((candidate) => misses[candidate.id]?.fp !== candidate.fp || !(nowMs < Date.parse(misses[candidate.id]!.retryAt)))
    .sort((a, b) => b.order.localeCompare(a.order)).slice(0, PER_LOOK)
  await Promise.all(due.map(async (candidate) => {
    const started = performance.now()
    const base = {
      at: input.now().toISOString(), pr: input.pr.number, head: input.pr.head, item: candidate.id, fp: candidate.fp,
      author: candidate.author, postedAs: candidate.postedAs, prompt: JUDGE_PROMPTS[candidate.question ?? "kind"], text: sentText(candidate.text),
    }
    try {
      const answer = await input.client({ text: candidate.text, bot: candidate.bot, postedAs: candidate.postedAs, question: candidate.question ?? "kind" }, input.signal)
      delete ledger[candidate.id]
      delete misses[candidate.id]
      ledger[candidate.id] = { fp: candidate.fp, kind: answer.kind, confidence: answer.confidence, model: answer.model }
      input.log({
        ...base, ms: Math.round(performance.now() - started), inputTokens: answer.inputTokens, costUsd: answer.inputTokens * JEV_USD_PER_INPUT_TOKEN,
        answer: { kind: answer.kind, confidence: answer.confidence, probabilities: answer.probabilities, model: answer.model },
      })
    } catch (error) {
      if (input.signal.aborted) return
      const count = misses[candidate.id]?.fp === candidate.fp ? misses[candidate.id]!.count + 1 : 1
      delete misses[candidate.id]
      misses[candidate.id] = { fp: candidate.fp, count, retryAt: new Date(nowMs + Math.min(2 ** (count - 1), 30) * 60_000).toISOString() }
      input.log({ ...base, ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) })
    }
  }))
  const bounded = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).slice(-LEDGER_LIMIT))
  return { judged: bounded(ledger), misses: bounded(misses) }
}

/** What a look learned from the judge. */
export interface JudgeLook {
  candidates: JudgeCandidate[]
  judged: Record<string, Judged>
  misses: Record<string, JudgeMiss>
  /** items whose current version failed for the JUDGE_FAILURE_LIMIT-th time in this look */
  gaveUp: string[]
}

/** One look's judging. Updates the checkpoint's ledgers. */
export async function judgeLook(input: {
  candidates: JudgeCandidate[]
  checkpoint: { judged?: Record<string, Judged>; judgeMisses?: Record<string, JudgeMiss> }
  client: JudgeClient
  pr: Pick<PrSnapshot, "number" | "head">
  log: (entry: JudgeLogEntry) => void
  signal: AbortSignal
  now: () => Date
}): Promise<JudgeLook> {
  const { checkpoint } = input
  const before = checkpoint.judgeMisses ?? {}
  const result = await judgeUndecided({ ...input, judged: checkpoint.judged, misses: before })
  checkpoint.judged = result.judged
  if (Object.keys(result.misses).length > 0) checkpoint.judgeMisses = result.misses
  else delete checkpoint.judgeMisses
  const gaveUp = Object.entries(result.misses)
    .filter(([id, miss]) => miss.count === JUDGE_FAILURE_LIMIT && before[id]?.count !== JUDGE_FAILURE_LIMIT)
    .map(([id]) => id)
  return { candidates: input.candidates, judged: result.judged, misses: result.misses, gaveUp }
}

const VERDICTS: ReadonlySet<JudgeKind> = new Set(["needs_changes", "minor_only", "all_clear"])
/** How long after a new head auto-merge waits for a bot that found problems on an earlier one to speak again. */
export const PASS_WAIT_MS = 20 * 60_000

export interface JudgedHead {
  /** bots whose latest verdict, about this head, asks for changes: a person decides */
  problems: { author: string; url: string }[]
  /** bots that found problems on an earlier head and have not spoken on this one yet */
  awaited: string[]
  /** a bot's newest words have no answer yet, and the judge has not failed on them too often */
  pending: boolean
}

/**
 * What the judge's answers say about merging this head.
 *
 * - A bot speaks per channel (its comments, its reviews) through its latest
 *   verdict: a later all-clear or an edit of the same summary supersedes an
 *   old finding, and a status board or a reply says nothing.
 * - A finding about this head holds the merge, unless the same bot has since
 *   approved this head. A review is about the commit it names; a comment,
 *   about the head it was written after.
 * - A finding about an earlier head waits for that bot to speak on this one:
 *   any review of this head, a new comment, or its own check finishing. It
 *   waits at most PASS_WAIT_MS from when this head was first seen.
 */
export function judgedHead(all: Pick<JudgeLook, "candidates" | "judged" | "misses">, pr: PrSnapshot, times: { sinceMs: number; firstSeenMs: number; nowMs: number }): JudgedHead {
  // an approval's notes are a round at most, never a reason to hold the merge
  const look = { ...all, candidates: all.candidates.filter((candidate) => (candidate.question ?? "kind") === "kind") }
  const { judged } = look
  const answered = (candidate: JudgeCandidate) => judged[candidate.id]?.fp === candidate.fp
  const newest = new Map<string, JudgeCandidate>()
  const verdict = new Map<string, JudgeCandidate>()
  for (const candidate of look.candidates) {
    const channel = `${candidate.author ?? "ghost"}\u0000${candidate.postedAs}`
    const later = (before: JudgeCandidate | undefined) => !before || candidate.order > before.order
    if (later(newest.get(channel))) newest.set(channel, candidate)
    if (answered(candidate) && VERDICTS.has(judged[candidate.id]!.kind) && later(verdict.get(channel))) verdict.set(channel, candidate)
  }
  const pending = [...newest.values()].some((candidate) =>
    !answered(candidate) && !(look.misses[candidate.id]?.fp === candidate.fp && look.misses[candidate.id]!.count >= JUDGE_FAILURE_LIMIT))
  const problems: JudgedHead["problems"] = []
  const awaited = new Set<string>()
  for (const candidate of verdict.values()) {
    if (!needsChanges(judged[candidate.id])) continue
    const author = candidate.author ?? "ghost"
    const aboutHead = candidate.commit ? candidate.commit === pr.head : !(Date.parse(candidate.fp) < times.sinceMs)
    if (aboutHead) {
      if (!approvedSince(pr, author, candidate.order)) problems.push({ author, url: candidate.url })
    } else if (!spokeOnHead(pr, look, author, times.sinceMs) && times.nowMs - times.firstSeenMs < PASS_WAIT_MS) {
      awaited.add(author)
    }
  }
  return { problems, awaited: [...awaited], pending }
}

/** The bot approved this head after it wrote the finding: a formal approval or an approving verdict. */
function approvedSince(pr: PrSnapshot, author: string, after: string): boolean {
  return pr.reviews.some((review) => review.author === author && review.commit === pr.head && review.submittedAt > after &&
    (review.state === "APPROVED" || parseVerdict(review.body) === "approve"))
}

/**
 * The bot has spoken on this head: a review of it in any state, its own check
 * done, or a comment since that the judge read as a verdict. A status edit
 * ("review in progress…") is not a pass.
 */
function spokeOnHead(pr: PrSnapshot, look: Pick<JudgeLook, "candidates" | "judged">, author: string, sinceMs: number): boolean {
  const verdictSince = (candidate: JudgeCandidate) => {
    const judged = look.judged[candidate.id]
    return judged?.fp === candidate.fp && VERDICTS.has(judged.kind) && !(Date.parse(candidate.fp) < sinceMs)
  }
  return pr.reviews.some((review) => review.author === author && review.commit === pr.head && review.state !== "PENDING") ||
    pr.checks.some((check) => check.app === author && classifyCheck(check) !== "pending") ||
    look.candidates.some((candidate) => candidate.postedAs === "comment" && candidate.author === author && verdictSince(candidate))
}

/** Where a row's judge calls are logged: beside its round evidence, one JSON object per line. */
export function judgeLogPath(taskId: string, rowId: string): string {
  return join(TASKS_DIR, taskId, "autopilot", rowId, "judge.jsonl")
}

/** Append one call to the row's log (the previous 2 MB are kept as judge.1.jsonl) and count it. */
export function writeJudgeLog(taskId: string, rowId: string, entry: JudgeLogEntry): void {
  const file = judgeLogPath(taskId, rowId)
  try {
    mkdirSync(join(TASKS_DIR, taskId, "autopilot", rowId), { recursive: true, mode: 0o700 })
    if (existsSync(file) && statSync(file).size > LOG_LIMIT_BYTES) renameSync(file, file.replace(/\.jsonl$/, ".1.jsonl"))
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    countJudgeUsage(entry.at, entry.inputTokens ?? 0, Boolean(entry.error))
  } catch (error) {
    console.error(`[wisp] could not log a review-judge call: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export interface JudgeUsage { month: string; calls: number; errors: number; inputTokens: number; costUsd: number }
type UsageFile = Record<string, { calls: number; errors: number; inputTokens: number }>

const usagePath = () => join(WISP_HOME, "judge-usage.json")

function readUsage(): UsageFile {
  try {
    const raw: unknown = JSON.parse(readFileSync(usagePath(), "utf8"))
    return isRecord(raw) ? raw as UsageFile : {}
  } catch {
    return {}
  }
}

/** Count one call for the month (the settings test probe included). Written whole, then renamed into place. */
export function countJudgeUsage(at: string, inputTokens: number, error: boolean): void {
  const usage = readUsage()
  const month = at.slice(0, 7)
  const current = usage[month] ?? { calls: 0, errors: 0, inputTokens: 0 }
  usage[month] = { calls: current.calls + 1, errors: current.errors + (error ? 1 : 0), inputTokens: current.inputTokens + inputTokens }
  // twelve months is plenty for a settings line
  const kept = Object.fromEntries(Object.entries(usage).sort(([a], [b]) => a.localeCompare(b)).slice(-12))
  const temporary = `${usagePath()}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(kept)}\n`, { mode: 0o600 })
  renameSync(temporary, usagePath())
}

export function judgeUsage(now: Date): JudgeUsage {
  const month = now.toISOString().slice(0, 7)
  const current = readUsage()[month] ?? { calls: 0, errors: 0, inputTokens: 0 }
  return { month, ...current, costUsd: current.inputTokens * JEV_USD_PER_INPUT_TOKEN }
}
