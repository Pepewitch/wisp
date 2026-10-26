/*
 * A system turn's label, read from the facts the daemon stored with its input
 * (TurnSource), never from its text: a person who types "[Wisp auto-fix" is
 * still the person.
 */
import type { TurnSource } from "@/lib/types"

export interface SourceLabel {
  /** who wrote it: Wisp, or the harness by its product's name */
  who: string
  /** what it is, most general first: "auto-fix", "PR #12", "round 2 of 5" */
  parts: string[]
}

/** The built-in harnesses by the names their makers give them; any other harness keeps its id. */
const HARNESS_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
}

const AUTOPILOT_KINDS: Record<Extract<TurnSource, { by: "autopilot" }>["kind"], string[]> = {
  "auto-fix": ["auto-fix"],
  "auto-review": ["auto-review"],
  "review-nudge": ["auto-review", "verdict reminder"],
  "network-resume": ["autopilot", "resumed after the network dropped"],
}

export function harnessName(harness: string): string {
  return HARNESS_NAMES[harness] ?? harness
}

/** Null for a source this client does not know (a newer daemon's): that turn keeps the bubble rather than a guess. */
export function sourceLabel(source: TurnSource): SourceLabel | null {
  switch (source.by) {
    case "autopilot": {
      const round = source.round === null ? null : source.rounds === null ? `round ${source.round}` : `round ${source.round} of ${source.rounds}`
      return {
        who: "Wisp",
        parts: [...(AUTOPILOT_KINDS[source.kind] ?? [source.kind]), ...(source.pr === null ? [] : [`PR #${source.pr}`]), ...(round ? [round] : [])],
      }
    }
    case "workflow":
      return { who: "Wisp", parts: ["workflow", source.kind] }
    case "harness":
      return { who: harnessName(source.harness), parts: ["background update"] }
    default:
      return null
  }
}
