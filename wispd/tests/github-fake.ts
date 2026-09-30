/**
 * A fake GitHub behind a fake `gh`, for the GitHub budget suites: it answers
 * the queries Wisp really sends, with `--include` headers and a GraphQL
 * `rateLimit` whose cost follows GitHub's documented formula, keeps an hourly
 * limit of its own, and can refuse with a primary or a secondary rate limit.
 * Nothing here reaches the network.
 */
import type { PrSnapshot } from "../src/autopilot/github";
import type { RunOptions, RunResult } from "../src/subprocess";

type CostNode = { limit: number | null; children: CostNode[] } | { spread: string };

const TOKEN = /"(?:[^"\\]|\\.)*"|\.\.\.|[A-Za-z_$][\w$]*|-?\d+(?:\.\d+)?|[{}()[\]:!=,@]/g;

/**
 * What GitHub charges for a query: every connection costs one request per
 * node of the connections around it (their `first`/`last`), summed over the
 * query, divided by 100 and rounded; never less than 1 point.
 * https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
 */
export function graphqlCost(query: string): number {
  const tokens = query.match(TOKEN) ?? [];
  let at = 0;
  const skipArguments = (): number | null => {
    let depth = 0;
    let limit: number | null = null;
    do {
      const token = tokens[at++];
      if (token === "(") depth++;
      else if (token === ")") depth--;
      else if (depth === 1 && (token === "first" || token === "last") && tokens[at] === ":" && /^\d+$/.test(tokens[at + 1] ?? "")) limit = Number(tokens[at + 1]);
    } while (depth > 0 && at < tokens.length);
    return limit;
  };
  const selection = (): CostNode[] => {
    const nodes: CostNode[] = [];
    while (at < tokens.length && tokens[at] !== "}") {
      const token = tokens[at++]!;
      if (token === "...") {
        if (tokens[at] === "on") {
          at += 2;
          at++; // {
          nodes.push({ limit: null, children: selection() });
        } else nodes.push({ spread: tokens[at++]! });
        continue;
      }
      if (tokens[at] === ":") at += 2; // an alias
      const limit = tokens[at] === "(" ? skipArguments() : null;
      let children: CostNode[] = [];
      if (tokens[at] === "{") {
        at++;
        children = selection();
      }
      nodes.push({ limit, children });
    }
    at++; // }
    return nodes;
  };
  const fragments = new Map<string, CostNode[]>();
  const operations: CostNode[][] = [];
  while (at < tokens.length) {
    const token = tokens[at];
    if (token === "fragment") {
      const name = tokens[at + 1]!;
      while (tokens[at] !== "{") at++;
      at++;
      fragments.set(name, selection());
    } else if (token === "(") skipArguments();
    else if (token === "{") {
      at++;
      operations.push(selection());
    } else at++;
  }
  let requests = 0;
  const walk = (nodes: CostNode[], around: number): void => {
    for (const node of nodes) {
      if ("spread" in node) walk(fragments.get(node.spread) ?? [], around);
      else {
        if (node.limit !== null) requests += around;
        walk(node.children, node.limit === null ? around : around * node.limit);
      }
    }
  };
  for (const operation of operations) walk(operation, 1);
  return Math.max(1, Math.round(requests / 100));
}

