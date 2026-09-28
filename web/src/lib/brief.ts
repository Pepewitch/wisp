/**
 * The task brief band's words, derived from `GET /api/tasks/:id/brief` and
 * nothing else — so every sentence the band can say is testable here, away
 * from layout (skills/wisp-dev/references/frontend.md §5k).
 *
 * Two voices, kept apart on purpose: what Wisp RECORDED (your words, their
 * delivery, the turn, the time) and what the agent REPORTED (goal, result,
 * remaining, decision). No state here claims the goal is complete; the best a
 * brief can be is recent.
 */
import type { BriefLatestInput, BriefReason, BriefView, TaskBriefV1 } from "../../../shared/task-brief"
import { fromNow } from "./time"

export type { BriefLatestInput, BriefView, TaskBriefV1 }

/** The person's words as the band shows them. */
export interface BriefInputView {
  label: "You asked" | "You answered"
  /** for an answer: the question that gives its text meaning */
  question: string | null
  /** exact text — already an excerpt when the daemon cut it */
  text: string
  /** the daemon cut the text; the band must say so and offer the conversation */
  truncated: boolean
  /** facts about the words, never inside them */
  caption: string[]
  /** where find-in-task should look to show the words in the conversation */
  find: { query: string; turn: number | null }
}

export type BriefBandModel =
  /** off, or nothing to say yet: the band does not render */
  | { kind: "hidden" }
  /** one line and nothing to open: empty, unsupported, or an error with its repair */
  | { kind: "line"; text: string; retry?: boolean }
  | {
    kind: "report"
    /** the collapsed line: the decision if one waits, otherwise the result */
    headline: { label: string | null; text: string }
    /** the ONE freshness fact on the header's right edge */
    status: string[]
    /** where the speaker changes: "The agent's report", and why it may be older */
    divider: string
    brief: TaskBriefV1
    input: BriefInputView | null
    /** identifies this report, so a disclosure opened on one is not carried to the next */
    key: string
  }

const has = (view: BriefView, reason: BriefReason) => view.reasons.includes(reason)

/** Words for "what the person said last", in the caption register of a person bubble. */
function inputCaption(input: BriefLatestInput, now: number): string[] {
  const when = fromNow(input.at, now)
  const delivery = (() => {
    switch (input.delivery) {
      case "queued": return "queued for the next turn"
      case "steered": return input.turnN === null ? "sent mid-turn" : `sent mid-turn ${input.turnN}`
      case "started": return input.kind === "task-prompt" ? "task prompt, as stored" : `started turn ${input.turnN ?? "?"}`
      case "uncertain": return "may not have arrived"
      case "pending": return "being delivered"
      case "delivered": return input.turnN === null ? "delivered" : `answered in turn ${input.turnN}`
    }
  })()
  return [delivery, input.legacy ? "recorded before briefs existed" : null, input.delivery === "queued" ? null : when]
    .filter((part): part is string => Boolean(part))
}

/** The first line of the words, short enough to be a find query that still hits. */
function findQuery(text: string): string {
  const first = text.split("\n").map((line) => line.trim()).find(Boolean) ?? ""
  return [...first].slice(0, 60).join("")
}

export function briefInput(input: BriefLatestInput | null, now: number): BriefInputView | null {
  if (!input) return null
  return {
    label: input.kind === "answer" ? "You answered" : "You asked",
    question: input.question,
    text: input.text,
    truncated: input.truncated,
    caption: inputCaption(input, now),
    find: { query: findQuery(input.text), turn: input.turnN },
  }
}

/** The empty band's one line, when switched on and no report exists yet. */
function emptyLine(view: BriefView): string {
  if (!view.supported) return `${view.harness} can't write briefs through Wisp yet.`
  if (has(view, "awaiting-next-turn")) return "Starts with the next turn — this one began before briefs were on."
  const turn = view.latestEligibleTurn
  if (turn?.status === "running") return `Turn ${turn.n} is running; its brief comes at the end.`
  if (turn) return `Turn ${turn.n} ended without one.`
  return "Starts with the next turn."
}

/** The single freshness fact, most consequential first. */
function statusFact(view: BriefView, reportTurn: number, savedAt: string, now: number): string {
  const latest = view.latestTurn
  const later = view.latestEligibleTurn
  const inputWord = view.latestInput?.kind === "answer" ? "answer" : "message"
  if (has(view, "provisional")) return "still running"
  if (has(view, "source-failed")) return "that turn failed"
  if (has(view, "source-interrupted")) return "that turn was stopped"
  if (has(view, "newer-turn-unreported") && later) return `turn ${later.n} sent none`
  if (has(view, "newer-turn") && latest?.status === "running") return `turn ${latest.n} running`
  if (has(view, "newer-input")) return `older than your latest ${inputWord}`
  if (has(view, "input-uncertain")) return `your latest ${inputWord} may not have arrived`
  if (has(view, "newer-context")) return "before the fresh context"
  if (has(view, "newer-turn") && latest) return `turn ${latest.n} ran since`
  return fromNow(savedAt, now) || `turn ${reportTurn}`
}

function dividerText(view: BriefView): string {
  const clauses: string[] = []
  if (has(view, "newer-input")) clauses.push("written before your latest input")
  else if (has(view, "input-changed")) clauses.push("your input changed since")
  if (has(view, "newer-turn-unreported") && view.latestEligibleTurn) clauses.push(`turn ${view.latestEligibleTurn.n} ended without one`)
  if (!view.supported) clauses.push(`${view.harness} can't write new ones`)
  return clauses.length > 0 ? `The agent's report — ${clauses.join("; ")}` : "The agent's report"
}

/**
 * The band for one task. `view` undefined is still loading (render nothing:
 * a placeholder that then turns into content is a jump for no information);
 * `error` is a read that failed, and says so with its own repair.
 */
export function briefBand(view: BriefView | undefined, error: unknown, now: number): BriefBandModel {
  if (error && !view) return { kind: "line", text: "Couldn't load the brief.", retry: true }
  if (!view || !view.enabled) return { kind: "hidden" }
  const report = view.report
  if (!report) return { kind: "line", text: emptyLine(view) }
  const { brief } = report
  return {
    kind: "report",
    headline: brief.decision
      ? { label: "Decision", text: brief.decision.question }
      : { label: null, text: brief.outcome },
    status: [`turn ${report.turn.n}`, statusFact(view, report.turn.n, report.savedAt, now)],
    divider: dividerText(view),
    brief,
    input: briefInput(view.latestInput, now),
    key: `${report.turn.n}:${report.revision}`,
  }
}

/**
 * The switch's one-line note in the task menu, or null when there is nothing
 * worth saying. `settings` is the answer to the last change, when there was one.
 */
export function briefMenuNote(options: {
  enabled: boolean
  supported: boolean
  harness: string
  running: boolean
  justEnabled: boolean
}): string | null {
  if (!options.supported) return `${options.harness} can't write briefs through Wisp yet.`
  if (!options.enabled) {
    return "At the end of each turn the agent saves a short report: goal, result, what remains, and any decision for you. One extra step per turn."
  }
  if (options.justEnabled && options.running) return "Starts with the next turn — this one began before briefs were on."
  if (options.justEnabled) return "Starts with the next turn."
  return null
}
