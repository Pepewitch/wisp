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
 * - an approval counts only when it is the WHOLE leading phrase and nothing
 *   after it walks it back: "APPROVE — no blocking findings" approves;
 *   "APPROVE after the blocking issue is fixed", "APPROVE, but fix the race
 *   first", and "Approve (not safe to merge until #3)" do not;
 * - a verdict line that is neither is unreadable, which counts as blocking;
 * - quoted lines (`> Verdict: …`, an earlier round) are not this review's
 *   verdict, and when a body has several verdicts the least approving wins.
 */
export type Verdict = "approve" | "blocking" | "unparseable"

const REQUESTS_CHANGES = /request(?:ed|s)?[\s_-]*changes?|changes?[\s_-]*request(?:ed|s)?|\breject|\bdo not merge\b/
const LEAD_END = /\s[—–-]\s|[—–;,.(]/
/** Words that make an "approve" conditional. "no blocking findings" is the owner's own phrasing and stays an approval. */
const WALKED_BACK = /\bbut\b|\bhowever\b|\buntil\b|\bunless\b|\bonce\b|\bafter\b|\bmust\b|\bnot safe\b|\bblocker|(?<!\bno )\bblocking\b|\bbefore merg/

function normalise(line: string): string {
  return line.replace(/[*_#>`]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
}

export function classifyVerdict(text: string): Verdict {
  const value = normalise(text)
  if (REQUESTS_CHANGES.test(value)) return "blocking"
  const lead = value.split(LEAD_END)[0]!.trim().replace(/!+$/, "")
  if (/^approved?$/.test(lead)) return WALKED_BACK.test(value.slice(value.indexOf(lead) + lead.length)) ? "unparseable" : "approve"
  if (/^(?:block(?:ed|ing|er)?|changes? (?:needed|required))$/.test(lead)) return "blocking"
  return "unparseable"
}

/** null when the body carries no verdict at all: ordinary feedback, no signal. */
export function parseVerdict(body: string): Verdict | null {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => !line.startsWith(">"))
  const found: Verdict[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = normalise(lines[index]!)
    const inline = line.match(/^verdict\s*[:—–-]\s*(.+)$/)
    if (inline) { found.push(classifyVerdict(inline[1]!)); continue }
    // `## Verdict`, `**Verdict**`, or `Verdict:` on its own: the verdict is the
    // next non-empty line, and it needs no prefix of its own.
    if (/^verdict\s*:?$/.test(line)) {
      const next = lines.slice(index + 1).find((candidate) => candidate !== "")
      found.push(next === undefined ? "unparseable" : classifyVerdict(next))
    }
  }
  if (found.length === 0) return null
  if (found.includes("blocking")) return "blocking"
  return found.includes("unparseable") ? "unparseable" : "approve"
}
