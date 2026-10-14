/**
 * The engineering-review rubric every auto-review reviewer works from, in
 * Wisp's own words: what each lens checks, what blocks a merge and what is
 * only a note, and how much each review tier covers. A verification pass is
 * not "good to merge"; this is the other half.
 */
import type { ReviewTier } from "./depth"

export type ReviewLens = "correctness" | "architecture" | "slop" | "security" | "performance" | "tests" | "docs" | "verification"

export const LENSES: readonly { lens: ReviewLens; checks: string; blocks: string; notes: string }[] = [
  {
    lens: "correctness",
    checks: "the change does what it claims, including empty, error, concurrent and repeated cases it can reach",
    blocks: "wrong behaviour, an unhandled reachable error or edge case, data loss or corruption",
    notes: "an unlikely edge case worth a guard",
  },
  {
    lens: "architecture",
    checks: "the change follows the codebase's existing seams, layers and conventions",
    blocks: "a second mechanism beside an existing one, a layering the codebase forbids, a contract changed for one caller",
    notes: "naming, placement, a simpler shape",
  },
  {
    lens: "slop",
    checks: "the diff carries only what the change needs, written as the surrounding code is",
    blocks: "dead or unreachable code shipped, a duplicate of an existing helper, debug leftovers, a comment that contradicts the code",
    notes: "verbosity, a needless abstraction, comments that repeat the code",
  },
  {
    lens: "security",
    checks: "untrusted input, secrets, access and resource use",
    blocks: "untrusted input reaching a shell, SQL, a path or a prompt unchecked; a secret in code or logs; an auth or permission bypass; unbounded work from input",
    notes: "defence in depth worth adding",
  },
  {
    lens: "performance",
    checks: "hot paths only: loops, queries, renders and requests the change touches",
    blocks: "an obvious regression on a hot path (an N+1 query, a quadratic loop over user data, a render storm)",
    notes: "a cheap improvement",
  },
  {
    lens: "tests",
    checks: "tests in proportion to the risk, testing behaviour rather than implementation",
    blocks: "a behaviour change with no test where the codebase tests that kind of change; a tautological test that cannot fail",
    notes: "a gap worth one more case",
  },
  {
    lens: "docs",
    checks: "user-visible contracts (CLI, API, settings, docs pages) match the change",
    blocks: "a user-visible contract the docs now describe wrongly",
    notes: "wording",
  },
]

/** The verification lens, for the reviewer who runs the app. */
export const VERIFICATION_LENS = {
  lens: "verification" as const,
  checks: "every behaviour the change touches, observed working the way a user meets it",
  blocks: "a changed behaviour not observed working, or observed broken",
  notes: "a related behaviour worth a look",
}

export const TIER_COVERAGE: Record<ReviewTier, string> = {
  light: "Read the whole diff once with every lens, and check the one behaviour it changes. A small change still gets a real look.",
  standard: "Apply every lens to the changed code and to its direct callers and callees. Run the relevant tests.",
  deep: "Apply every lens to the changed code, its callers and callees, and how it fails: migration and rollback, concurrency, adversarial input, and what an older client or data sees. Run the relevant tests, and add your own checks where the risk is.",
}

/** What can block at all: the same for every reviewer, every tier and every reader of the rubric. */
export const SCOPE_RULES = "Only an issue this diff introduces or makes reachable can block. Style, naming and verbosity never block, nor do requests beyond the PR's goal. A blocker names its lens, a file and line for code, and what goes wrong and how it is reached."

/** The whole rubric for a person or an author agent: every lens, every tier, and the project's own rules. */
export function rubricText(projectRules: string | null): string {
  return [
    "Wisp's auto-review rubric",
    "",
    SCOPE_RULES,
    "",
    ...[...LENSES, VERIFICATION_LENS].flatMap((entry) => [`${entry.lens}: ${entry.checks}.`, `  blocks: ${entry.blocks}.`, `  notes: ${entry.notes}.`]),
    "",
    "Tiers (measured by Wisp from the diff; a floor, never a ceiling):",
    ...(Object.entries(TIER_COVERAGE) as [ReviewTier, string][]).map(([tier, coverage]) => `  ${tier}: ${coverage}`),
    ...(projectRules ? ["", "This project's own review rules:", projectRules] : []),
  ].join("\n")
}

/** The rubric as prompt lines, for one reviewer's role and the round's tier. */
export function rubricLines(input: { tier: ReviewTier; verifies: boolean; projectRules: string | null }): string[] {
  const lenses = input.verifies ? [...LENSES, VERIFICATION_LENS] : [...LENSES]
  return [
    `## How to review (tier: ${input.tier})`,
    TIER_COVERAGE[input.tier],
    "Wisp chose this tier from the diff's size, the paths it touches and the recipe areas it falls in. It is a floor, not a ceiling: go deeper wherever something warrants it. Do not ask anyone how deep to go, or anything else: decide, and say what you assumed as a note.",
    "",
    "Every finding names its lens and its severity. Blocking means it should not merge as it is; a note is worth fixing but does not stop the merge. Mark a finding blocking only when you can say what goes wrong.",
    SCOPE_RULES,
    ...lenses.map((entry) => `- ${entry.lens}: ${entry.checks}. Blocks: ${entry.blocks}. Notes: ${entry.notes}.`),
    ...(input.projectRules ? ["", "This project's own review rules (from its verification recipe):", input.projectRules] : []),
  ]
}
