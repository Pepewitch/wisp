/**
 * `wisp brief set|show|enable|disable`. Help, usage and every `--help` are
 * answered earlier, in index.ts, from cli-brief-help.ts — before config loads.
 *
 * `set` is what an agent runs, so every answer is ONE short line. A save that
 * is skipped, unchanged or conflicting exits 0: it is final, and saying so in
 * a way that invites a retry would turn a best-effort report into a loop. A
 * mistake in the agent's own JSON exits 1 and names the field, so it can fix
 * it once; so do an unreachable or older daemon and a refused binding, each
 * with a sentence telling the agent to carry on without the brief.
 *
 * Everything `show` prints about a brief is untrusted text an agent wrote, so
 * it passes through `controlFree` on its way to the terminal; `--json` stays
 * lossless, with C1 controls escaped too.
 */
import { briefErrorLine, validateTaskBrief, type BriefPublication, type BriefSettings, type BriefView } from "../../shared/task-brief"
import type { Flags } from "./cli-args"
import { CliApiError, daemonRequest, exitApi } from "./cli-api"
import { briefSetUsage, briefUsage } from "./cli-brief-help"
import { wispCommand } from "./command"
import { print, printError, printJson } from "./cli-print"
import { controlFree } from "./control-free"
import { BRIEF_RUN_ENV } from "./turn-input"

/** A daemon that takes longer than this must not hold an agent's handoff up. */
export const BRIEF_PUBLISH_TIMEOUT_MS = 5000

/**
 * What `set` reads from stdin: the payload's own limit is checked on its
 * compact form by the validator, so this leaves room for a pretty-printed or
 * `\u`-escaped brief that is still inside it.
 */
const STDIN_LIMIT_BYTES = 16 * 1024

/** A stdin that stays open and silent this long was never going to send a brief. */
const STDIN_IDLE_MS = 10_000

const TASK_ID = /^[a-z0-9]+$/

class BriefUsageError extends Error {}

function taskArgument(positional: string[]): string {
  const task = positional[1] ?? process.env.WISP_TASK_ID ?? ""
  if (!TASK_ID.test(task)) throw new BriefUsageError(task ? `not a task id: ${controlFree(task)}` : "name a task, or run this inside one")
  return task
}

/**
 * Read stdin up to `limit` bytes. `null` when it is larger, `"idle"` when it
 * stays open with nothing arriving — a tool shell whose stdin never closes
 * must not hold the agent's turn.
 */
function boundedStdin(limit: number, idleMs: number): Promise<Uint8Array | null | "idle"> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = []
    let total = 0
    let timer = setTimeout(() => done("idle"), idleMs)
    const onData = (chunk: Uint8Array) => {
      total += chunk.byteLength
      if (total > limit) return done(null)
      chunks.push(chunk)
      clearTimeout(timer)
      timer = setTimeout(() => done("idle"), idleMs)
    }
    const onEnd = () => done(Buffer.concat(chunks))
    function done(value: Uint8Array | null | "idle") {
      clearTimeout(timer)
      process.stdin.off("data", onData)
      process.stdin.off("end", onEnd)
      process.stdin.pause()
      resolve(value)
    }
    process.stdin.on("data", onData)
    process.stdin.on("end", onEnd)
  })
}

/** One line to the agent, made terminal-safe (a field error can quote a key the agent chose), then exit. */
function say(line: string, exit: number): never {
  ;(exit === 0 ? print : printError)(line)
  process.exit(exit)
}

const SKIPPED: Record<Extract<BriefPublication, { kind: "skipped" }>["reason"], string> = {
  disabled: "briefs are off for this task",
  superseded: "briefs were switched off and on again after this turn began",
  "run-ended": "this turn has already ended",
  archived: "the task is archived",
}

