/**
 * `wisp brief set|show|enable|disable`. Help and the bare `set` usage line are
 * answered earlier, in index.ts, from cli-brief-help.ts — before config loads.
 *
 * `set` is what an agent runs, so every answer is ONE short line and every
 * outcome that is not a mistake in the agent's own JSON exits 0: a skipped,
 * unchanged or conflicting save is final, and saying so in a way that invites
 * a retry would turn a best-effort report into a loop. The daemon being
 * unreachable exits 1 with a sentence telling the agent to carry on.
 */
import { briefErrorLine, TASK_BRIEF_LIMITS, validateTaskBrief, type BriefPublication, type BriefSettings, type BriefView } from "../../shared/task-brief"
import type { Flags } from "./cli-args"
import { CliApiError, daemonRequest, exitApi } from "./cli-api"
import { briefSetUsage } from "./cli-brief-help"
import { wispCommand } from "./command"
import { BRIEF_RUN_ENV } from "./turn-input"

/** A daemon that takes longer than this must not hold an agent's handoff up. */
export const BRIEF_PUBLISH_TIMEOUT_MS = 5000

const TASK_ID = /^[a-z0-9]+$/

export function briefUsage(): string {
  const cmd = wispCommand()
  return [
    `usage: ${cmd} brief set --stdin [--replace <revision>]   an agent saves this turn's brief (help: ${cmd} brief --help)`,
    `       ${cmd} brief show [task] [--json]                   the latest brief, its turn, and why it reads as it does`,
    `       ${cmd} brief enable|disable [task]                  ask each eligible turn for a brief, or stop asking`,
  ].join("\n")
}

class BriefUsageError extends Error {}

function taskArgument(positional: string[]): string {
  const task = positional[1] ?? process.env.WISP_TASK_ID ?? ""
  if (!TASK_ID.test(task)) throw new BriefUsageError(task ? `not a task id: ${task}` : "name a task, or run this inside one")
  return task
}

/** Read stdin up to `limit` bytes; more than that returns null rather than growing forever. */
async function boundedStdin(limit: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > limit) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function say(line: string, exit: number): never {
  ;(exit === 0 ? console.log : console.error)(line)
  process.exit(exit)
}

