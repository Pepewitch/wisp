/**
 * A reviewer's verdict, read from the first line of a review body.
 *
 * GitHub cannot record an approval or a change request on your own pull
 * request, so the owner's reviewer agents post COMMENTED reviews that open with
 * a `Verdict:` line instead. The format drifts from run to run — bold, a
 * heading, `REQUEST_CHANGES`, `changes request` — so this normalises first and
 * FAILS CLOSED: a line that is shaped like a verdict but is not a clean
 * approval counts as blocking, never as silence.
 */
export type Verdict = "approve" | "blocking" | "unparseable"

const APPROVE = /^approved?\b/
const BLOCKING = /request(?:ed)?[\s_-]*changes?|changes?[\s_-]*request(?:ed)?|\bblock|\breject/

function normalise(line: string): string {
  return line.replace(/[*_#>`]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
}

function classify(text: string): Verdict {
  const value = normalise(text)
  if (APPROVE.test(value)) return "approve"
  if (BLOCKING.test(value)) return "blocking"
  return "unparseable"
}

/** null when the body carries no verdict at all: ordinary feedback, no signal. */
export function parseVerdict(body: string): Verdict | null {
  const lines = body.split(/\r?\n/).map((line) => line.trim())
  const first = lines.findIndex((line) => line !== "")
  if (first < 0) return null
  const opening = normalise(lines[first]!)
  const inline = opening.match(/^verdict\s*[:—–-]\s*(.+)$/)
  if (inline) return classify(inline[1]!)
  // `## Verdict`, `**Verdict**`, or `Verdict:` on its own: the verdict is the
  // next non-empty line, and it needs no prefix of its own.
  const heading = lines.findIndex((line) => /^verdict\s*:?$/.test(normalise(line)))
  if (heading >= 0) {
    const next = lines.slice(heading + 1).find((line) => line !== "")
    return next === undefined ? "unparseable" : classify(next)
  }
  return null
}
