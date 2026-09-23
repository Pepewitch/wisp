/**
 * One classification of a pull request's checks, shared by every autopilot
 * decision. It deliberately differs from the PR status line's older mapping:
 * that one only colours an icon, this one decides whether Wisp merges.
 */
export type CheckClass = "pass" | "fix" | "hold" | "pending"

export interface PrCheck {
  name: string
  /** CheckRun conclusion or status, or a StatusContext state, upper-cased */
  status: string
  conclusion: string | null
  required: boolean
  url: string
  /** a check run's id — for GitHub Actions it is also the job id (logs, rerun) */
  checkRunId?: number
  /** the Actions workflow run it belongs to, when it is one */
  run?: { id: number; event: string }
  /** a deployment job: never rerun behind anyone's back */
  deployment?: boolean
  /** the GitHub App that reported it: pairs a bot's sticky comment with its verdict */
  app?: string
}

const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"])
/** a real failure the code can fix */
const FIX = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ERROR"])
/** not a result: a rerun or a person has to act before it means anything */
const HOLD = new Set(["CANCELLED", "STALE", "ACTION_REQUIRED"])

export function classifyCheck(check: PrCheck): CheckClass {
  const conclusion = check.conclusion?.toUpperCase() ?? null
  if (conclusion !== null && conclusion !== "") {
    if (PASS.has(conclusion)) return "pass"
    if (FIX.has(conclusion)) return "fix"
    if (HOLD.has(conclusion)) return "hold"
    return "hold"
  }
  // A commit status carries its outcome in `status`; a check run that has not
  // concluded is pending — unless it is WAITING on an environment's reviewers,
  // which never ends on its own.
  const status = check.status.toUpperCase()
  if (PASS.has(status)) return "pass"
  if (FIX.has(status)) return "fix"
  if (status === "WAITING") return "hold"
  return "pending"
}

/**
 * The checks that decide. With required checks configured, GitHub decides and
 * only those count. With none, every check counts: Wisp reads the absence of
 * rules strictly rather than inventing a required set of its own.
 */
export function countingChecks(checks: PrCheck[], requiredNames: ReadonlySet<string>): PrCheck[] {
  if (requiredNames.size === 0) return checks
  return checks.filter((check) => check.required || requiredNames.has(check.name))
}

/** Required contexts the base branch names that have not reported on this head yet. */
export function missingRequired(checks: PrCheck[], requiredNames: ReadonlySet<string>): string[] {
  const seen = new Set(checks.map((check) => check.name))
  return [...requiredNames].filter((name) => !seen.has(name)).sort()
}
