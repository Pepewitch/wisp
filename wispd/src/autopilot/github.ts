/**
 * Everything autopilot asks GitHub, behind one small interface so the
 * decision code can be tested against fixtures. Reads go through the daemon
 * host's authenticated `gh`; the only write is `gh pr merge`, which respects
 * every branch protection, ruleset, and merge queue the repository has.
 */
import { controlFree } from "../control-free"
import { ghReply, githubBudget, MERGE_POINTS, unlessPaused, type GitHubBudget, type GitHubResource } from "../github-budget"
import { runBounded, type RunOptions, type RunResult } from "../subprocess"
import { isRecord } from "../validate"
import type { PrCheck } from "./checks"

export type MergeMethod = "SQUASH" | "MERGE" | "REBASE"

export interface PrReview {
  /** node id */
  id: string
  author: string | null
  association: string
  bot: boolean
  state: string
  body: string
  /** the head this review was written against */
  commit: string | null
  submittedAt: string
  editedAt: string | null
  url: string
}

/** A conversation comment, or one comment in a review thread. */
export interface PrComment {
  /** node id */
  id: string
  author: string | null
  association: string
  bot: boolean
  body: string
  createdAt: string
  editedAt: string | null
  url: string
  /** a draft in a review not submitted yet, or hidden by a maintainer: never feedback */
  hidden: boolean
}

export interface PrThread {
  /** node id: what `resolveReviewThread` and a reply take */
  id: string
  resolved: boolean
  outdated: boolean
  path: string
  line: number | null
  /** who started the thread: the owner or a bot may have it resolved for them */
  starter: { author: string | null; bot: boolean; body: string } | null
  /** the newest comments, oldest first */
  comments: PrComment[]
}

export interface PrSnapshot {
  number: number
  url: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  isCrossRepository: boolean
  head: string
  /** when the head commit was made: with its first sighting, what a comment "about this head" must follow */
  headCommittedAt?: string | null
  headRefName: string
  baseRefName: string
  defaultBranch: string
  mergeState: string
  reviewDecision: string | null
  queued: boolean
  providerAutoMerge: boolean
  mergedBy: string | null
  viewer: string
  checks: PrCheck[]
  /** GitHub Actions check suites on the head that have not completed */
  actionsSuitesPending: number
  /** of those, the ones held for a person (an environment's required reviewers) */
  actionsSuitesWaiting: number
  /** the newest 100 reviews, oldest first */
  reviews: PrReview[]
  /** more than 100 reviews exist: an older block may be out of sight, so the merge gate refuses to decide */
  reviewsTruncated?: boolean
  threads: PrThread[]
  /** more than 100 review threads exist: auto-fix read the newest 100 */
  threadsTruncated: boolean
  /**
   * Whether the base branch requires every conversation resolved before a
   * merge (classic protection or a ruleset). Classic protection is readable
   * only by an admin; for anyone else it is "unknown" unless a ruleset says
   * so, and GitHub's own BLOCKED state then decides.
   */
  conversationRule: "required" | "not-required" | "unknown"
  /** the newest conversation comments, oldest first */
  comments: PrComment[]
  unresolvedThreads: number
  mergeMethod: MergeMethod
  /** the base branch's head, and its checks: a red that is red there too is not this PR's to fix */
  baseHead: string | null
  baseChecks: PrCheck[]
}

/** What the base branch's protection says, as far as a non-admin can read it. */
export interface BaseRules {
  /** required status check contexts, from classic protection and rulesets */
  checks: string[]
  /** whether the branch has classic protection at all; null when unreadable */
  classicProtection: boolean | null
}

export interface OpenPullRequest {
  number: number
  headRefName: string
  baseRefName: string
  createdAt: string
  isCrossRepository: boolean
  author: string | null
}