async function setBrief(flags: Flags): Promise<never> {
  if (flags.stdin !== true || process.stdin.isTTY) say(briefSetUsage(), 2)
  let expectedRevision = 0
  if (flags.replace !== undefined) {
    const n = typeof flags.replace === "string" && /^[1-9][0-9]*$/.test(flags.replace) ? Number(flags.replace) : NaN
    if (!Number.isSafeInteger(n)) say(`--replace needs the revision a save printed, e.g. --replace 1\n${briefSetUsage()}`, 2)
    expectedRevision = n
  }
  const bytes = await boundedStdin(TASK_BRIEF_LIMITS.payloadBytes)
  if (bytes === null) say(`Brief not saved: it is over ${TASK_BRIEF_LIMITS.payloadBytes} bytes. Shorten it and save once more.`, 1)
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch (error) {
    // the parser's position, never the text: the payload is not echoed back
    const where = error instanceof Error ? error.message.replace(/"[^"]*"/g, "…") : "invalid JSON"
    say(`Brief not saved: stdin is not valid JSON (${where}).`, 1)
  }
  const check = validateTaskBrief(payload)
  if (!check.ok) say(`Brief not saved: ${briefErrorLine(check)}. Fix that field and save once more.`, 1)

  const task = process.env.WISP_TASK_ID ?? ""
  const runId = process.env[BRIEF_RUN_ENV] ?? ""
  if (!TASK_ID.test(task) || runId === "") say("Brief skipped: this turn was not asked for a brief. Continue normally.", 0)

  let result: BriefPublication
  try {
    result = await daemonRequest(
      `/api/tasks/${task}/brief`,
      "PUT",
      JSON.stringify({ runId, expectedRevision, payload: check.brief }),
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
  if (result.kind === "saved") say(`Brief saved (revision ${result.revision}).`, 0)
  if (result.kind === "unchanged") say(`Brief unchanged (revision ${result.revision}).`, 0)
  const why = {
    disabled: "briefs are off for this task",
    "run-ended": "this turn has already ended",
    archived: "the task is archived",
  }[result.reason] ?? result.reason
  say(`Brief skipped: ${why}. Continue normally.`, 0)
}

const DELIVERY: Record<NonNullable<BriefView["latestInput"]>["delivery"], string> = {
  queued: "queued for the next turn",
  started: "started a turn",
  steered: "sent mid-turn",
  uncertain: "delivery uncertain",
  pending: "being delivered",
  delivered: "delivered",
}

/** Your own words, exactly as Wisp stored them, cut to one line for a terminal. */
function inputLine(view: BriefView): string | null {
  const input = view.latestInput
  if (!input) return null
  const oneLine = input.text.replace(/\s+/g, " ").trim()
  const shown = [...oneLine].length > 100 ? `${[...oneLine].slice(0, 100).join("")}…` : `${oneLine}${input.truncated ? "…" : ""}`
  const what = input.kind === "answer"
    ? `answer to "${[...(input.question ?? "").replace(/\s+/g, " ")].slice(0, 60).join("")}"`
    : input.kind === "task-prompt" ? "task prompt, as stored" : "message"
  const facts = [what, DELIVERY[input.delivery], input.legacy ? "recorded before briefs existed" : null].filter(Boolean)
  return `you said:  "${shown}" (${facts.join(" · ")})`
}

function formatView(task: string, view: BriefView): string {
  const lines: string[] = []
  // "next-turn" only means no running turn holds a binding; it is news only
  // while no eligible turn has run yet, or while one that predates the switch runs
  const waiting = view.activation === "next-turn" && (view.latestEligibleTurn === null || view.reasons.includes("awaiting-next-turn"))
  const state = view.enabled ? (waiting ? "on — starts with the next turn" : "on") : "off"
  lines.push(`${task}  briefs: ${state}${view.supported ? "" : ` (${view.harness} can't write briefs)`}`)
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
    "input-changed": "your input changed since",
  }
  for (const reason of view.reasons) if (notes[reason]) facts.push(notes[reason]!)
  lines.push(facts.join(" · "))
  const b = report.brief
  lines.push(`goal:      ${b.goal ?? "(not stated)"}`)
  lines.push(`outcome:   ${b.outcome}`)
  if (b.remaining === null) lines.push("remaining: (the agent could not say)")
  else if (b.remaining.length === 0) lines.push("remaining: none known")
  else for (const [i, item] of b.remaining.entries()) lines.push(`${i === 0 ? "remaining:" : "          "} - ${item}`)
  if (b.scopeChange) lines.push(`scope:     ${b.scopeChange}`)
  if (b.decision) {
    lines.push(`decision:  ${b.decision.question}`)
    if (b.decision.recommendation) lines.push(`           recommends: ${b.decision.recommendation}`)
    for (const option of b.decision.options) {
      lines.push(`           · ${option.label} — gain: ${option.gain}; downside: ${option.downside}; affects: ${option.impact}; effort: ${option.effort ?? "not assessed"}`)
    }
    for (const unknown of b.decision.unknowns ?? []) lines.push(`           unknown: ${unknown}`)
    if (b.decision.alternativesNote) lines.push(`           alternatives: ${b.decision.alternativesNote}`)
  }
  return lines.join("\n")
}

function settingsLine(task: string, settings: BriefSettings): string {
  if (!settings.enabled) return `Briefs off for ${task}. Saved briefs are kept.`
  if (settings.activation === "active") return `Briefs on for ${task}.`
  return settings.turnRunning
    ? `Briefs on for ${task}. They start with the next turn; the running one began before briefs were on.`
    : `Briefs on for ${task}. They start with the next turn.`
}

/** `wisp brief …` after help and the bare-`set` usage were answered offline. */
export async function briefCommand(positional: string[], flags: Flags): Promise<void> {
  const sub = positional[0]
  try {
    if (sub === "set") return await setBrief(flags)
    if (sub === "show") {
      const task = taskArgument(positional)
      const view = await daemonRequest(`/api/tasks/${task}/brief`) as BriefView
      console.log(flags.json ? JSON.stringify(view, null, 2) : formatView(task, view))
      return
    }
    if (sub === "enable" || sub === "disable") {
      const task = taskArgument(positional)
      const settings = await daemonRequest(
        `/api/tasks/${task}/brief-settings`,
        "PUT",
        JSON.stringify({ enabled: sub === "enable" }),
      ) as BriefSettings
      console.log(flags.json ? JSON.stringify(settings, null, 2) : settingsLine(task, settings))
      return
    }
    throw new BriefUsageError(sub ? `unknown brief command: ${sub}` : "")
  } catch (error) {
    if (error instanceof BriefUsageError) {
      if (error.message) console.error(`error: ${error.message}`)
      console.error(briefUsage())
      process.exit(1)
    }
    exitApi(error)
  }
}
