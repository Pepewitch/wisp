/**
 * The task brief an agent publishes with `wisp brief set --stdin`: version 1
 * of the payload, its limits, and the one validator the CLI (before sending)
 * and the daemon (before storing) both run. Validation proves structure, not
 * truth — every string here is untrusted display text the agent wrote.
 *
 * Limits count Unicode code points, not UTF-16 units, so an emoji or a CJK
 * character costs what it looks like it costs.
 */

export interface TaskBriefOption {
  label: string
  gain: string
  downside: string
  /** who or what behaviour is affected, and any compatibility concern */
  impact: string
  /** relative and qualified ("small — about today's change"); null = not assessed */
  effort: string | null
}

export interface TaskBriefDecision {
  question: string
  recommendation: string | null
  options: TaskBriefOption[]
  unknowns?: string[]
  /** required with a single option: what else was considered, or that nothing was */
  alternativesNote?: string | null
}

export interface TaskBriefV1 {
  version: 1
  outcome: string
  /** null = the agent cannot say what remains; [] = none known (never "goal complete") */
  remaining: string[] | null
  goal?: string | null
  scopeChange?: string | null
  decision?: TaskBriefDecision | null
}

export const TASK_BRIEF_VERSION = 1

export const TASK_BRIEF_LIMITS = {
  /** the serialized payload, in UTF-8 bytes */
  payloadBytes: 12 * 1024,
  outcome: 600,
  goal: 240,
  scopeChange: 400,
  remainingItems: 5,
  remainingItem: 240,
  options: 3,
  /** every string inside a decision */
  decisionText: 240,
  unknowns: 3,
} as const

export type TaskBriefCheck = { ok: true; brief: TaskBriefV1 } | { ok: false; field: string; message: string }

const TOP_KEYS = ["version", "outcome", "remaining", "goal", "scopeChange", "decision"]
const DECISION_KEYS = ["question", "recommendation", "options", "unknowns", "alternativesNote"]
const OPTION_KEYS = ["label", "gain", "downside", "impact", "effort"]

class Invalid extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(message)
    this.field = field
  }
}

function kind(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return typeof value === "object" ? "an object" : typeof value
}

function record(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Invalid(field, `must be an object, got ${kind(value)}`)
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Invalid(field ? `${field}.${key}` : key, "is not a field of a version 1 brief")
  }
  return value as Record<string, unknown>
}

/** A present string with real text in it, within `max` code points. */
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Invalid(field, `must be a string, got ${kind(value)}`)
  if (!/\S/u.test(value)) throw new Invalid(field, "must contain text; use null or an explicit unknown instead of a blank")
  const length = [...value].length
  if (length > max) throw new Invalid(field, `must be at most ${max} characters (got ${length})`)
  return value
}

function nullableText(value: unknown, field: string, max: number): string | null {
  return value === null ? null : text(value, field, max)
}

function textList(value: unknown, field: string, maxItems: number, maxEach: number): string[] {
  if (!Array.isArray(value)) throw new Invalid(field, `must be an array, got ${kind(value)}`)
  if (value.length > maxItems) {
    throw new Invalid(field, `must have at most ${maxItems} items (got ${value.length}); group related items`)
  }
  return value.map((item, i) => text(item, `${field}[${i}]`, maxEach))
}

function option(value: unknown, field: string): TaskBriefOption {
  const raw = record(value, field, OPTION_KEYS)
  const max = TASK_BRIEF_LIMITS.decisionText
  for (const key of OPTION_KEYS) if (!(key in raw)) throw new Invalid(`${field}.${key}`, "is required")
  return {
    label: text(raw.label, `${field}.label`, max),
    gain: text(raw.gain, `${field}.gain`, max),
    downside: text(raw.downside, `${field}.downside`, max),
    impact: text(raw.impact, `${field}.impact`, max),
    effort: nullableText(raw.effort, `${field}.effort`, max),
  }
}

