import type { ProbeSpawnFn } from "./adapters";
import type {
  PullRequestChecks,
  PullRequestInfo,
  PullRequestLifecycle,
  PullRequestMergeState,
  PullRequestReview,
  PullRequestStatus,
} from "./pull-requests";
import type { Task } from "./types";
import { isRecord } from "./validate";

export async function githubPullRequest(
  task: Task,
  repository: string,
  run: ProbeSpawnFn,
  signal: AbortSignal,
): Promise<PullRequestStatus> {
  const result = await run(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      repository,
      "--head",
      task.branch!,
      "--state",
      "all",
      "--limit",
      "10",
      "--json",
      "number,url,title,state,isDraft,isCrossRepository,mergedAt,updatedAt,reviewDecision,statusCheckRollup,mergeStateStatus",
    ],
    { cwd: task.repo_path, signal },
  );
  if (result.exitCode !== 0) return { kind: "unavailable", provider: "github" };
  const parsed = parsePullRequests(result.stdout, repository);
  if (parsed === null) return { kind: "unavailable", provider: "github" };
  if (parsed.length === 0) return { kind: "none", provider: "github" };
  return { kind: "found", provider: "github", pullRequest: preferredPullRequest(parsed) };
}

export async function githubPullRequestBatch(
  repository: string,
  branches: string[],
  cwd: string,
  run: ProbeSpawnFn,
  signal: AbortSignal,
): Promise<Map<string, PullRequestStatus>> {
  const [owner, name] = repository.split("/");
  if (!owner || !name) return unavailableBranches(branches);
  const selections = branches
    .map(
      (branch, index) => `
        b${index}: pullRequests(
          first: 10
          headRefName: ${JSON.stringify(branch)}
          states: [OPEN, CLOSED, MERGED]
          orderBy: { field: UPDATED_AT, direction: DESC }
        ) {
          nodes {
            number
            url
            title
            state
            isDraft
            isCrossRepository
            mergedAt
            updatedAt
            reviewDecision
            mergeStateStatus
            statusCheckRollup { state }
          }
        }`,
    )
    .join("\n");
  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${selections}
      }
    }`;
  const result = await run(
    [
      "gh",
      "api",
      "graphql",
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-f",
      `query=${query}`,
    ],
    { cwd, signal },
  );
  if (result.exitCode !== 0) return unavailableBranches(branches);
  return parsePullRequestBatch(result.stdout, repository, branches) ??
    unavailableBranches(branches);
}

export function unavailableBranches(branches: string[]): Map<string, PullRequestStatus> {
  return new Map(
    branches.map((branch) => [
      branch,
      { kind: "unavailable", provider: "github" } as const,
    ]),
  );
}

export function githubRepository(origin: string): string | null {
  const value = origin.trim();
  const scp = value.match(/^(?:[^@/:]+@)?github\.com:([^/]+)\/([^/]+?)\/?$/i);
  if (scp) return repositorySlug(scp[1]!, scp[2]!);
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.length === 2 ? repositorySlug(parts[0]!, parts[1]!) : null;
  } catch {
    return null;
  }
}

function repositorySlug(owner: string, rawName: string): string | null {
  const name = rawName.replace(/\.git$/i, "");
  return /^[a-z0-9-]+$/i.test(owner) && /^[a-z0-9_.-]+$/i.test(name) ? `${owner}/${name}` : null;
}

function parsePullRequests(stdout: string, repository: string): PullRequestInfo[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  return parsePullRequestRows(raw, repository);
}

function parsePullRequestBatch(
  stdout: string,
  repository: string,
  branches: string[],
): Map<string, PullRequestStatus> | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(envelope) || !isRecord(envelope.data)) return null;
  const repositoryData = envelope.data.repository;
  if (!isRecord(repositoryData)) return null;
  const statuses = new Map<string, PullRequestStatus>();
  for (const [index, branch] of branches.entries()) {
    const connection = repositoryData[`b${index}`];
    if (!isRecord(connection) || !Array.isArray(connection.nodes)) {
      statuses.set(branch, { kind: "unavailable", provider: "github" });
      continue;
    }
    const rows = parsePullRequestRows(connection.nodes, repository);
    if (rows === null) {
      statuses.set(branch, { kind: "unavailable", provider: "github" });
    } else if (rows.length === 0) {
      statuses.set(branch, { kind: "none", provider: "github" });
    } else {
      statuses.set(branch, {
        kind: "found",
        provider: "github",
        pullRequest: preferredPullRequest(rows),
      });
    }
  }
  return statuses;
}

function parsePullRequestRows(raw: unknown, repository: string): PullRequestInfo[] | null {
  if (!Array.isArray(raw)) return null;
  const parsed: PullRequestInfo[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate) || typeof candidate.isCrossRepository !== "boolean") return null;
    if (candidate.isCrossRepository) continue;
    const pullRequest = parsePullRequest(candidate, repository);
    if (!pullRequest) return null;
    parsed.push(pullRequest);
  }
  return parsed;
}

function parsePullRequest(raw: unknown, repository: string): PullRequestInfo | null {
  if (!isRecord(raw)) return null;
  const number = raw.number;
  const title = text(raw.title);
  const state = text(raw.state)?.toUpperCase();
  const updatedAt = text(raw.updatedAt);
  if (!Number.isInteger(number) || Number(number) < 1 || !title || !state || !updatedAt) return null;
  const url = githubUrl(raw.url, repository, Number(number));
  if (!url) return null;
  const lifecycle = pullRequestLifecycle(state, raw.isDraft === true, raw.mergedAt);
  if (!lifecycle) return null;
  return {
    number: Number(number),
    url,
    title,
    lifecycle,
    checks: checkState(raw.statusCheckRollup),
    review: reviewState(raw.reviewDecision),
    mergeState: mergeState(raw.mergeStateStatus),
    updatedAt,
  };
}

function preferredPullRequest(rows: PullRequestInfo[]): PullRequestInfo {
  return [...rows].sort((a, b) => {
    const active = Number(b.lifecycle === "open" || b.lifecycle === "draft") -
      Number(a.lifecycle === "open" || a.lifecycle === "draft");
    return active || b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number;
  })[0]!;
}

function pullRequestLifecycle(
  state: string,
  draft: boolean,
  mergedAt: unknown,
): PullRequestLifecycle | null {
  if (state === "OPEN") return draft ? "draft" : "open";
  if (state === "MERGED" || typeof mergedAt === "string") return "merged";
  return state === "CLOSED" ? "closed" : null;
}

function reviewState(value: unknown): PullRequestReview {
  const decision = text(value)?.toUpperCase();
  if (!decision) return "none";
  if (decision === "REVIEW_REQUIRED") return "required";
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes-requested";
  return "unknown";
}

function mergeState(value: unknown): PullRequestMergeState {
  switch (text(value)?.toUpperCase()) {
    case "CLEAN":
    case "HAS_HOOKS":
      return "ready";
    case "UNSTABLE":
      return "unstable";
    case "BLOCKED":
      return "blocked";
    case "BEHIND":
      return "behind";
    case "DIRTY":
      return "conflicting";
    default:
      return "unknown";
  }
}

function checkState(value: unknown): PullRequestChecks {
  if (value === null) return "none";
  if (isRecord(value)) {
    switch (text(value.state)?.toUpperCase()) {
      case "SUCCESS":
        return "passed";
      case "PENDING":
      case "EXPECTED":
        return "pending";
      case "FAILURE":
      case "ERROR":
        return "failed";
      default:
        return "unknown";
    }
  }
  if (!Array.isArray(value)) return "unknown";
  if (value.length === 0) return "none";
  let pending = false;
  let failed = false;
  let unknown = false;
  for (const raw of value) {
    if (!isRecord(raw)) {
      unknown = true;
      continue;
    }
    const kind = text(raw.__typename);
    if (kind === "CheckRun") {
      const status = text(raw.status)?.toUpperCase();
      if (["REQUESTED", "QUEUED", "IN_PROGRESS", "WAITING", "PENDING"].includes(status ?? "")) {
        pending = true;
      } else if (status !== "COMPLETED") {
        unknown = true;
      } else if (
        [
          "FAILURE",
          "CANCELLED",
          "TIMED_OUT",
          "ACTION_REQUIRED",
          "STARTUP_FAILURE",
          "STALE",
        ].includes(text(raw.conclusion)?.toUpperCase() ?? "")
      ) {
        failed = true;
      } else if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(text(raw.conclusion)?.toUpperCase() ?? "")) {
        unknown = true;
      }
    } else if (kind === "StatusContext") {
      const state = text(raw.state)?.toUpperCase();
      if (state === "PENDING" || state === "EXPECTED") pending = true;
      else if (state === "FAILURE" || state === "ERROR") failed = true;
      else if (state !== "SUCCESS") unknown = true;
    } else {
      unknown = true;
    }
  }
  if (pending) return "pending";
  if (failed) return "failed";
  return unknown ? "unknown" : "passed";
}

function githubUrl(value: unknown, repository: string, number: number): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const expectedPath = `/${repository}/pull/${number}`.toLowerCase();
    return parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase() === "github.com" &&
      parsed.pathname.replace(/\/$/, "").toLowerCase() === expectedPath
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