/** A PR snapshot as GitHub's GraphQL answers it: what `parseSnapshot` reads back (no reviews, threads or comments). */
export function rawPull(pr: PrSnapshot): Record<string, unknown> {
  return {
    number: pr.number, url: pr.url, state: pr.state, isDraft: pr.isDraft, isCrossRepository: pr.isCrossRepository,
    mergedBy: pr.mergedBy ? { login: pr.mergedBy } : null, headRefOid: pr.head, headRefName: pr.headRefName, baseRefName: pr.baseRefName,
    mergeStateStatus: pr.mergeState, reviewDecision: pr.reviewDecision,
    mergeQueueEntry: pr.queued ? { id: "queue" } : null, autoMergeRequest: pr.providerAutoMerge ? { enabledAt: "2026-01-01T00:00:00Z" } : null,
    reviewThreads: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    comments: { nodes: [] },
    commits: { nodes: [{ commit: {
      oid: pr.head, committedDate: pr.headCommittedAt ?? null,
      checkSuites: { pageInfo: { hasNextPage: false }, nodes: [] },
      statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: pr.checks.map((check) => ({
        __typename: "CheckRun", name: check.name, status: check.status, conclusion: check.conclusion, detailsUrl: check.url,
        isRequired: check.required, deployment: null, ...(check.checkRunId ? { databaseId: check.checkRunId } : {}),
        checkSuite: check.run ? { app: { slug: check.app ?? "github-actions" }, workflowRun: { databaseId: check.run.id, event: check.run.event } } : null,
      })) } },
    } }] },
    baseRef: { branchProtectionRule: null, rules: { nodes: [] }, target: { oid: pr.baseHead ?? "b".repeat(40), statusCheckRollup: { contexts: { nodes: [] } } } },
  };
}

export interface FakeCall {
  at: number;
  kind: "graphql" | "rest" | "merge" | "log";
  /** what GitHub charged: points for graphql, one request otherwise */
  cost: number;
  /** PRs a snapshot query read */
  prs: number;
  refused: boolean;
}

const HOUR_MS = 60 * 60_000;

