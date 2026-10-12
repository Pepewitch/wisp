/**
 * `wisp review show|submit`: auto-review rounds, and the reviewer's verdict.
 *
 * `submit` is what a reviewer agent runs, so every answer is one short line,
 * and a mistake in its JSON names the field so it can fix it once.
 */
import type { AutoReviewRound, AutoReviewRoundsResponse } from "../../shared/api/auto-review"
import type { Flags } from "./cli-args"
import { api, CliApiError, daemonRequest, exitApi } from "./cli-api"
import { boundedStdin } from "./cli-brief"
import { print, printError, printJson } from "./cli-print"
import { wispCommand } from "./command"
import { controlFree } from "./control-free"
import { REVIEW_SUBMIT_HELP } from "./cli-review-help"
import { REVIEW_TOKEN_ENV } from "./turn-input"

const COMMAND = wispCommand()

export const REVIEW_USAGE = `usage: ${COMMAND} review show <task> [--round <n>] [--json] | ${COMMAND} review submit --stdin`


const STDIN_LIMIT_BYTES = 64 * 1024
const STDIN_IDLE_MS = 10_000

function say(line: string, code: 0 | 1 | 2): never {
  if (code === 0) print(line)
  else printError(line)
  process.exit(code)
}

const oneLine = (text: string, max: number): string => {
  const flat = controlFree(text).replace(/\s+/g, " ").trim()
  return [...flat].length > max ? `${[...flat].slice(0, max).join("")}…` : flat
}

export function formatRound(round: AutoReviewRound, full: boolean): string {
  const head = `round ${round.round}${round.counted ? "" : " (re-run)"} · PR #${round.pr} · ${round.head.slice(0, 7)} · ${round.state}`
  const lines = [head]
  if (round.summary) lines.push(`  ${full ? controlFree(round.summary) : oneLine(round.summary, 160)}`)
  if (full) {
    for (const [index, finding] of round.findings.entries()) {
      lines.push(`  ${index + 1}. ${oneLine(finding.title, 200)}${finding.file ? ` (${controlFree(finding.file)}${finding.line ? `:${finding.line}` : ""})` : ""}`)
      if (finding.detail) lines.push(...controlFree(finding.detail).split("\n").map((line) => `     ${line}`))
    }
    if (round.recipeFeedback) lines.push(`  recipe${round.recipeArea ? ` (${round.recipeArea})` : ""}: ${controlFree(round.recipeFeedback)}`)
    if (round.evidence.length > 0) lines.push(`  evidence: ${round.evidence.map((image) => `${controlFree(image.name)} (turn ${image.turn})`).join(", ")}`)
    if (round.reviewerTaskId) lines.push(`  reviewer task: ${round.reviewerTaskId}${round.recipeVersion ? ` · recipe ${round.recipeVersion}` : ""}`)
  } else if (round.findings.length > 0) {
    lines.push(`  ${round.findings.length} finding${round.findings.length === 1 ? "" : "s"}`)
  }
  return lines.join("\n")
}

async function show(positional: string[], flags: Flags): Promise<void> {
  const task = positional[1] ?? process.env.WISP_TASK_ID
  if (!task) say(REVIEW_USAGE, 2)
  const { rounds } = await api(`/api/tasks/${encodeURIComponent(task)}/auto-review`) as AutoReviewRoundsResponse
  const number = typeof flags.round === "string" ? Number(flags.round) : null
  if (number !== null && (!Number.isSafeInteger(number) || number < 1)) say("--round takes a round number, e.g. --round 2", 2)
  const picked = number === null ? rounds : rounds.filter((round) => round.round === number).slice(0, 1)
  if (flags.json) { printJson(number === null ? rounds : picked[0] ?? null); return }
  if (picked.length === 0) { print(number === null ? "no auto-review rounds for this task" : `no round ${number} for this task`); return }
  print(picked.map((round) => formatRound(round, number !== null)).join("\n"))
}

async function submit(flags: Flags): Promise<never> {
  if (flags.stdin !== true || process.stdin.isTTY) say(`${REVIEW_USAGE}\n\n${REVIEW_SUBMIT_HELP}`, 2)
  const task = process.env.WISP_TASK_ID ?? ""
  const token = process.env[REVIEW_TOKEN_ENV] ?? ""
  if (!/^[a-z0-9]+$/.test(task) || token === "") say("Verdict not sent: this turn is not an auto-review reviewer's (no review token).", 1)
  const bytes = await boundedStdin(STDIN_LIMIT_BYTES, STDIN_IDLE_MS)
  if (bytes === "idle") say("Verdict not sent: no JSON arrived on stdin.", 2)
  if (bytes === null) say(`Verdict not sent: stdin is over ${STDIN_LIMIT_BYTES} bytes. Shorten it and submit once more.`, 1)
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch {
    say("Verdict not sent: stdin is not valid JSON.", 1)
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) say("Verdict not sent: stdin must be one JSON object.", 1)
  try {
    const round = await daemonRequest(`/api/tasks/${task}/auto-review/verdict`, "POST", JSON.stringify({ ...payload as object, token })) as AutoReviewRound
    say(`Verdict recorded: round ${round.round} ${round.state}, ${round.evidence.length} image${round.evidence.length === 1 ? "" : "s"} attached. End your turn now.`, 0)
  } catch (error) {
    if (error instanceof CliApiError && error.status === 400) say(`Verdict not sent: ${error.message}. See \`${COMMAND} review submit --help\`, fix it, and submit once more.`, 1)
    if (error instanceof CliApiError && error.status === 409) say(`Verdict not recorded: ${error.message}. Stop here.`, 0)
    exitApi(error)
  }
}

export async function reviewCommand(positional: string[], flags: Flags): Promise<void> {
  const [verb] = positional
  if (verb === "show") return show(positional, flags)
  if (verb === "submit") return submit(flags)
  say(REVIEW_USAGE, 2)
}
