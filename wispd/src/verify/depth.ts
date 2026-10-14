/**
 * How deep a PR's review goes, decided by Wisp from the diff rather than asked
 * of anyone. Measuring a change is mechanical, so it is code; judging it is
 * the reviewer's. The tier is a floor: a reviewer goes deeper when something
 * warrants it, never shallower, and never asks.
 */
import { runBounded, READ_TIMEOUT_MS } from "../subprocess"

export type ReviewTier = "light" | "standard" | "deep"

export interface DiffSignals {
  /** lines added plus removed, lockfiles and generated files left out; binary files count as one each */
  lines: number
  files: number
  /** recipe areas the changed files fall in */
  areas: number
  /** changed files no recipe area covers */
  unmapped: number
  /** the project's recipe maps areas at all: zero matched areas then means "outside every area", not "no areas" */
  mapped?: boolean
  /** changed files on a sensitive path (migrations, auth, CI…), up to a few for the prompt */
  sensitive: string[]
  testsTouched: boolean
  /** every changed file is documentation */
  docsOnly: boolean
}

/**
 * Paths whose changes always get a deep review: data, access, delivery,
 * dependencies, and the instructions agents themselves read. Filename globs,
 * so `wispd/src/migration-auto-review.ts` counts as a migration.
 */
export const SENSITIVE_GLOBS = [
  "**/migrations/**", "**/*migration*", "**/*.sql",
  "**/auth/**", "**/*auth*", "**/security/**", "**/*crypto*", "**/*secret*", "**/*token*", "**/*permission*",
  ".github/workflows/**", "**/.gitlab-ci.yml", "**/Dockerfile", "**/docker-compose*.yml",
  "**/package.json", "**/Cargo.toml", "**/go.mod", "**/requirements*.txt", "**/pyproject.toml", "**/Gemfile",
  "**/terraform/**", "**/*.tf", "**/infra/**",
  "**/AGENTS.md", "**/CLAUDE.md", ".cursor/**", "**/SKILL.md", ".claude/**",
] as const

/** Lockfiles: a dependency bump's real signal is its manifest; their lines are not counted. */
const LOCKFILES = [
  "**/package-lock.json", "**/bun.lock", "**/bun.lockb", "**/yarn.lock", "**/pnpm-lock.yaml",
  "**/Cargo.lock", "**/go.sum", "**/poetry.lock", "**/Gemfile.lock", "**/composer.lock",
]

/** Documentation by place, not by extension: markdown is the product in some repositories (prompts, skills). */
const DOC_GLOBS = ["docs/**", "*.md"]
const TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z0-9]+$/i

export const LIGHT_MAX_LINES = 40
export const LIGHT_MAX_FILES = 3
export const DEEP_MIN_LINES = 600
export const DEEP_MIN_FILES = 25
export const DEEP_MIN_AREAS = 3

const globsOf = (patterns: readonly string[]) => patterns.map((glob) => new Bun.Glob(glob))
const matches = (globs: Bun.Glob[], path: string) => globs.some((glob) => glob.match(path))

/** One changed file from `--numstat`; a rename also keeps the path it came from. */
export interface NumstatEntry { path: string; added: number | null; removed: number | null; from?: string }

export interface SignalOptions {
  /** recipe areas the changed files fall in, and how many files fall in none */
  areas: number
  unmapped?: number
  /** the recipe maps areas (see DiffSignals.mapped) */
  mapped?: boolean
  /** the project's own globs (recipe frontmatter `sensitive:` and `docs:`) */
  sensitive?: string[]
  docs?: string[]
  /** linguist-generated paths (.gitattributes): their lines are not counted */
  generated?: string[]
}

