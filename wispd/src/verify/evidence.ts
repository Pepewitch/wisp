/**
 * The evidence floor a recipe can set: an area marked `evidence: screenshot`
 * needs reviewer A's pass to carry a capture Wisp took of that area, served
 * from the reviewer's own worktree. The requirement is fixed when the round is
 * planned, checked against Wisp's own capture records rather than the
 * reviewer's account, and waived only where Wisp recorded why it could not be
 * met. What a capture proves is that Wisp saw that page; whether the page
 * shows the change is still the reviewer's call.
 */
import type { CaptureRow } from "../capture/store"
import { docOrTest } from "./depth"
import type { RecipeArea } from "./recipe"

/**
 * Failures of the machine, not the app, the page or the caller: they excuse a
 * missing capture. No browser at all excuses every area; a busy or failing
 * browser only the area that attempt was for (a timeout, a missing element,
 * an error page or an oversized shot is the app's or the request's, never the
 * machine's, and a task's own concurrent capture is refused, not recorded).
 */
const MACHINE_WIDE = new Set(["no-chrome", "launch-failed"])
const MACHINE_FOR_AREA = new Set(["busy", "browser-error"])

export interface Waiver {
  area: string
  reason: string
}

/** The areas this diff touches that require a screenshot: changed files beyond docs and tests only. */
export function requiredAreas(areas: RecipeArea[], changed: string[] | null, docs: string[]): string[] {
  if (!changed) return []
  return areas
    .filter((area) => area.evidence === "screenshot")
    .filter((area) => {
      const globs = area.paths.map((path) => new Bun.Glob(path))
      return changed.some((file) => globs.some((glob) => glob.match(file)) && !docOrTest(file, docs))
    })
    .map((area) => area.name)
}

/** The shape of a verdict's `waivers`, or what is wrong with it. */
export function waiversError(raw: unknown): string | null {
  if (raw === undefined) return null
  if (!Array.isArray(raw) || raw.length > 10) return "waivers must be a list of up to 10 { area, reason }"
  for (const entry of raw) {
    const waiver = entry as Record<string, unknown>
    if (!waiver || typeof waiver !== "object" || Object.keys(waiver).some((key) => key !== "area" && key !== "reason")) return "each waiver is { area, reason }"
    if (typeof waiver.area !== "string" || waiver.area.length > 64) return "each waiver names its area"
    if (typeof waiver.reason !== "string" || waiver.reason.trim() === "" || waiver.reason.length > 500) return "each waiver says why, in up to 500 characters"
  }
  return null
}

/**
 * What a pass still lacks, or null: for each required area, an ok capture
 * tagged with it and served from the worktree, or a waiver Wisp can back (a
 * recorded machine failure, or a capture of that area served from elsewhere
 * or unknowably) together with at least one published image.
 */
export function evidenceShortfall(input: { required: string[]; captures: CaptureRow[]; waivers: Waiver[]; images: number }): string | null {
  const failed = input.captures.filter((capture) => capture.status === "failed")
  const machineWide = failed.some((capture) => MACHINE_WIDE.has(capture.reason ?? ""))
  for (const area of input.required) {
    const ofArea = input.captures.filter((capture) => capture.status === "ok" && capture.area === area)
    if (ofArea.some((capture) => capture.served_from === "worktree")) continue
    const waiver = input.waivers.find((entry) => entry.area === area)
    const machineHere = failed.some((capture) => MACHINE_FOR_AREA.has(capture.reason ?? "") && (capture.area === area || capture.area === null))
    const backed = machineWide || machineHere || ofArea.some((capture) => capture.served_from !== "worktree")
    if (waiver && backed && input.images > 0) continue
    if (waiver && !backed) {
      return `the waiver for area ${area} has nothing behind it: Wisp has no failed capture or off-worktree capture of it from this review. Run \`wisp capture <url> --area ${area}\` against the app you launched.`
    }
    if (waiver) return `the waiver for area ${area} needs at least one image you published (\`wisp output add\`)`
    return `area ${area} needs a screenshot of your running app: \`wisp capture http://127.0.0.1:$PORT/<page> --area ${area}\` (served from your worktree), or a waiver if Wisp could not capture it`
  }
  return null
}