export interface AutopilotGitHub {
  snapshot(repository: string, number: number, cwd: string, signal: AbortSignal): Promise<PrSnapshot>
  /** Several PRs of one repository in one request (batch.ts): the ones that could be read. */
  snapshots?(repository: string, numbers: number[], cwd: string, signal: AbortSignal): Promise<Map<number, PrSnapshot>>
  openPullRequests(repository: string, branches: string[], cwd: string, signal: AbortSignal): Promise<{ defaultBranch: string; viewer: string; pulls: OpenPullRequest[] }>
  /** Context names the base branch requires, from classic protection and rulesets. */
  requiredChecks(repository: string, base: string, cwd: string, signal: AbortSignal): Promise<BaseRules>
  merge(input: { repository: string; number: number; method: MergeMethod; head: string }, cwd: string, signal: AbortSignal): Promise<{ ok: boolean; detail: string }>
  /** Rerun a workflow run's failed and cancelled jobs (and their dependents); costs no agent tokens. */
  rerunRun(repository: string, runId: number, cwd: string, signal: AbortSignal): Promise<boolean>
  /** The END of an Actions job's log (the start is setup noise), bounded. */
  jobLogTail(repository: string, jobId: number, cwd: string, signal: AbortSignal): Promise<string>
  /** A non-Actions check run's own report: title, summary, text, annotations. */
  checkRunReport(repository: string, checkRunId: number, cwd: string, signal: AbortSignal): Promise<string>
  /** Whether a login may push to the repository (write, maintain or admin): whose review may instruct the agent. */
  canPush(repository: string, login: string, cwd: string, signal: AbortSignal): Promise<boolean>
}

const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1" }

/** How a gh command runs: `runBounded`, or a fake GitHub in tests. */
export type GhRun = (options: RunOptions) => Promise<RunResult>

function split(repository: string): [string, string] {
  const [owner, name] = repository.split("/")
  if (!owner || !name) throw new Error(`not a GitHub repository: ${repository}`)
  return [owner, name]
}

const str = (value: unknown): string => (typeof value === "string" ? value : "")

/** Costs nothing, and says what the query cost and what is left of the hour (github-budget.ts). */
const RATE_LIMIT = "rateLimit { cost remaining limit resetAt }"
const REPOSITORY_FIELDS = "defaultBranchRef { name } squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed viewerDefaultMergeMethod"

/** One PR's part of a snapshot; `number` is what `isRequired` asks about: the variable, or a literal in a batch. */
const pullRequestFields = (number: string): string => `
      number url state isDraft isCrossRepository
      mergedBy { login }
      headRefOid headRefName baseRefName
      mergeStateStatus reviewDecision
      mergeQueueEntry { id }
      autoMergeRequest { enabledAt }
      reviewThreads(last: 100) { pageInfo { hasPreviousPage } nodes {
        id isResolved isOutdated path line originalLine
        starter: comments(first: 1) { nodes { author { login __typename } body } }
        recent: comments(last: 30) { nodes { ...comment } }
      } }
      reviews(last: 100) { pageInfo { hasPreviousPage } nodes { id state body submittedAt lastEditedAt url authorAssociation author { login __typename } commit { oid } } }
      comments(last: 100) { nodes { ...comment } }
      commits(last: 1) { nodes { commit { oid committedDate
        checkSuites(first: 100) { pageInfo { hasNextPage } nodes { status workflowRun { databaseId } } }
        statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage } nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl databaseId isRequired(pullRequestNumber: ${number})
            deployment { id } checkSuite { app { slug } workflowRun { databaseId event } } }
          ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: ${number}) }
        } } }
      } } }
      baseRef {
        branchProtectionRule { requiresConversationResolution }
        rules(first: 50) { nodes { type parameters { ... on PullRequestParameters { requiredReviewThreadResolution } } } }
        target { ... on Commit { oid statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state }
        } } } } }
      }`

const COMMENT_FRAGMENT = `
fragment comment on Comment {
  id body createdAt lastEditedAt authorAssociation author { login __typename }
  ... on IssueComment { url isMinimized }
  ... on PullRequestReviewComment { url isMinimized state }
}`

export const SNAPSHOT = `
query($owner: String!, $name: String!, $number: Int!) {
  ${RATE_LIMIT}
  viewer { login }
  repository(owner: $owner, name: $name) {
    ${REPOSITORY_FIELDS}
    pullRequest(number: $number) {${pullRequestFields("$number")}
    }
  }
}${COMMENT_FRAGMENT}`

