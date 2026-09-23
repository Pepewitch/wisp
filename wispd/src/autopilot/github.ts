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
  author: string | null
  association: string
  bot: boolean
  state: string
  body: string
  /** the head this review was written against */
  commit: string | null
  submittedAt: string
}

export interface PrSnapshot {
  number: number
  url: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  isCrossRepository: boolean
  head: string
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
  reviews: PrReview[]
  unresolvedThreads: number
  mergeMethod: MergeMethod
}

export interface OpenPullRequest {
  number: number
  headRefName: string
  baseRefName: string
  createdAt: string
  isCrossRepository: boolean
}

export interface AutopilotGitHub {
  snapshot(repository: string, number: number, cwd: string, signal: AbortSignal): Promise<PrSnapshot>
  openPullRequests(repository: string, branches: string[], cwd: string, signal: AbortSignal): Promise<{ defaultBranch: string; pulls: OpenPullRequest[] }>
  /** Context names the base branch requires, from classic protection and rulesets. */
  requiredChecks(repository: string, base: string, cwd: string, signal: AbortSignal): Promise<string[]>
  merge(input: { repository: string; number: number; method: MergeMethod; head: string }, cwd: string, signal: AbortSignal): Promise<{ ok: boolean; detail: string }>
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
      reviewThreads(first: 100) { nodes { isResolved } }
      reviews(last: 50) { nodes { state body submittedAt authorAssociation author { login __typename } commit { oid } } }
      commits(last: 1) { nodes { commit { oid
        checkSuites(first: 50) { nodes { status workflowRun { databaseId } } }
        statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) }
          ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
        } } }
      } } }
    }
  }
}`

function nodes(value: unknown): Record<string, unknown>[] {
  return isRecord(value) && Array.isArray(value.nodes) ? value.nodes.filter(isRecord) : []
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
  if (!/^[0-9a-f]{40}$/i.test(head) || (checkedCommit !== "" && checkedCommit !== head)) {
    throw new Error("PR changed during the check; waiting for a consistent answer")
  }
  const rollup = isRecord(commit) && isRecord(commit.statusCheckRollup) ? commit.statusCheckRollup : null
  const checks: PrCheck[] = nodes(rollup?.contexts).map((node) => node.__typename === "StatusContext"
    ? { name: str(node.context), status: str(node.state), conclusion: null, required: node.isRequired === true, url: str(node.targetUrl) }
    : { name: str(node.name), status: str(node.status), conclusion: typeof node.conclusion === "string" ? node.conclusion : null, required: node.isRequired === true, url: str(node.detailsUrl) })
  const suites = isRecord(commit) ? nodes(commit.checkSuites) : []
  const actionsSuitesPending = suites.filter((suite) => isRecord(suite.workflowRun) && str(suite.status) !== "COMPLETED").length
  const reviews: PrReview[] = nodes(pr.reviews).map((node) => {
    const author = isRecord(node.author) ? node.author : null
    return {
      author: author ? str(author.login) || null : null,
      association: str(node.authorAssociation),
      bot: author?.__typename === "Bot",
      state: str(node.state),
      body: str(node.body),
      commit: isRecord(node.commit) ? str(node.commit.oid) || null : null,
      submittedAt: str(node.submittedAt),
    }
  })
  const state = str(pr.state)
  return {
    number: Number(pr.number),
    url: str(pr.url),
    state: state === "MERGED" || state === "CLOSED" ? state : "OPEN",
    isDraft: pr.isDraft === true,
    isCrossRepository: pr.isCrossRepository === true,
    head,
    headRefName: str(pr.headRefName),
    baseRefName: str(pr.baseRefName),
    defaultBranch: isRecord(repo.defaultBranchRef) ? str(repo.defaultBranchRef.name) : "",
    mergeState: str(pr.mergeStateStatus) || "UNKNOWN",
    reviewDecision: typeof pr.reviewDecision === "string" ? pr.reviewDecision : null,
    queued: isRecord(pr.mergeQueueEntry),
    providerAutoMerge: isRecord(pr.autoMergeRequest),
    mergedBy: isRecord(pr.mergedBy) ? str(pr.mergedBy.login) || null : null,
    viewer: isRecord(data.viewer) ? str(data.viewer.login) : "",
    checks,
    actionsSuitesPending,
    reviews,
    unresolvedThreads: nodes(pr.reviewThreads).filter((thread) => thread.isResolved !== true).length,
    mergeMethod: mergeMethod(repo),
  }
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
        nodes { number headRefName baseRefName createdAt isCrossRepository }
      }`).join("\n")
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { defaultBranchRef { name } ${selections} } }`
    const raw = await ghJson(["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${query}`], cwd, signal)
    const repo = isRecord(raw) && isRecord(raw.data) && isRecord(raw.data.repository) ? raw.data.repository : null
    if (!repo) throw new Error("GitHub returned no repository")
    const pulls: OpenPullRequest[] = []
    for (let index = 0; index < branches.length; index++) {
      for (const node of nodes(repo[`b${index}`])) {
        pulls.push({
          number: Number(node.number), headRefName: str(node.headRefName), baseRefName: str(node.baseRefName),
          createdAt: str(node.createdAt), isCrossRepository: node.isCrossRepository === true,
        })
      }
    }
    return { defaultBranch: isRecord(repo.defaultBranchRef) ? str(repo.defaultBranchRef.name) : "", pulls }
  },
  async requiredChecks(repository, base, cwd, signal) {
    const path = `repos/${repository}`
    const encoded = encodeURIComponent(base)
    const [branch, rules] = await Promise.all([
      ghJson(["api", `${path}/branches/${encoded}`], cwd, signal),
      ghJson(["api", `${path}/rules/branches/${encoded}`], cwd, signal).catch(() => []),
    ])
    return parseRequiredChecks(branch, rules)
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