/** The fake. `pr(number)` is what GitHub holds for a PR; the clock is the test's. */
export function fakeGh(options: { clock: { now: number }; pr: (number: number) => PrSnapshot; limit?: number }) {
  const state = {
    limit: options.limit ?? 5000,
    /** points (graphql) and requests (core) spent this hour, by everyone */
    used: { graphql: 0, core: 0 },
    windowStart: options.clock.now,
    calls: [] as FakeCall[],
    /** every call before `until` is refused like this */
    refusal: null as null | { until: number; status: 403 | 429; headers: Record<string, string>; message: string },
    /** the next `gh pr merge` fails with this message */
    refuseMerge: null as string | null,
    merged: new Set<number>(),
    /** PRs GitHub cannot find (deleted, or a number that never existed) */
    missing: new Set<number>(),
  };
  const resetAt = () => state.windowStart + HOUR_MS;
  const roll = () => {
    while (options.clock.now >= resetAt()) {
      state.windowStart = resetAt();
      state.used = { graphql: 0, core: 0 };
    }
  };
  const rateHeaders = (resource: "graphql" | "core"): Record<string, string> => ({
    "X-Ratelimit-Limit": String(state.limit),
    "X-Ratelimit-Remaining": String(Math.max(0, state.limit - state.used[resource])),
    "X-Ratelimit-Reset": String(Math.floor(resetAt() / 1000)),
    "X-Ratelimit-Resource": resource,
    "X-Ratelimit-Used": String(state.used[resource]),
  });
  const reply = (status: number, headers: Record<string, string>, body: unknown, stderr = ""): RunResult => ({
    exitCode: status === 200 && !stderr ? 0 : 1,
    out: `HTTP/2.0 ${status} ${status === 200 ? "OK" : "Forbidden"}\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n${JSON.stringify(body)}`,
    err: stderr, truncated: false, timedOut: false, cancelled: false,
  });

  function graphql(args: string[]): RunResult {
    const query = args.find((arg) => arg.startsWith("query="))!.slice("query=".length);
    const cost = graphqlCost(query);
    const aliased = [...query.matchAll(/p(\d+): pullRequest\(number: (\d+)\)/g)];
    const single = args.find((arg) => arg.startsWith("number="));
    const prs = single ? 1 : aliased.length;
    if (state.used.graphql + cost > state.limit) {
      state.calls.push({ at: options.clock.now, kind: "graphql", cost: 0, prs, refused: true });
      return reply(200, rateHeaders("graphql"), { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." }] }, "gh: API rate limit exceeded for user ID 1.");
    }
    state.used.graphql += cost;
    state.calls.push({ at: options.clock.now, kind: "graphql", cost, prs, refused: false });
    const repository: Record<string, unknown> = { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true, viewerDefaultMergeMethod: "SQUASH" };
    // A PR GitHub cannot find is null in the data, with an error on its own
    // path, and the rest of the answer beside it; gh then exits 1 and prints the message.
    const errors: Record<string, unknown>[] = [];
    const answer = (field: string, number: number) => {
      if (!state.missing.has(number)) return rawPull(options.pr(number));
      errors.push({ type: "NOT_FOUND", path: ["repository", field], message: `Could not resolve to a PullRequest with the number of ${number}.` });
      return null;
    };
    if (single) repository.pullRequest = answer("pullRequest", Number(single.slice("number=".length)));
    for (const [, alias, number] of aliased) repository[`p${alias}`] = answer(`p${alias}`, Number(number));
    for (const [, alias] of query.matchAll(/\b([bt]\d+): pullRequests\(/g)) repository[alias!] = { nodes: [] };
    const rateLimit = { cost, remaining: state.limit - state.used.graphql, limit: state.limit, resetAt: new Date(resetAt()).toISOString() };
    const body = { data: { rateLimit, viewer: { login: "owner" }, repository }, ...(errors.length > 0 ? { errors } : {}) };
    return reply(200, rateHeaders("graphql"), body, errors.map((error) => `gh: ${String(error.message)}`).join("\n"));
  }

  function rest(path: string): RunResult {
    if (state.used.core + 1 > state.limit) {
      state.calls.push({ at: options.clock.now, kind: "rest", cost: 0, prs: 0, refused: true });
      return reply(403, rateHeaders("core"), { message: "API rate limit exceeded for user ID 1." }, "gh: API rate limit exceeded for user ID 1. (HTTP 403)");
    }
    state.used.core += 1;
    state.calls.push({ at: options.clock.now, kind: "rest", cost: 1, prs: 0, refused: false });
    if (/\/rules\/branches\//.test(path)) return reply(200, rateHeaders("core"), []);
    if (/\/branches\//.test(path)) return reply(200, rateHeaders("core"), { protection: { enabled: true, required_status_checks: { contexts: ["test"] } } });
    return reply(404, rateHeaders("core"), { message: "Not Found" }, "gh: Not Found (HTTP 404)");
  }

  async function run(input: RunOptions): Promise<RunResult> {
    roll();
    const cmd = input.cmd;
    const refusal = state.refusal && options.clock.now < state.refusal.until ? state.refusal : null;
    if (refusal) {
      state.calls.push({ at: options.clock.now, kind: cmd.includes("graphql") ? "graphql" : "rest", cost: 0, prs: 0, refused: true });
      return reply(refusal.status, { ...rateHeaders("graphql"), ...refusal.headers }, { message: refusal.message }, `gh: ${refusal.message} (HTTP ${refusal.status})`);
    }
    if (cmd[0] === "gh" && cmd[1] === "api") {
      const args = cmd.slice(2).filter((arg) => arg !== "--include");
      return args[0] === "graphql" ? graphql(args) : rest(args.find((arg) => arg.startsWith("repos/")) ?? "");
    }
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "merge") {
      const refused = state.refuseMerge;
      state.refuseMerge = null;
      state.calls.push({ at: options.clock.now, kind: "merge", cost: refused ? 0 : 1, prs: 1, refused: refused !== null });
      if (refused) return { exitCode: 1, out: "", err: `GraphQL: ${refused} (mergePullRequest)`, truncated: false, timedOut: false, cancelled: false };
      state.merged.add(Number(cmd[3]));
      return { exitCode: 0, out: "", err: "", truncated: false, timedOut: false, cancelled: false };
    }
    throw new Error(`the fake GitHub does not answer ${cmd.slice(0, 3).join(" ")}`);
  }

  /** Wisp's GraphQL points in the hour ending at `at`. */
  const pointsInHourTo = (at: number) =>
    state.calls.filter((call) => call.kind === "graphql" && call.at > at - HOUR_MS && call.at <= at).reduce((sum, call) => sum + call.cost, 0);
  return { state, run, pointsInHourTo };
}