/** What a snapshot costs: GitHub charged 2 points for it on a real PR (`rateLimit(dryRun: true)`). */
const SNAPSHOT_POINTS = 2
/** PRs per batched request: each is ~3,700 nodes, and a busy PR's answer can run to megabytes. */
export const SNAPSHOT_BATCH = 5

/**
 * Several PRs of one repository in one request, as aliases `p0`, `p1`, ….
 * GraphQL prices each PR's part as it would alone, so this saves requests
 * and gh processes rather than points.
 */
export function snapshotsQuery(numbers: number[]): string {
  const pulls = numbers.map((number, index) => `
    p${index}: pullRequest(number: ${Math.trunc(number)}) {${pullRequestFields(String(Math.trunc(number)))}
    }`).join("")
  return `
query($owner: String!, $name: String!) {
  ${RATE_LIMIT}
  viewer { login }
  repository(owner: $owner, name: $name) {
    ${REPOSITORY_FIELDS}${pulls}
  }
}${COMMENT_FRAGMENT}`
}

function nodes(value: unknown): Record<string, unknown>[] {
  return isRecord(value) && Array.isArray(value.nodes) ? value.nodes.filter(isRecord) : []
}

function parseCheck(node: Record<string, unknown>): PrCheck {
  if (node.__typename === "StatusContext") {
    return { name: str(node.context), status: str(node.state), conclusion: null, required: node.isRequired === true, url: str(node.targetUrl) }
  }
  const suite = isRecord(node.checkSuite) ? node.checkSuite : null
  const run = suite && isRecord(suite.workflowRun) ? suite.workflowRun : null
  const app = suite && isRecord(suite.app) ? str(suite.app.slug) : ""
  return {
    name: str(node.name), status: str(node.status), conclusion: typeof node.conclusion === "string" ? node.conclusion : null,
    required: node.isRequired === true, url: str(node.detailsUrl),
    ...(typeof node.databaseId === "number" ? { checkRunId: node.databaseId } : {}),
    ...(run && typeof run.databaseId === "number" ? { run: { id: run.databaseId, event: str(run.event) } } : {}),
    ...(app ? { app } : {}),
    deployment: isRecord(node.deployment),
  }
}

/** Who wrote something: the login GraphQL gives a bot is its app's slug, without `[bot]`. */
function authorOf(node: Record<string, unknown>) {
  const author = isRecord(node.author) ? node.author : null
  return {
    author: author ? str(author.login).replace(/\[bot\]$/, "") || null : null,
    association: str(node.authorAssociation),
    bot: author?.__typename === "Bot",
  }
}

const editedAt = (node: Record<string, unknown>): string | null => (typeof node.lastEditedAt === "string" ? node.lastEditedAt : null)

function parseReview(node: Record<string, unknown>): PrReview {
  return {
    id: str(node.id),
    ...authorOf(node),
    state: str(node.state),
    body: str(node.body),
    commit: isRecord(node.commit) ? str(node.commit.oid) || null : null,
    submittedAt: str(node.submittedAt),
    editedAt: editedAt(node),
    url: str(node.url),
  }
}

function parseComment(node: Record<string, unknown>): PrComment {
  return {
    id: str(node.id), ...authorOf(node), body: str(node.body), createdAt: str(node.createdAt), editedAt: editedAt(node), url: str(node.url),
    hidden: node.isMinimized === true || node.state === "PENDING",
  }
}

function parseThread(node: Record<string, unknown>): PrThread {
  const line = typeof node.line === "number" ? node.line : typeof node.originalLine === "number" ? node.originalLine : null
  return {
    id: str(node.id), resolved: node.isResolved === true, outdated: node.isOutdated === true, path: str(node.path), line,
    starter: nodes(node.starter).map((first) => ({ author: authorOf(first).author, bot: authorOf(first).bot, body: str(first.body) }))[0] ?? null,
    comments: nodes(node.recent).map(parseComment),
  }
}