async function publish(task: string, runId: string, expectedRevision: number, payload: unknown): Promise<never> {
  let result: BriefPublication
  try {
    result = await daemonRequest(
      `/api/tasks/${task}/brief`,
      "PUT",
      JSON.stringify({ runId, expectedRevision, payload }),
      "application/json",
      BRIEF_PUBLISH_TIMEOUT_MS,
    ) as BriefPublication
  } catch (error) {
    if (error instanceof CliApiError) {
      if (error.status === 409) say("Brief skipped: this turn's brief already has a different revision. Do not retry.", 0)
      if (error.status === 404 && error.message === "not found") {
        say("Brief not saved: this Wisp daemon does not support task briefs. Continue without it.", 1)
      }
      if (error.timedOut || error.unreachable) say(`Brief not saved: ${error.message}. Continue without it.`, 1)
    }
    say(`Brief not saved: ${error instanceof Error ? error.message : String(error)}. Continue without it.`, 1)
  }
  if (result?.kind === "saved") say(`Brief saved (revision ${result.revision}).`, 0)
  if (result?.kind === "unchanged") say(`Brief unchanged (revision ${result.revision}).`, 0)
  if (result?.kind === "skipped" && result.reason in SKIPPED) say(`Brief skipped: ${SKIPPED[result.reason]}. Continue normally.`, 0)
  say("Brief not saved: the daemon gave an answer this CLI does not understand. Continue without it.", 1)
}

async function setBrief(flags: Flags): Promise<never> {
  if (flags.stdin !== true || process.stdin.isTTY) say(briefSetUsage(), 2)
  let expectedRevision = 0
  if (flags.replace !== undefined) {
    const n = typeof flags.replace === "string" && /^[1-9][0-9]*$/.test(flags.replace) ? Number(flags.replace) : NaN
    if (!Number.isSafeInteger(n)) say(`--replace needs the revision a save printed, e.g. --replace 1\n${briefSetUsage()}`, 2)
    expectedRevision = n
  }
  // an unbound turn never reads stdin at all: there is nothing to save it to
  const task = process.env.WISP_TASK_ID ?? ""
  const runId = process.env[BRIEF_RUN_ENV] ?? ""
  if (!TASK_ID.test(task) || runId === "") say("Brief skipped: this turn was not asked for a brief. Continue normally.", 0)

  const bytes = await boundedStdin(STDIN_LIMIT_BYTES, STDIN_IDLE_MS)
  if (bytes === "idle") say(`Brief not saved: no JSON arrived on stdin.\n${briefSetUsage()}`, 2)
  if (bytes === null) say(`Brief not saved: stdin is over ${STDIN_LIMIT_BYTES} bytes. Shorten the brief and save once more.`, 1)
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch (error) {
    // the parser's position, never the text: the payload is not echoed back
    const where = error instanceof Error ? error.message.replace(/"[^"]*"/g, "…") : "invalid JSON"
    say(`Brief not saved: stdin is not valid JSON (${where}).`, 1)
  }
  const check = validateTaskBrief(payload)
  // a guessed shape is the common mistake, so the one retry is pointed at the schema
  if (!check.ok) say(`Brief not saved: ${briefErrorLine(check)}. See \`${wispCommand()} brief --help\`, fix it, and save once more.`, 1)
  return publish(task, runId, expectedRevision, check.brief)
}

const DELIVERY: Record<NonNullable<BriefView["latestInput"]>["delivery"], string> = {
  queued: "queued for the next turn",
  started: "started a turn",
  steered: "sent mid-turn",
  uncertain: "delivery uncertain",
  pending: "being delivered",
  delivered: "delivered",
}

/** Untrusted text, made safe and single-line for a terminal, cut to `max` code points. */
function oneLine(text: string, max: number): string {
  const flat = controlFree(text).replace(/\s+/g, " ").trim()
  return [...flat].length > max ? `${[...flat].slice(0, max).join("")}…` : flat
}

/** Untrusted text, made safe for a terminal; its own line breaks kept. */
const safe = (text: string) => controlFree(text)

/** Your own words, as Wisp stored them, cut to one terminal line. */
function inputLine(view: BriefView): string | null {
  const input = view.latestInput
  if (!input) return null
  const shown = `${oneLine(input.text, 100)}${input.truncated && [...input.text].length <= 100 ? "…" : ""}`
  const what = input.kind === "answer"
    ? `answer to "${oneLine(input.question ?? "", 60)}"`
    : input.kind === "task-prompt" ? "task prompt, as stored" : "message"
  const facts = [what, DELIVERY[input.delivery], input.legacy ? "recorded before briefs existed" : null].filter(Boolean)
  return `you said:  "${shown}" (${facts.join(" · ")})`
}