function decision(value: unknown): TaskBriefDecision {
  const raw = record(value, "decision", DECISION_KEYS)
  const max = TASK_BRIEF_LIMITS.decisionText
  if (!("question" in raw)) throw new Invalid("decision.question", "is required")
  if (!("recommendation" in raw)) throw new Invalid("decision.recommendation", "is required (null when there is none)")
  if (!("options" in raw)) throw new Invalid("decision.options", "is required")
  const question = text(raw.question, "decision.question", max)
  const recommendation = nullableText(raw.recommendation, "decision.recommendation", max)
  if (!Array.isArray(raw.options)) throw new Invalid("decision.options", `must be an array, got ${kind(raw.options)}`)
  if (raw.options.length < 1 || raw.options.length > TASK_BRIEF_LIMITS.options) {
    throw new Invalid("decision.options", `must have 1 to ${TASK_BRIEF_LIMITS.options} options (got ${raw.options.length})`)
  }
  const options = raw.options.map((item, i) => option(item, `decision.options[${i}]`))
  const out: TaskBriefDecision = { question, recommendation, options }
  if (raw.unknowns !== undefined) out.unknowns = textList(raw.unknowns, "decision.unknowns", TASK_BRIEF_LIMITS.unknowns, max)
  if (raw.alternativesNote !== undefined) out.alternativesNote = nullableText(raw.alternativesNote, "decision.alternativesNote", max)
  if (options.length === 1 && !out.alternativesNote) {
    throw new Invalid(
      "decision.alternativesNote",
      "is required with a single option: say what else was considered, or that alternatives were not explored",
    )
  }
  return out
}

/**
 * Check one parsed payload against version 1. Everything is rejected rather
 * than coerced or truncated: a partially valid brief is never stored.
 */
export function validateTaskBrief(value: unknown): TaskBriefCheck {
  try {
    const raw = record(value, "", TOP_KEYS)
    if (!("version" in raw)) throw new Invalid("version", "is required (1)")
    if (raw.version !== TASK_BRIEF_VERSION) {
      throw new Invalid("version", `must be ${TASK_BRIEF_VERSION}; this Wisp does not read brief version ${JSON.stringify(raw.version)}`)
    }
    if (!("outcome" in raw)) throw new Invalid("outcome", "is required")
    if (!("remaining" in raw)) throw new Invalid("remaining", "is required ([] when none is known, null when you cannot say)")
    const brief: TaskBriefV1 = {
      version: 1,
      outcome: text(raw.outcome, "outcome", TASK_BRIEF_LIMITS.outcome),
      remaining: raw.remaining === null
        ? null
        : textList(raw.remaining, "remaining", TASK_BRIEF_LIMITS.remainingItems, TASK_BRIEF_LIMITS.remainingItem),
    }
    if (raw.goal !== undefined) brief.goal = nullableText(raw.goal, "goal", TASK_BRIEF_LIMITS.goal)
    if (raw.scopeChange !== undefined) brief.scopeChange = nullableText(raw.scopeChange, "scopeChange", TASK_BRIEF_LIMITS.scopeChange)
    if (raw.decision !== undefined) brief.decision = raw.decision === null ? null : decision(raw.decision)
    const bytes = new TextEncoder().encode(JSON.stringify(brief)).byteLength
    if (bytes > TASK_BRIEF_LIMITS.payloadBytes) {
      throw new Invalid("", `the brief is ${bytes} bytes; the limit is ${TASK_BRIEF_LIMITS.payloadBytes}`)
    }
    return { ok: true, brief }
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, field: error.field, message: error.message }
    throw error
  }
}

/** One line naming the field, for a CLI error or a 400 — never the payload itself. */
export function briefErrorLine(check: Extract<TaskBriefCheck, { ok: false }>): string {
  return check.field ? `${check.field} ${check.message}` : check.message
}

/**
 * Deterministic JSON: object keys sorted at every level, array order kept. Two
 * payloads that differ only in property order are the same brief, so an
 * identical retry is recognised however the agent's JSON was laid out.
 */