/** The PR's own scalar fields, read defensively. */
function prFields(pr: Record<string, unknown>, repo: Record<string, unknown>, data: Record<string, unknown>) {
  const state = str(pr.state)
  return {
    number: Number(pr.number),
    url: str(pr.url),
    state: state === "MERGED" || state === "CLOSED" ? state : "OPEN" as PrSnapshot["state"],
    isDraft: pr.isDraft === true,
    isCrossRepository: pr.isCrossRepository === true,
    headRefName: str(pr.headRefName),
    baseRefName: str(pr.baseRefName),
    defaultBranch: isRecord(repo.defaultBranchRef) ? str(repo.defaultBranchRef.name) : "",
    mergeState: str(pr.mergeStateStatus) || "UNKNOWN",
    reviewDecision: typeof pr.reviewDecision === "string" ? pr.reviewDecision : null,
    queued: isRecord(pr.mergeQueueEntry),
    providerAutoMerge: isRecord(pr.autoMergeRequest),
    mergedBy: isRecord(pr.mergedBy) ? str(pr.mergedBy.login) || null : null,
    viewer: isRecord(data.viewer) ? str(data.viewer.login) : "",
    unresolvedThreads: nodes(pr.reviewThreads).filter((thread) => thread.isResolved !== true).length,
    mergeMethod: mergeMethod(repo),
    reviews: nodes(pr.reviews).map(parseReview),
    reviewsTruncated: isRecord(pr.reviews) && isRecord(pr.reviews.pageInfo) && pr.reviews.pageInfo.hasPreviousPage === true,
    threads: nodes(pr.reviewThreads).map(parseThread),
    threadsTruncated: isRecord(pr.reviewThreads) && isRecord(pr.reviewThreads.pageInfo) && pr.reviewThreads.pageInfo.hasPreviousPage === true,
    comments: nodes(pr.comments).map(parseComment),
  }
}

/** The base branch head's own checks: a red that is red there too is not the PR's doing. */
function baseFields(pr: Record<string, unknown>): { baseHead: string | null; baseChecks: PrCheck[]; conversationRule: PrSnapshot["conversationRule"] } {
  const ref = isRecord(pr.baseRef) ? pr.baseRef : null
  const commit = ref && isRecord(ref.target) ? ref.target : null
  const rollup = commit && isRecord(commit.statusCheckRollup) ? commit.statusCheckRollup : null
  // a ruleset's pull-request rule is readable by anyone; classic protection only by an admin (null otherwise)
  const ruleset = nodes(ref?.rules).some((rule) => rule.type === "PULL_REQUEST" && isRecord(rule.parameters) && rule.parameters.requiredReviewThreadResolution === true)
  const classic = ref && isRecord(ref.branchProtectionRule) ? ref.branchProtectionRule.requiresConversationResolution === true : null
  const conversationRule = ruleset || classic === true ? "required" : classic === false ? "not-required" : "unknown"
  return { baseHead: commit ? str(commit.oid) || null : null, baseChecks: nodes(rollup?.contexts).map(parseCheck), conversationRule }
}

export function parseSnapshot(raw: unknown): PrSnapshot {
  const data = isRecord(raw) && isRecord(raw.data) ? raw.data : null
  const repo = data && isRecord(data.repository) ? data.repository : null
  const pr = repo && isRecord(repo.pullRequest) ? repo.pullRequest : null
  if (!data || !repo || !pr) throw new Error("GitHub returned no pull request")
  const head = str(pr.headRefOid)
  const commit = nodes(pr.commits)[0]?.commit
  const checkedCommit = isRecord(commit) ? str(commit.oid) : ""
  // One document, one head: a push between the PR row and its checks would
  // otherwise pair the new head with the old head's results.
  if (!/^[0-9a-f]{40}$/i.test(head) || checkedCommit !== head || !isRecord(commit)) {
    throw new Error("PR changed during the check; waiting for a consistent answer")
  }
  const rollup = isRecord(commit.statusCheckRollup) ? commit.statusCheckRollup : null
  // A check past the first page could be the red one: refuse to decide.
  const more = (value: unknown) => isRecord(value) && isRecord(value.pageInfo) && value.pageInfo.hasNextPage === true
  if (more(rollup?.contexts) || more(commit.checkSuites)) throw new Error("Too many checks on this PR to verify them all")
  const actions = nodes(commit.checkSuites).filter((suite) => isRecord(suite.workflowRun) && str(suite.status) !== "COMPLETED")
  return {
    ...prFields(pr, repo, data),
    head,
    headCommittedAt: str(commit.committedDate) || null,
    checks: nodes(rollup?.contexts).map(parseCheck),
    actionsSuitesPending: actions.length,
    actionsSuitesWaiting: actions.filter((suite) => str(suite.status) === "WAITING").length,
    ...baseFields(pr),
  }
}