/** The signals from one diff's numstat and the areas matched. */
export function signalsOf(numstat: NumstatEntry[], options: SignalOptions): DiffSignals {
  const sensitiveGlobs = globsOf([...SENSITIVE_GLOBS, ...(options.sensitive ?? [])])
  const uncounted = globsOf([...LOCKFILES, ...(options.generated ?? [])])
  const docGlobs = globsOf([...DOC_GLOBS, ...(options.docs ?? [])])
  // a rename is judged by both of its names: moving a migration out of its directory is still a migration change
  const sensitive = numstat.flatMap((entry) => (entry.from ? [entry.from, entry.path] : [entry.path])).filter((path) => matches(sensitiveGlobs, path))
  return {
    lines: numstat.reduce((sum, entry) => {
      if (matches(uncounted, entry.path)) return sum
      return sum + (entry.added === null || entry.removed === null ? 1 : entry.added + entry.removed)
    }, 0),
    files: numstat.length,
    areas: options.areas,
    unmapped: options.unmapped ?? 0,
    mapped: options.mapped ?? false,
    sensitive: sensitive.slice(0, 5),
    testsTouched: numstat.some((entry) => TEST.test(entry.path)),
    docsOnly: numstat.length > 0 && numstat.every((entry) => matches(docGlobs, entry.path)),
  }
}

const TIER_RANK: Record<ReviewTier, number> = { light: 0, standard: 1, deep: 2 }

/** The higher of two tiers: within one PR a tier only goes up. */
export const maxTier = (a: ReviewTier, b: ReviewTier | null | undefined): ReviewTier => (b && TIER_RANK[b] > TIER_RANK[a] ? b : a)

/**
 * The tier for a set of signals. Deep wins over everything; light needs
 * positive evidence of low risk; signals Wisp could not read are deep, since
 * nothing about them can be shown to be safe.
 */
export function tierOf(signals: DiffSignals | null): ReviewTier {
  if (!signals) return "deep"
  if (signals.sensitive.length > 0 || signals.lines > DEEP_MIN_LINES || signals.files > DEEP_MIN_FILES || signals.areas >= DEEP_MIN_AREAS) return "deep"
  if (signals.docsOnly) return "light"
  const small = signals.lines <= LIGHT_MAX_LINES && signals.files <= LIGHT_MAX_FILES && signals.areas <= 1
  // a small change inside one area, or anywhere in a project without areas; a
  // file outside every area of a mapped project may be shared code, so it is not light
  return small && (signals.unmapped === 0 || !signals.mapped) ? "light" : "standard"
}

/** `git diff --numstat` of a PR head against its base, three-dot; null when git cannot compute it. */
export async function numstatOf(repoPath: string, base: string, head: string): Promise<NumstatEntry[] | null> {
  if (base.startsWith("-") || head.startsWith("-")) return null
  for (const ref of [`origin/${base}`, base]) {
    const result = await runBounded({
      cmd: ["git", "diff", "--numstat", "-z", "--end-of-options", `${ref}...${head}`],
      cwd: repoPath, env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: READ_TIMEOUT_MS, maxBytes: 2 * 1024 * 1024,
    }).catch(() => null)
    if (!result || result.exitCode !== 0) continue
    return parseNumstat(result.out)
  }
  return null
}

/**
 * `--numstat -z` output: "added\tremoved\tpath\0" per file, and for a rename
 * "added\tremoved\t\0from\0to\0". Binary files report "-" for both counts.
 */
export function parseNumstat(out: string): NumstatEntry[] {
  const parts = out.split("\u0000")
  const entries: NumstatEntry[] = []
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i]!
    if (head === "") continue
    const [added = "", removed = "", path = ""] = head.split("\t")
    const count = (value: string): number | null => (value === "-" ? null : Number.parseInt(value, 10))
    // a rename: the path is empty here, and the next two parts are from and to
    if (path !== "") { entries.push({ path, added: count(added), removed: count(removed) }); continue }
    const from = parts[i + 1] ?? "", to = parts[i + 2] ?? ""
    i += 2
    if (to !== "") entries.push({ path: to, added: count(added), removed: count(removed), ...(from ? { from } : {}) })
  }
  return entries
}
