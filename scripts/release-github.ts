// GitHub and git reads shared by the release scripts (release:check,
// release:ready, release:closeout). Every GitHub call goes through the `gh` CLI
// the maintainer already uses to open and merge release PRs, so these scripts
// hold no token of their own.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
export const REPOSITORY = "Pepewitch/wisp";
export const TAP_REPOSITORY = "Pepewitch/homebrew-tap";

/**
 * The checks a release commit on main must pass before it is tagged. The tag
 * workflow itself enforces only the two release-candidate checks; requiring
 * the ordinary CI result too means a red main is never published by accident.
 */
export const RELEASE_COMMIT_CHECKS = ["test", "browser-security", "supply-chain", "linux-contract", "update-verifier"] as const;

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function command(cmd: string[], cwd = ROOT): CommandResult {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: result.exitCode === 0,
    stdout: Buffer.from(result.stdout).toString("utf8").trim(),
    stderr: Buffer.from(result.stderr).toString("utf8").trim(),
  };
}

export function run(cmd: string[], cwd = ROOT): string {
  const result = command(cmd, cwd);
  if (!result.ok) throw new Error(`${cmd.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export function git(args: string[]): string {
  return run(["git", ...args]);
}

/** `gh api <path>` parsed as JSON. */
export function ghApi<T>(path: string): T {
  return JSON.parse(run(["gh", "api", path])) as T;
}

/** Like ghApi, but a 404 is an answer ("absent") rather than an error. */
export function ghApiOrNull<T>(path: string): T | null {
  const result = command(["gh", "api", path]);
  if (result.ok) return JSON.parse(result.stdout) as T;
  if (/\b404\b|Not Found/i.test(result.stderr)) return null;
  throw new Error(`gh api ${path} failed: ${result.stderr || result.stdout}`);
}

/** Every element of a paginated list endpoint, e.g. a commit's check runs. */
export function ghApiList<T>(path: string, jq: string): T[] {
  return run(["gh", "api", "--paginate", path, "--jq", jq])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  html_url: string | null;
  app?: { slug?: string } | null;
}

export type CheckState = "passed" | "pending" | "failed" | "missing";

export interface CheckVerdict {
  name: string;
  state: CheckState;
  detail: string;
  url: string | null;
  /** For a failure: the workflow run attempt it failed on. */
  attempt?: number;
}

export interface WorkflowRunState {
  status: string;
  run_attempt: number;
}

/**
 * The latest GitHub Actions run of each required check, read the way the tag
 * workflow's gate reads it: a rerun supersedes the attempt it replaced, and a
 * check reported by any other app does not count.
 */
export function checkVerdicts(runs: readonly CheckRun[], required: readonly string[]): CheckVerdict[] {
  return required.map((name) => {
    const latest = runs
      .filter((entry) => entry.name === name && entry.app?.slug === "github-actions")
      .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""))
      .at(-1);
    if (!latest) return { name, state: "missing", detail: "not reported yet", url: null };
    if (latest.status !== "completed") return { name, state: "pending", detail: latest.status, url: latest.html_url };
    if (latest.conclusion === "success") return { name, state: "passed", detail: "success", url: latest.html_url };
    return { name, state: "failed", detail: latest.conclusion ?? "unknown", url: latest.html_url };
  });
}

export function commitCheckRuns(sha: string): CheckRun[] {
  return ghApiList<CheckRun>(`repos/${REPOSITORY}/commits/${sha}/check-runs?per_page=100`, ".check_runs[]");
}

/** The workflow run id inside a check or job URL, for `gh run rerun`. */
export function actionsRunId(url: string | null): string | null {
  return url?.match(/\/actions\/runs\/(\d+)/)?.[1] ?? null;
}

export function workflowRunState(runId: string): WorkflowRunState {
  return ghApi<WorkflowRunState>(`repos/${REPOSITORY}/actions/runs/${runId}`);
}

/**
 * A failed check whose workflow run is running again is pending: right after
 * `gh run rerun`, the failed attempt is still the newest check run for a few
 * seconds. A failure on attempt 2 or later has already had its one rerun.
 */
export function settleFailures(
  verdicts: readonly CheckVerdict[],
  runState: (runId: string) => WorkflowRunState,
): CheckVerdict[] {
  const states = new Map<string, WorkflowRunState>();
  return verdicts.map((verdict) => {
    const id = verdict.state === "failed" ? actionsRunId(verdict.url) : null;
    if (!id) return verdict;
    let state = states.get(id);
    if (!state) {
      state = runState(id);
      states.set(id, state);
    }
    if (state.status !== "completed") return { ...verdict, state: "pending", detail: "rerun in progress" };
    return { ...verdict, attempt: state.run_attempt };
  });
}

export function formatVerdicts(verdicts: readonly CheckVerdict[]): string {
  const width = Math.max(...verdicts.map((verdict) => verdict.name.length));
  return verdicts
    .map((verdict) => `  ${verdict.state.padEnd(7)} ${verdict.name.padEnd(width)}  ${verdict.state === "passed" ? "" : verdict.detail}`.trimEnd())
    .join("\n");
}

/**
 * What to do about failed checks. A release commit changes only versions and
 * notes, so a failure there is usually a flaky test: rerun it once. A check
 * that fails again after its rerun is a real problem, and rerunning it until
 * it passes would publish on luck.
 */
export function rerunAdvice(verdicts: readonly CheckVerdict[]): string {
  const failed = verdicts.filter((verdict) => verdict.state === "failed");
  const lines = failed.map((verdict) => `  ${verdict.name}: ${verdict.url ?? "no URL reported"}`);
  const repeated = failed.filter((verdict) => (verdict.attempt ?? 1) > 1);
  if (repeated.length > 0) {
    lines.push(
      `${repeated.map((verdict) => verdict.name).join(", ")} failed again after a rerun.`,
      "Stop here and report the failure with the URL above. Do not rerun it again, and do not tag.",
    );
    return lines.join("\n");
  }
  lines.push(
    "Read the failed job's log first: gh run view <run id> --log-failed",
    "If the failure is in code the release did not change, rerun the failed jobs once, then run",
    "this command again (it waits for the rerun):",
  );
  const runs = new Set(failed.map((verdict) => actionsRunId(verdict.url)).filter((id) => id !== null));
  for (const id of runs) lines.push(`  gh run rerun ${id} --failed`);
  return lines.join("\n");
}

export function releaseTags(): string[] {
  return git(["tag", "--list", "v*"]).split(/\r?\n/).filter(Boolean);
}

/** Versions newest first, by semver precedence (an alpha sorts below its release). */
function newestFirst(tags: readonly string[]): string[] {
  return tags.map((tag) => tag.replace(/^v/, "")).sort((a, b) => Bun.semver.order(b, a));
}

/** The newest release older than `version`. */
export function previousRelease(tags: readonly string[], version: string): string | null {
  return newestFirst(tags).find((candidate) => Bun.semver.order(candidate, version) < 0) ?? null;
}

export function latestRelease(tags: readonly string[]): string | null {
  return newestFirst(tags)[0] ?? null;
}

export function remoteTagExists(tag: string): boolean {
  return git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]) !== "";
}

export function localTagExists(tag: string): boolean {
  return git(["tag", "--list", tag]) !== "";
}

/** `docs/v<major>.<minor>/QUALIFICATION.md`, relative to the repository. */
export function ledgerPath(version: string): string {
  const [major, minor] = version.split(".");
  return `docs/v${major}.${minor}/QUALIFICATION.md`;
}

export function minorLine(version: string): string {
  const [major, minor] = version.split(".");
  return `${major}.${minor}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** A public URL read without credentials, the way a user's machine reads it. */
export async function anonymousText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

/** A release version from the command line, or a usage error. */
export function versionArgument(args: readonly string[], usage: string): string {
  const version = args[0];
  if (!version || version.startsWith("-")) throw new Error(`usage: ${usage}`);
  return version.replace(/^v/, "");
}

/** How long a script may wait for GitHub, from `--wait-minutes <n>`. */
export function waitMinutes(args: readonly string[], fallback: number): number {
  const index = args.indexOf("--wait-minutes");
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error("--wait-minutes needs a number of minutes");
  return value;
}