/** A batch's snapshots by PR number. One that cannot be read is left out, and its look reads it alone. */
export function parseSnapshots(raw: unknown, numbers: number[]): Map<number, PrSnapshot> {
  const data = isRecord(raw) && isRecord(raw.data) ? raw.data : null
  const repo = data && isRecord(data.repository) ? data.repository : null
  const found = new Map<number, PrSnapshot>()
  if (!data || !repo) return found
  numbers.forEach((number, index) => {
    try {
      const snapshot = parseSnapshot({ data: { ...data, repository: { ...repo, pullRequest: repo[`p${index}`] } } })
      if (snapshot.number === number) found.set(number, snapshot)
    } catch {
      // inconsistent, or too many checks: the look's own read says why
    }
  })
  return found
}

// shared with the CLI's brief printer; re-exported for this module's callers
export { controlFree }

/**
 * The part of a job log that explains the failure: the step that failed, up
 * to its last `##[error]` (or else up to where post-job cleanup starts) — the
 * start of a log is runner setup and checkout, and its end is teardown, not
 * the failure. Timestamps and terminal escapes are dropped; nobody reads those.
 */
export function tidyLog(raw: string, maxLines = 400, maxBytes = 64_000): string {
  // a CRLF ending is one line; a progress bar's lone \r splits into its states
  const all = raw.split(/\r?\n/).flatMap((line) => controlFree(line).split("\n")).map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ""))
  const teardown = (line: string) => /^(?:Post job cleanup|Cleaning up orphan processes|##\[group\]Post )/.test(line)
  const error = all.findLastIndex((line) => line.includes("##[error]"))
  let end = all.length
  if (error >= 0) {
    // the error, and the few lines that finish its sentence
    end = error + 1
    while (end < all.length && end < error + 4 && !teardown(all[end]!) && !all[end]!.startsWith("##[group]")) end++
  } else {
    const cleanup = all.findIndex(teardown)
    if (cleanup > 0) end = cleanup
  }
  // From the step that failed FIRST: runner setup and checkout before it are
  // noise, and a later always-run step (an upload, a log dump) that also
  // errors must not push the real failure out.
  const first = all.findIndex((line) => line.includes("##[error]"))
  const step = all.slice(0, first >= 0 ? first : end).findLastIndex((line) => line.startsWith("##[group]Run "))
  const start = Math.max(step, 0)
  let kept = all.slice(start, end)
  if (kept.length > maxLines) {
    // both ends: where the failure starts and where the job gave up
    const half = Math.floor(maxLines / 2)
    kept = [...kept.slice(0, half), `(… ${kept.length - 2 * half} lines omitted …)`, ...kept.slice(-half)]
  }
  let text = kept.join("\n")
  const bytes = Buffer.from(text)
  if (bytes.length > maxBytes) {
    // long lines (JSON, diffs) can outgrow the byte budget under the line
    // budget: keep both ends here too, so the first failure stays
    const half = Math.floor(maxBytes / 2)
    text = `${bytes.subarray(0, half).toString("utf8")}\n(… ${bytes.length - 2 * half} bytes omitted …)\n${bytes.subarray(-half).toString("utf8")}`
  }
  return `${start > 0 ? "(earlier steps omitted)\n" : ""}${text.trim()}`
}

