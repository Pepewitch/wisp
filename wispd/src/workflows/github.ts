import { createHash } from "node:crypto";
import { runBounded } from "../subprocess";
import { isRecord } from "../validate";
import { parsePrUrl } from "./definitions";

export interface ReviewFeedback {
  id: string;
  author: string;
  bot: boolean;
  body: string;
  url: string;
  updatedAt: string;
  fingerprint: string;
}
export interface WorkflowPr {
  url: string;
  head: string;
  closed: boolean;
  merged: boolean;
  viewer: string;
  checks: { id: string; name: string; state: "pending" | "passed" | "failed" | "unknown"; url: string }[];
  feedback: ReviewFeedback[];
}
export type WorkflowPrSource = (url: string, reviews: boolean, cwd: string, signal: AbortSignal) => Promise<WorkflowPr>;
export type WorkflowGitHubReader = (path: string, cwd: string, signal: AbortSignal) => Promise<unknown>;
export const fingerprint = (input: unknown): string => createHash("sha256").update(JSON.stringify(input)).digest("hex");

async function github(path: string, cwd: string, signal: AbortSignal): Promise<unknown> {
  const result = await runBounded({
    cmd: ["gh", "api", "--hostname", "github.com", "-H", "Accept: application/vnd.github+json", path],
    cwd, signal, timeoutMs: 15_000, maxBytes: 2_000_000, maxErrorBytes: 2000,
    env: { GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
  });
  if (result.exitCode !== 0 || result.truncated || result.timedOut || result.cancelled || result.cleanupError) {
    throw new Error("GitHub check unavailable. Verify gh authentication and network access.");
  }
  return JSON.parse(result.out);
}
async function pages(path: string, cwd: string, signal: AbortSignal, read: WorkflowGitHubReader, field?: string): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let page = 1; page <= 5; page++) {
    const raw = await read(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, cwd, signal);
    const entries = field && isRecord(raw) ? raw[field] : raw;
    if (!Array.isArray(entries) || !entries.every(isRecord)) throw new Error("GitHub returned incomplete workflow evidence");
    all.push(...entries);
    if (entries.length < 100) return all;
  }
  throw new Error("PR evidence exceeds 500 entries; narrow the PR before resuming automation");
}
function requiredString(raw: unknown, name: string): string {
  if (typeof raw !== "string" || !raw) throw new Error(`GitHub response is missing ${name}`);
  return raw;
}
function checkRun(raw: Record<string, unknown>): WorkflowPr["checks"][number] {
  const status = requiredString(raw.status, "check status");
  const conclusion = raw.conclusion;
  const failed = ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(String(conclusion));
  const passed = ["success", "neutral", "skipped"].includes(String(conclusion));
  return {
    id: `check:${raw.id}:${String(raw.completed_at ?? raw.started_at)}`,
    name: requiredString(raw.name, "check name"),
    state: status !== "completed" ? "pending" : failed ? "failed" : passed ? "passed" : "unknown",
    url: typeof raw.html_url === "string" ? raw.html_url : "",
  };
}
function statusCheck(raw: Record<string, unknown>): WorkflowPr["checks"][number] {
  return {
    id: `status:${raw.id}`,
    name: requiredString(raw.context, "status context"),
    state: raw.state === "success" ? "passed" : ["failure", "error"].includes(String(raw.state)) ? "failed" : raw.state === "pending" ? "pending" : "unknown",
    url: typeof raw.target_url === "string" ? raw.target_url : "",
  };
}
function feedback(raw: Record<string, unknown>, kind: string): ReviewFeedback | null {
  // Pending reviews are not published feedback. Empty approvals carry no nits.
  if (raw.state === "PENDING" || typeof raw.body !== "string" || !raw.body.trim()) return null;
  const user = isRecord(raw.user) ? raw.user : {};
  const author = requiredString(user.login, "feedback author");
  const updatedAt = requiredString(raw.updated_at ?? raw.submitted_at ?? raw.created_at, "feedback timestamp");
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error("Invalid feedback timestamp");
  const id = `${kind}:${requiredString(String(raw.id ?? ""), "feedback ID")}`;
  return {
    id, author, bot: user.type === "Bot" || author.endsWith("[bot]"),
    body: raw.body.slice(0, 3000), url: requiredString(raw.html_url, "feedback URL"), updatedAt,
    fingerprint: fingerprint([id, updatedAt, raw.body, raw.state]),
  };
}
export function createWorkflowPrSource(read: WorkflowGitHubReader = github): WorkflowPrSource {
  return (url, reviews, cwd, signal) => readSnapshot(read, url, reviews, cwd, signal);
}
async function readSnapshot(read: WorkflowGitHubReader, url: string, reviews: boolean, cwd: string, signal: AbortSignal): Promise<WorkflowPr> {
  const target = parsePrUrl(url), repo = `repos/${target.owner}/${target.repo}`;
  const path = `${repo}/pulls/${target.number}`;
  const raw = await read(path, cwd, signal);
  if (!isRecord(raw) || !isRecord(raw.head) || !["open", "closed"].includes(String(raw.state))) throw new Error("GitHub returned an invalid PR");
  const head = requiredString(raw.head.sha, "head SHA");
  if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new Error("Invalid PR head SHA");
  const result: WorkflowPr = { url: target.url, head, closed: raw.state === "closed", merged: raw.merged === true, viewer: "", checks: [], feedback: [] };
  if (result.closed) return result;
  if (reviews) {
    const [viewer, reviewRows, inline, comments] = await Promise.all([
      read("user", cwd, signal),
      pages(`${path}/reviews`, cwd, signal, read),
      pages(`${path}/comments`, cwd, signal, read),
      pages(`${repo}/issues/${target.number}/comments`, cwd, signal, read),
    ]);
    result.viewer = requiredString(isRecord(viewer) ? viewer.login : null, "authenticated user");
    result.feedback = [
      ...reviewRows.map(v => feedback(v, "review")),
      ...inline.map(v => feedback(v, "inline")),
      ...comments.map(v => feedback(v, "comment")),
    ].filter((v): v is ReviewFeedback => v !== null);
  } else {
    const [runs, statuses] = await Promise.all([
      pages(`${repo}/commits/${head}/check-runs?filter=latest`, cwd, signal, read, "check_runs"),
      pages(`${repo}/commits/${head}/status`, cwd, signal, read, "statuses"),
    ]);
    result.checks = [...runs.map(checkRun), ...statuses.map(statusCheck)];
  }
  const latest = await read(path, cwd, signal);
  if (!isRecord(latest) || !isRecord(latest.head) || latest.head.sha !== head || latest.state !== raw.state) {
    throw new Error("PR changed during the check; waiting for a consistent snapshot");
  }
  return result;
}
export const readWorkflowPr = createWorkflowPrSource();
