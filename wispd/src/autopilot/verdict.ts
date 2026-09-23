/**
 * A reviewer's verdict, read from a `Verdict:` line in a review body.
 *
 * GitHub cannot record an approval or a change request on your own pull
 * request, so the owner's reviewer agents post COMMENTED reviews that carry a
 * `Verdict:` line instead. The format drifts from run to run — bold, a
 * heading, `REQUEST_CHANGES`, `changes request` — so this normalises first and
 * FAILS CLOSED:
 *
 * - any request for changes, or a rejection, anywhere in the verdict blocks,
 *   even after an approving word ("Approve with changes requested");
 * - an approval counts only when it is the WHOLE leading phrase: "APPROVE —
 *   no blocking findings" approves, "APPROVE after the blocking issue is
 *   fixed" does not;
 * - a verdict line that is neither is unreadable, which counts as blocking.
 */
export type Verdict = "approve" | "blocking" | "unparseable"

const REQUESTS_CHANGES = /request(?:ed|s)?[\s_-]*changes?|changes?[\s_-]*request(?:ed|s)?|\breject|\bdo not merge\b/
const LEAD_END = /\s[—–-]\s|[—–;,.(]/

function normalise(line: string): string {
  return line.replace(/[*_#>`]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
}

export function classifyVerdict(text: string): Verdict {
  const value = normalise(text)
  if (REQUESTS_CHANGES.test(value)) return "blocking"
  const lead = value.split(LEAD_END)[0]!.trim().replace(/!+$/, "")
  if (/^approved?$/.test(lead)) return "approve"
  if (/^(?:block(?:ed|ing|er)?|changes? (?:needed|required))$/.test(lead)) return "blocking"
  return "unparseable"
}

/** null when the body carries no verdict at all: ordinary feedback, no signal. */
export function parseVerdict(body: string): Verdict | null {
  const lines = body.split(/\r?\n/).map((line) => line.trim())
  for (let index = 0; index < lines.length; index++) {
    const line = normalise(lines[index]!)
    const inline = line.match(/^verdict\s*[:—–-]\s*(.+)$/)
    if (inline) return classifyVerdict(inline[1]!)
    // `## Verdict`, `**Verdict**`, or `Verdict:` on its own: the verdict is the
    // next non-empty line, and it needs no prefix of its own.
    if (/^verdict\s*:?$/.test(line)) {
      const next = lines.slice(index + 1).find((candidate) => candidate !== "")
      return next === undefined ? "unparseable" : classifyVerdict(next)
    }
  }
  return null
}
