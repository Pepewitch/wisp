/**
 * STOPGAP(1.0): rewrite or remove this before 1.0.
 *
 * It reads ONE reviewer bot's summary format as text. Wisp otherwise listens
 * only to signals GitHub defines: a red check, a review thread, a change
 * request, a `Verdict:` line. A bot's summary comment is read as a status
 * board unless the bot's own check is red. Some reviewers keep that check green
 * for findings they call acceptable (medium, low) and report them only in the
 * summary, so those findings never reached the agent.
 *
 * This file recognises exactly one shape: a heading that names the reviewed
 * head (`Summary for #<sha>`) and a markdown table of counts by severity
 * (`| 🟡 Medium | 1 |`). It is fitted to the reviewer the owner uses today and
 * reads no other bot's summary. Before 1.0, replace it with something general:
 * a judge that reads any bot's summary, a per-project list of reviewer bots,
 * or nothing at all if reviewers post their findings as review threads. Then
 * delete this file, its call in feedback.ts, and its tests.
 */

export type Severity = "critical" | "high" | "medium" | "low"

const ORDER: Severity[] = ["critical", "high", "medium", "low"]
/** Low findings ride along in a round when one is sent anyway, but never start one. */
const WORTH_A_ROUND: ReadonlySet<Severity> = new Set(["critical", "high", "medium"])
/** The overview sits at the top; the bounds keep a stranger-sized body cheap to read. */
const MAX_LINES = 200
const MAX_LINE = 500

export interface ReportedFindings {
  counts: Partial<Record<Severity, number>>
  /** how many are medium or worse: a round is sent only when this is above zero */
  worth: number
}

/**
 * The findings a summary reports for `head`, or null when it is not this
 * shape, names another head (it has not reviewed this push yet), or reports
 * no count. A token walk, never a backtracking pattern.
 */
export function reportedFindings(body: string, head: string): ReportedFindings | null {
  let reviewsHead = false
  let fenced = false
  const counts: Partial<Record<Severity, number>> = {}
  for (const raw of body.split(/\r?\n/, MAX_LINES)) {
    const line = raw.trim()
    if (line.length > MAX_LINE) continue
    if (line.startsWith("```") || line.startsWith("~~~")) { fenced = !fenced; continue }
    if (fenced) continue
    // the findings themselves follow; only the overview's table is a count
    if (line.startsWith("<details")) break
    if (line.startsWith("#")) {
      const sha = namedHead(line)
      if (sha) reviewsHead = head.toLowerCase().startsWith(sha)
      continue
    }
    if (line.startsWith("|")) {
      const [, label = "", count = ""] = line.split("|").map((cell) => cell.trim())
      const severity = severityOf(label)
      if (severity && /^\d{1,4}$/.test(count)) counts[severity] = (counts[severity] ?? 0) + Number(count)
    }
  }
  if (!reviewsHead || Object.keys(counts).length === 0) return null
  const worth = ORDER.filter((severity) => WORTH_A_ROUND.has(severity)).reduce((sum, severity) => sum + (counts[severity] ?? 0), 0)
  return { counts, worth }
}

/** `## reviewer Summary for #1a2b3c4` → `1a2b3c4`. */
function namedHead(heading: string): string | null {
  const words = heading.toLowerCase().split(/\s+/)
  for (let index = 0; index + 2 < words.length; index++) {
    if (words[index] !== "summary" || words[index + 1] !== "for") continue
    const sha = words[index + 2]!.replace(/^#/, "")
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null
  }
  return null
}

/** `🟡 Medium`, `**High**` → the severity; any other first cell → null. */
function severityOf(label: string): Severity | null {
  const word = label.split(/\s+/).at(-1)?.replace(/[^a-z]/gi, "").toLowerCase() ?? ""
  return (ORDER as string[]).includes(word) ? word as Severity : null
}

/** `1 medium, 2 low findings`, most severe first. */
export function findingsWords(findings: ReportedFindings): string {
  const total = ORDER.reduce((sum, severity) => sum + (findings.counts[severity] ?? 0), 0)
  const parts = ORDER.filter((severity) => findings.counts[severity]).map((severity) => `${findings.counts[severity]} ${severity}`)
  return `${parts.join(", ")} finding${total === 1 ? "" : "s"}`
}
