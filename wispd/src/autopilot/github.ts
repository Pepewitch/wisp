/**
 * Everything autopilot asks GitHub, behind one small interface so the
 * decision code can be tested against fixtures. Reads go through the daemon
 * host's authenticated `gh`; the only write is `gh pr merge`, which respects
 * every branch protection, ruleset, and merge queue the repository has.
 */
import { runBounded } from "../subprocess"
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
  reviews: PrReview[]
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

async function gh(args: string[], cwd: string, signal: AbortSignal, timeoutMs = 20_000) {
  return await runBounded({
    cmd: ["gh", ...args], cwd, signal, timeoutMs, maxBytes: 4_000_000, maxErrorBytes: 4000, env: GH_ENV,
  })
}

async function ghJson(args: string[], cwd: string, signal: AbortSignal): Promise<unknown> {
  const result = await gh(args, cwd, signal)
  if (result.exitCode !== 0 || result.truncated || result.timedOut || result.cancelled || result.cleanupError) {
    const detail = result.err.trim().split("\n").pop() ?? ""
    throw new Error(`GitHub unavailable${detail ? `: ${detail.slice(0, 200)}` : ""}`)
  }
  return JSON.parse(result.out)
}

function split(repository: string): [string, string] {
  const [owner, name] = repository.split("/")
  if (!owner || !name) throw new Error(`not a GitHub repository: ${repository}`)
  return [owner, name]
}

const str = (value: unknown): string => (typeof value === "string" ? value : "")

const SNAPSHOT = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed viewerDefaultMergeMethod
    pullRequest(number: $number) {
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
      reviews(last: 50) { nodes { id state body submittedAt lastEditedAt url authorAssociation author { login __typename } commit { oid } } }
      comments(last: 100) { nodes { ...comment } }
      commits(last: 1) { nodes { commit { oid committedDate
        checkSuites(first: 100) { pageInfo { hasNextPage } nodes { status workflowRun { databaseId } } }
        statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage } nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl databaseId isRequired(pullRequestNumber: $number)
            deployment { id } checkSuite { app { slug } workflowRun { databaseId event } } }
          ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
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
      }
    }
  }
}
fragment comment on Comment {
  id body createdAt lastEditedAt authorAssociation author { login __typename }
  ... on IssueComment { url isMinimized }
  ... on PullRequestReviewComment { url isMinimized state }
}`

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

/** Terminal escapes (CSI and OSC sequences) and every other control character but tab and newline. */
export function controlFree(line: string): string {
  return line
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
}

/**
 * The part of a job log that explains the failure: the step that failed, up
 * to its last `##[error]` (or else up to where post-job cleanup starts) — the
 * start of a log is runner setup and checkout, and its end is teardown, not
 * the failure. Timestamps and terminal escapes are dropped; nobody reads those.
 */
export function tidyLog(raw: string, maxLines = 400, maxBytes = 64_000): string {
  const all = raw.split("\n").map((line) => controlFree(line).replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ""))
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

export const ghAutopilot: AutopilotGitHub = {
  async snapshot(repository, number, cwd, signal) {
    const [owner, name] = split(repository)
    const raw = await ghJson(["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`, "-f", `query=${SNAPSHOT}`], cwd, signal)
    return parseSnapshot(raw)
  },
  async openPullRequests(repository, branches, cwd, signal) {
    const [owner, name] = split(repository)
    const selections = branches.map((branch, index) => `
      b${index}: pullRequests(first: 5, headRefName: ${JSON.stringify(branch)}, states: [OPEN], orderBy: { field: CREATED_AT, direction: ASC }) {
        nodes { number headRefName baseRefName createdAt isCrossRepository author { login } }
      }`).join("\n")
    const query = `query($owner: String!, $name: String!) { viewer { login } repository(owner: $owner, name: $name) { defaultBranchRef { name } ${selections} } }`
    const raw = await ghJson(["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${query}`], cwd, signal)
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
  },
  async requiredChecks(repository, base, cwd, signal) {
    const path = `repos/${repository}`
    const encoded = encodeURIComponent(base)
    const [branch, rules] = await Promise.all([
      ghJson(["api", `${path}/branches/${encoded}`], cwd, signal),
      ghJson(["api", `${path}/rules/branches/${encoded}`], cwd, signal).catch(() => []),
    ])
    return { checks: parseRequiredChecks(branch, rules), classicProtection: classicProtectionOf(branch) }
  },
  async rerunRun(repository, runId, cwd, signal) {
    // Per RUN, not per job: rerunning one job of a run whose aggregator needs
    // it re-evaluates the aggregator against the old results, and a second
    // job's rerun is refused while the first is going.
    const result = await gh(["api", "-X", "POST", `repos/${repository}/actions/runs/${runId}/rerun-failed-jobs`], cwd, signal)
    return result.exitCode === 0 && !result.timedOut && !result.cancelled
  },
  async jobLogTail(repository, jobId, cwd, signal) {
    // A job log can be many megabytes and the bounded runner keeps its START;
    // pipe it through `tail` so only the end — where the failure is — arrives.
    // `--allow-escape-sequences` is needed because CI logs carry terminal
    // escapes (tidyLog strips them); an older gh without the flag gets a retry
    // without it.
    const read = (flag: string[]) => runBounded({
      cmd: ["bash", "-c", 'set -o pipefail; gh api "$@" | tail -n 2000 | tail -c 600000', "wisp-log", ...flag, `repos/${repository}/actions/jobs/${jobId}/logs`],
      cwd, signal, timeoutMs: 60_000, maxBytes: 800_000, maxErrorBytes: 2000, env: GH_ENV,
    })
    let result = await read(["--allow-escape-sequences"])
    if (result.exitCode !== 0 && /unknown flag/i.test(result.err)) result = await read([])
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) throw new Error("GitHub unavailable: could not read the job log")
    return tidyLog(result.out)
  },
  async checkRunReport(repository, checkRunId, cwd, signal) {
    const [run, annotations] = await Promise.all([
      ghJson(["api", `repos/${repository}/check-runs/${checkRunId}`], cwd, signal),
      ghJson(["api", `repos/${repository}/check-runs/${checkRunId}/annotations?per_page=50`], cwd, signal).catch(() => []),
    ])
    const output = isRecord(run) && isRecord(run.output) ? run.output : {}
    const notes = Array.isArray(annotations) ? annotations.filter(isRecord).map((note) =>
      `${str(note.path)}:${String(note.start_line ?? "")} ${str(note.annotation_level)}: ${str(note.message)}`) : []
    return controlFree([str(output.title), str(output.summary), str(output.text), ...notes].filter(Boolean).join("\n\n")).slice(0, 64_000)
  },
  async canPush(repository, login, cwd, signal) {
    const result = await ghJson(["api", `repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`], cwd, signal)
    if (!isRecord(result)) return false
    // role_name tells maintain from write; permission is the classic level
    return ["admin", "maintain", "write"].includes(str(result.role_name)) || ["admin", "write"].includes(str(result.permission))
  },
  async merge({ repository, number, method, head }, cwd, signal) {
    const result = await gh(
      ["pr", "merge", String(number), "--repo", repository, `--${method.toLowerCase()}`, "--match-head-commit", head],
      cwd, signal, 60_000,
    )
    const detail = [result.out, result.err].join("\n").trim().split("\n").filter(Boolean).slice(-3).join(" · ").slice(0, 300)
    return { ok: result.exitCode === 0 && !result.timedOut && !result.cancelled, detail }
  },
}