/**
 * Squash when the repository allows it, because that is what a task's PR is
 * — one change, one commit on the base. Otherwise the only method allowed,
 * and failing that, the viewer's own default.
 */
export function mergeMethod(repo: Record<string, unknown>): MergeMethod {
  if (repo.squashMergeAllowed === true) return "SQUASH"
  const allowed: MergeMethod[] = []
  if (repo.mergeCommitAllowed === true) allowed.push("MERGE")
  if (repo.rebaseMergeAllowed === true) allowed.push("REBASE")
  if (allowed.length === 1) return allowed[0]!
  const fallback = str(repo.viewerDefaultMergeMethod)
  return fallback === "MERGE" || fallback === "REBASE" ? fallback : "MERGE"
}

/**
 * `branches/{b}` tells anyone who can read the repository whether classic
 * protection exists: `protection.enabled`. (`protected` is true for a ruleset
 * alone, so it only settles the question when it is false.)
 */
export function classicProtectionOf(branch: unknown): boolean | null {
  if (!isRecord(branch)) return null
  const enabled = isRecord(branch.protection) ? branch.protection.enabled : undefined
  if (typeof enabled === "boolean") return enabled
  return branch.protected === false ? false : null
}

export function parseRequiredChecks(branch: unknown, rules: unknown): string[] {
  const names = new Set<string>()
  const protection = isRecord(branch) && isRecord(branch.protection) ? branch.protection : null
  const classic = protection && isRecord(protection.required_status_checks) ? protection.required_status_checks : null
  if (classic && classic.enforcement_level !== "off") {
    if (Array.isArray(classic.contexts)) for (const name of classic.contexts) if (typeof name === "string") names.add(name)
    if (Array.isArray(classic.checks)) for (const check of classic.checks) if (isRecord(check) && typeof check.context === "string") names.add(check.context)
  }
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (!isRecord(rule) || rule.type !== "required_status_checks" || !isRecord(rule.parameters)) continue
      const listed = rule.parameters.required_status_checks
      if (Array.isArray(listed)) for (const check of listed) if (isRecord(check) && typeof check.context === "string") names.add(check.context)
    }
  }
  return [...names].sort()
}

/**
 * The open PRs whose head has one of these branch names. `headRefName` matches
 * forks' branches of the same name too, oldest first: a full page, so
 * strangers' fork PRs cannot crowd the task's own out (choosePull drops them).
 */
export function openPullsQuery(branches: string[]): string {
  const selections = branches.map((branch, index) => `
    b${index}: pullRequests(first: 100, headRefName: ${JSON.stringify(branch)}, states: [OPEN], orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes { number headRefName baseRefName createdAt isCrossRepository author { login } }
    }`).join("\n")
  return `query($owner: String!, $name: String!) { ${RATE_LIMIT} viewer { login } repository(owner: $owner, name: $name) { defaultBranchRef { name } ${selections} } }`
}

export function parseOpenPulls(raw: unknown, branches: string[]): { defaultBranch: string; viewer: string; pulls: OpenPullRequest[] } {
  const repo = isRecord(raw) && isRecord(raw.data) && isRecord(raw.data.repository) ? raw.data.repository : null
  if (!repo) throw new Error("GitHub returned no repository")
  const pulls: OpenPullRequest[] = []
  for (let index = 0; index < branches.length; index++) {
    for (const node of nodes(repo[`b${index}`])) {
      pulls.push({
        number: Number(node.number), headRefName: str(node.headRefName), baseRefName: str(node.baseRefName),
        createdAt: str(node.createdAt), isCrossRepository: node.isCrossRepository === true,
        author: isRecord(node.author) ? str(node.author.login) || null : null,
      })
    }
  }
  const viewer = isRecord(raw) && isRecord(raw.data) && isRecord(raw.data.viewer) ? str(raw.data.viewer.login) : ""
  return { defaultBranch: isRecord(repo.defaultBranchRef) ? str(repo.defaultBranchRef.name) : "", viewer, pulls }
}