export function canonicalBriefJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(v).sort()) out[key] = sort((v as Record<string, unknown>)[key])
      return out
    }
    return v
  }
  return JSON.stringify(sort(value))
}

/** What a publication came to, as the daemon answers `PUT /api/tasks/:id/brief`. */
export type BriefPublication =
  | { kind: "saved"; revision: number }
  | { kind: "unchanged"; revision: number }
  /** a normal, successful non-write: never a request to retry */
  | { kind: "skipped"; reason: "disabled" | "run-ended" | "archived" }

/**
 * Why a brief reads the way it does. Several hold at once — a report kept from
 * turn 3 while turn 4 ended without one is `newer-turn` and
 * `newer-turn-unreported` together. A client picks its one line from these;
 * none of them is ever a claim that the goal is complete.
 */
export type BriefReason =
  /** the switch is off; any report shown is historical */
  | "disabled"
  /** the task's current harness cannot publish; no reminder is sent */
  | "unsupported"
  /** enabled while a turn that started without a binding is still running */
  | "awaiting-next-turn"
  /** enabled, and the latest eligible turn has no report (why is never guessed) */
  | "no-report"
  /** the report's own turn is still running */
  | "provisional"
  | "source-failed"
  | "source-interrupted"
  /** a later turn exists than the one the report came from */
  | "newer-turn"
  /** a later eligible turn settled without a report */
  | "newer-turn-unreported"
  /** a fresh context started after the report's turn */
  | "newer-context"
  /** the person said something (a message or an answer) after the report was saved */
  | "newer-input"
  /** nothing new, but an input the report saw was edited, cancelled or delivered since */
  | "input-changed"
  /** whether the latest input reached the agent is not known */
  | "input-uncertain"
  /** the latest input predates origin tracking, so Wisp cannot prove a person wrote it */
  | "coverage-legacy"

export type BriefTurnStatus = "running" | "done" | "failed" | "interrupted"

/** The most recent thing the person said, as Wisp recorded it — never as the agent retold it. */
export interface BriefLatestInput {
  /** a message, an answer to the agent's questionnaire, or the task's first prompt */
  kind: "message" | "answer" | "task-prompt"
  /** the message id, the observation id, or null for the task prompt */
  id: string | null
  /** exact text, cut at `BRIEF_INPUT_EXCERPT` code points when `truncated` */
  text: string
  truncated: boolean
  /** the full text's length, in code points */
  length: number
  /** for an answer: the question it answers, which is what gives "yes" its meaning */
  question: string | null
  delivery: "queued" | "started" | "steered" | "uncertain" | "pending" | "delivered"
  /** the turn it started or was steered into; null while it waits */
  turnN: number | null
  at: string
  /** recorded before Wisp tracked who wrote a message */
  legacy: boolean
}

/** How much of the latest input the read model carries; the rest is in the conversation. */
export const BRIEF_INPUT_EXCERPT = 2000

/** `GET /api/tasks/:id/brief` — reading it never generates anything. */
export interface BriefView {
  enabled: boolean
  generation: number
  archived: boolean
  harness: string
  /** the task's current harness can publish */
  supported: boolean
  /** off; a running turn holds a binding; or the next eligible turn will be the first */
  activation: "off" | "active" | "next-turn"
  /** the latest report by source-turn order, or null */
  report: {
    turn: { n: number; status: BriefTurnStatus; contextN: number; endedAt: string | null }
    revision: number
    savedAt: string
    brief: TaskBriefV1
  } | null
  latestEligibleTurn: { n: number; status: BriefTurnStatus; reported: boolean } | null
  latestTurn: { n: number; status: BriefTurnStatus; contextN: number } | null
  latestInput: BriefLatestInput | null
  reasons: BriefReason[]
}

export interface BriefSettings {
  enabled: boolean
  generation: number
  activation: BriefView["activation"]
  /** a turn is running right now — with `next-turn`, it began before briefs were on */
  turnRunning: boolean
}