function decisionLines(decision: NonNullable<BriefView["report"]>["brief"]["decision"]): string[] {
  if (!decision) return []
  const lines = [`decision:  ${safe(decision.question)}`]
  if (decision.recommendation) lines.push(`           recommends: ${safe(decision.recommendation)}`)
  for (const option of decision.options) {
    lines.push(`           · ${safe(option.label)} — gain: ${safe(option.gain)}; downside: ${safe(option.downside)}; affects: ${safe(option.impact)}; effort: ${option.effort ? safe(option.effort) : "not assessed"}`)
  }
  for (const unknown of decision.unknowns ?? []) lines.push(`           unknown: ${safe(unknown)}`)
  if (decision.alternativesNote) lines.push(`           alternatives: ${safe(decision.alternativesNote)}`)
  return lines
}

function formatView(task: string, view: BriefView): string {
  const lines: string[] = []
  // "next-turn" only means no running turn holds a binding; it is news only
  // while no eligible turn has run yet, or while one that predates the switch runs
  const waiting = view.activation === "next-turn" && (view.latestEligibleTurn === null || view.reasons.includes("awaiting-next-turn"))
  const state = view.enabled ? (waiting ? "on — starts with the next turn" : "on") : "off"
  lines.push(`${task}  briefs: ${state}${view.supported ? "" : ` (${safe(view.harness)} can't write briefs)`}`)
  const said = inputLine(view)
  if (said) lines.push(said)
  const report = view.report
  if (!report) {
    lines.push(view.enabled && view.latestEligibleTurn && view.latestEligibleTurn.status !== "running"
      ? `no brief: turn ${view.latestEligibleTurn.n} ended without one`
      : "no brief yet")
    return lines.join("\n")
  }
  const facts = [`from turn ${report.turn.n} (${report.turn.status})`, `revision ${report.revision}`, `saved ${report.savedAt}`]
  const notes: Partial<Record<(typeof view.reasons)[number], string>> = {
    provisional: "its turn is still running",
    "newer-turn": `turn ${view.latestTurn?.n} is newer`,
    "newer-turn-unreported": `turn ${view.latestEligibleTurn?.n} ended without one`,
    "newer-context": "a fresh context started since",
    "newer-input": "older than what you said last",
    "input-pending": "your queued message has not reached the agent",
    "input-changed": "your input changed since",
  }
  for (const reason of view.reasons) if (notes[reason]) facts.push(notes[reason]!)
  lines.push(facts.join(" · "))
  const b = report.brief
  lines.push(`goal:      ${b.goal ? safe(b.goal) : "(not stated)"}`)
  lines.push(`outcome:   ${safe(b.outcome)}`)
  if (b.remaining === null) lines.push("remaining: (the agent could not say)")
  else if (b.remaining.length === 0) lines.push("remaining: none known")
  else for (const [i, item] of b.remaining.entries()) lines.push(`${i === 0 ? "remaining:" : "          "} - ${safe(item)}`)
  if (b.scopeChange) lines.push(`scope:     ${safe(b.scopeChange)}`)
  lines.push(...decisionLines(b.decision))
  return lines.join("\n")
}

function settingsLine(task: string, settings: BriefSettings): string {
  if (!settings.enabled) return `Briefs off for ${task}. Saved briefs are kept.`
  if (settings.activation === "active") return `Briefs on for ${task}.`
  return settings.turnRunning
    ? `Briefs on for ${task}. They start with the next turn; the running one began before briefs were on.`
    : `Briefs on for ${task}. They start with the next turn.`
}

/** `wisp brief …` after help, usage and every `--help` were answered offline. */
export async function briefCommand(positional: string[], flags: Flags): Promise<void> {
  const sub = positional[0]
  try {
    if (sub === "set") return await setBrief(flags)
    if (sub === "show") {
      const task = taskArgument(positional)
      const view = await daemonRequest(`/api/tasks/${task}/brief`) as BriefView
      if (flags.json) printJson(view)
      else print(formatView(task, view))
      return
    }
    if (sub === "enable" || sub === "disable") {
      const task = taskArgument(positional)
      const settings = await daemonRequest(
        `/api/tasks/${task}/brief-settings`,
        "PUT",
        JSON.stringify({ enabled: sub === "enable" }),
      ) as BriefSettings
      if (flags.json) printJson(settings)
      else print(settingsLine(task, settings))
      return
    }
    throw new BriefUsageError(sub ? `unknown brief command: ${controlFree(sub)}` : "")
  } catch (error) {
    if (error instanceof BriefUsageError) {
      if (error.message) printError(`error: ${error.message}`)
      printError(briefUsage())
      process.exit(1)
    }
    exitApi(error)
  }
}