function failure(result: RunResult): string | null {
  if (result.exitCode === 0 && !result.truncated && !result.timedOut && !result.cancelled && !result.cleanupError) return null
  return result.err.trim().split("\n").pop() ?? ""
}

/**
 * The client over the daemon host's `gh`. Every call is accounted in the
 * budget: refused before it goes out while GitHub (or Wisp's own share) says
 * wait, and a rate limit in its answer pauses them all (github-budget.ts).
 */
export function createGhAutopilot(options: { run?: GhRun; budget?: GitHubBudget } = {}): AutopilotGitHub {
  const run = options.run ?? runBounded
  const budget = options.budget ?? githubBudget
  const gh = (args: string[], cwd: string, signal: AbortSignal, timeoutMs = 20_000, maxBytes = 4_000_000) =>
    run({ cmd: ["gh", ...args], cwd, signal, timeoutMs, maxBytes, maxErrorBytes: 4000, env: GH_ENV })

  /**
   * A gh call spent from the budget: its expected cost reserved before it goes
   * out, then settled with what GitHub said. Only `--include` shows GitHub's
   * headers; any other call is read from gh's stderr, and costs `unseen`.
   */
  async function accounted(resource: GitHubResource, estimate: number, go: () => Promise<RunResult>, included: boolean, unseen = 0) {
    budget.reserve(resource, estimate)
    let result: RunResult
    try {
      result = await go()
    } catch (error) {
      budget.settle(resource, null, estimate)
      throw error
    }
    const reply = ghReply(included ? result.out : "", result.err, failure(result) !== null)
    budget.settle(resource, reply, estimate, unseen)
    return { result, reply }
  }

  /** One `gh api --include` call: GitHub's rate-limit headers come back with the answer. */
  const api = (resource: GitHubResource, args: string[], cwd: string, signal: AbortSignal, estimate = 1, maxBytes?: number) =>
    accounted(resource, estimate, () => gh(["api", "--include", ...args], cwd, signal, 20_000, maxBytes), true)

  async function json(resource: GitHubResource, args: string[], cwd: string, signal: AbortSignal, estimate?: number, maxBytes?: number): Promise<unknown> {
    const { result, reply } = await api(resource, args, cwd, signal, estimate, maxBytes)
    const detail = failure(result)
    if (detail !== null) throw new Error(`GitHub unavailable${detail ? `: ${detail.slice(0, 200)}` : ""}`)
    if (reply.json === undefined) throw new Error("GitHub unavailable: its answer was not JSON")
    return reply.json
  }

  const graphql = (repository: string, query: string, cwd: string, signal: AbortSignal, estimate: number, extra: string[] = [], maxBytes?: number) => {
    const [owner, name] = split(repository)
    return json("graphql", ["graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, ...extra, "-f", `query=${query}`], cwd, signal, estimate, maxBytes)
  }

  return {
    async snapshot(repository, number, cwd, signal) {
      return parseSnapshot(await graphql(repository, SNAPSHOT, cwd, signal, SNAPSHOT_POINTS, ["-F", `number=${number}`]))
    },
    async snapshots(repository, numbers, cwd, signal) {
      const raw = await graphql(repository, snapshotsQuery(numbers), cwd, signal, SNAPSHOT_POINTS * numbers.length, [], 4_000_000 * numbers.length)
      return parseSnapshots(raw, numbers)
    },
    async openPullRequests(repository, branches, cwd, signal) {
      return parseOpenPulls(await graphql(repository, openPullsQuery(branches), cwd, signal, 1), branches)
    },
    async requiredChecks(repository, base, cwd, signal) {
      const path = `repos/${repository}`
      const encoded = encodeURIComponent(base)
      const [branch, rules] = await Promise.all([
        json("core", [`${path}/branches/${encoded}`], cwd, signal),
        json("core", [`${path}/rules/branches/${encoded}`], cwd, signal).catch(unlessPaused([])),
      ])
      return { checks: parseRequiredChecks(branch, rules), classicProtection: classicProtectionOf(branch) }
    },
    async rerunRun(repository, runId, cwd, signal) {
      // Per RUN, not per job: rerunning one job of a run whose aggregator needs
      // it re-evaluates the aggregator against the old results, and a second
      // job's rerun is refused while the first is going.
      const { result } = await api("core", ["-X", "POST", `repos/${repository}/actions/runs/${runId}/rerun-failed-jobs`], cwd, signal)
      if (result.exitCode === 0 && !result.timedOut && !result.cancelled) return true
      // A refusal is an answer ("Could not rerun"), not an error; its reason is
      // only in gh's stderr, so the daemon log keeps it. A shutdown's abort is not news.
      if (!result.cancelled) {
        const detail = result.timedOut ? "timed out" : (result.err.trim().split("\n").pop() ?? "").slice(0, 200)
        console.error(`[wisp] autopilot: GitHub did not rerun workflow run ${runId} of ${repository}${detail ? `: ${detail}` : ""}`)
      }
      return false
    },
    async jobLogTail(repository, jobId, cwd, signal) {
      // A job log can be many megabytes and the bounded runner keeps its START;
      // pipe it through `tail` so only the end — where the failure is — arrives.
      // `--allow-escape-sequences` is needed because CI logs carry terminal
      // escapes (tidyLog strips them); an older gh without the flag gets a retry
      // without it. Piped, the answer shows no headers: it counts as one request.
      const read = async (flag: string[]) => (await accounted("core", 1, () => run({
        cmd: ["bash", "-c", 'set -o pipefail; gh api "$@" | tail -n 2000 | tail -c 600000', "wisp-log", ...flag, `repos/${repository}/actions/jobs/${jobId}/logs`],
        cwd, signal, timeoutMs: 60_000, maxBytes: 800_000, maxErrorBytes: 2000, env: GH_ENV,
      }), false, 1)).result
      let result = await read(["--allow-escape-sequences"])
      if (result.exitCode !== 0 && /unknown flag/i.test(result.err)) result = await read([])
      if (result.exitCode !== 0 || result.timedOut || result.cancelled) throw new Error("GitHub unavailable: could not read the job log")
      return tidyLog(result.out)
    },
    async checkRunReport(repository, checkRunId, cwd, signal) {
      const [report, annotations] = await Promise.all([
        json("core", [`repos/${repository}/check-runs/${checkRunId}`], cwd, signal),
        json("core", [`repos/${repository}/check-runs/${checkRunId}/annotations?per_page=50`], cwd, signal).catch(unlessPaused([])),
      ])
      const output = isRecord(report) && isRecord(report.output) ? report.output : {}
      const notes = Array.isArray(annotations) ? annotations.filter(isRecord).map((note) =>
        `${str(note.path)}:${String(note.start_line ?? "")} ${str(note.annotation_level)}: ${str(note.message)}`) : []
      return controlFree([str(output.title), str(output.summary), str(output.text), ...notes].filter(Boolean).join("\n\n")).slice(0, 64_000)
    },
    async canPush(repository, login, cwd, signal) {
      const result = await json("core", [`repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`], cwd, signal)
      if (!isRecord(result)) return false
      // role_name tells maintain from write; permission is the classic level
      return ["admin", "maintain", "write"].includes(str(result.role_name)) || ["admin", "write"].includes(str(result.permission))
    },
    async merge({ repository, number, method, head }, cwd, signal) {
      // GitHub refusing the merge for the rate is no merge failure: settling throws, and the look pauses instead
      const { result } = await accounted("graphql", MERGE_POINTS, () => gh(
        ["pr", "merge", String(number), "--repo", repository, `--${method.toLowerCase()}`, "--match-head-commit", head],
        cwd, signal, 60_000,
      ), false, MERGE_POINTS)
      const detail = [result.out, result.err].join("\n").trim().split("\n").filter(Boolean).slice(-3).join(" · ").slice(0, 300)
      return { ok: result.exitCode === 0 && !result.timedOut && !result.cancelled, detail }
    },
  }
}

export const ghAutopilot: AutopilotGitHub = createGhAutopilot()
