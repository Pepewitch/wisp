/*
 * A subtask report turn's prompt, read back for the transcript. Wisp wrote
 * it (subtask-delivery.ts, from subtask-reports.ts reportFraming): its own
 * fact lines, then each child's words between `<<<report-ID>>>` and
 * `<<<end-ID>>>` fences named by the message id. The fences are for the
 * parent agent; a person reads the facts, then each child's words quoted.
 */

export interface ReportQuote {
  /** "report 1, from subtask tb9t8p" */
  label: string
  body: string
}

export interface ReportText {
  /** Wisp's lines: which subtask did what, and how to read more */
  facts: string[]
  /** the children's own words, in order */
  quotes: ReportQuote[]
}

const OPEN = /^<<<report-([A-Za-z0-9_-]+)>>>\s*(.*)$/
// the agent's reading guide names the fences, which a person has no use for
const GUIDE = /^\d+ reports? from your subtasks\. /

export function parseReportText(text: string): ReportText {
  const facts: string[] = []
  const quotes: ReportQuote[] = []
  const lines = text.split("\n")
  for (let at = 0; at < lines.length; at += 1) {
    const open = OPEN.exec(lines[at]!)
    if (!open) {
      const line = lines[at]!.trim()
      if (line && !GUIDE.test(line)) facts.push(line)
      continue
    }
    // only this message's own closing fence ends a quote; the daemon strips it from the words
    const end = `<<<end-${open[1]}>>>`
    const body: string[] = []
    for (at += 1; at < lines.length && lines[at] !== end; at += 1) body.push(lines[at]!)
    quotes.push({ label: open[2]!, body: body.join("\n").trim() })
  }
  return { facts, quotes }
}
