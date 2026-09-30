import { platform } from "node:os";
import { wispCommand } from "./command";
import { DAEMON_EXITS_PATH, recentUncleanExits, uncleanExits } from "./daemon-run";
import type { DoctorCheck } from "./doctor";
import { clockTime, type GitHubBudgetReport } from "./github-budget";
import type { DaemonDiagnostics } from "./routes/diagnostics";
import { trunc } from "./text";
import { readUpdateAttempt, UPDATE_RECORD_PATH } from "./update-record";

/**
 * The doctor checks about what already happened to the daemon: restarts it
 * did not ask for, the last self-update, and its background work. Kept beside
 * doctor.ts, which runs them, because that file is at its size limit.
 */
const COMMAND = wispCommand();
const ok = (name: string, message: string): DoctorCheck => ({ name, status: "ok", message });
const warn = (name: string, message: string): DoctorCheck => ({ name, status: "warn", message });

/** Where the installed daemon's own log goes, for a finding that needs reading it. */
export function daemonLogHint(currentPlatform: NodeJS.Platform = platform()): string {
  if (currentPlatform === "darwin") return "$(brew --prefix)/var/log/wisp.log";
  if (currentPlatform === "linux") return "journalctl --user -u wisp.service";
  return "the daemon's stderr";
}

const CRASH_LOOP_WINDOW_MS = 60 * 60_000;

/**
 * Restarts nobody asked for. The service manager brings a crashed daemon back
 * within seconds and boot recovery hides the rest, so the run markers the
 * daemon leaves (see daemon-run.ts) are the only trace. Two or more in an hour
 * is a crash loop.
 */
export function checkRestarts(
  exitsPath: string = DAEMON_EXITS_PATH,
  now: Date = new Date(),
  currentPlatform: NodeJS.Platform = platform(),
): DoctorCheck {
  const exits = uncleanExits(exitsPath);
  const recent = recentUncleanExits(exits, now, CRASH_LOOP_WINDOW_MS);
  const latest = exits.at(-1);
  if (recent.length >= 2) {
    return warn(
      "restarts",
      `${recent.length} unclean daemon exits in the last hour (latest: pid ${latest!.pid}, ${latest!.version}, started ${latest!.startedAt}) — it is crash-looping; read ${daemonLogHint(currentPlatform)}`,
    );
  }
  if (!latest) return ok("restarts", "no unclean daemon exit recorded");
  return ok("restarts", `last unclean exit found ${latest.detectedAt} (pid ${latest.pid}, ${latest.version})`);
}

/** An update still `installing` this long after it started never finished; the command timeout is 15 min. */
const UPDATE_STALE_MS = 20 * 60_000;

/** The last self-update this home ran, when there was one. */
export function checkLastUpdate(recordPath: string = UPDATE_RECORD_PATH, now: Date = new Date()): DoctorCheck | null {
  const attempt = readUpdateAttempt(recordPath);
  if (!attempt) return null;
  const route = `${attempt.fromVersion} → ${attempt.toVersion}`;
  if (attempt.outcome === "failed") {
    return warn("last update", `${route} failed at ${attempt.finishedAt ?? attempt.startedAt}: ${trunc(attempt.error ?? "unknown error", 300)}`);
  }
  if (attempt.outcome === "installing") {
    const age = now.getTime() - Date.parse(attempt.startedAt);
    return age > UPDATE_STALE_MS
      ? warn("last update", `${route} started ${attempt.startedAt} and never finished — the daemon stopped mid-update; check '${COMMAND} version' and the service`)
      : ok("last update", `${route} in progress since ${attempt.startedAt}`);
  }
  return ok("last update", `${route} installed ${attempt.finishedAt ?? attempt.startedAt}`);
}

/** A loop with no successful pass in this long is reported as stalled; every loop runs at least once a minute. */
const LOOP_STALE_MS = 15 * 60_000;

function ageText(ms: number): string {
  if (ms < 90_000) return `${Math.max(0, Math.round(ms / 1000))} s ago`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} min ago`;
  return `${Math.round(ms / 3_600_000)} h ago`;
}

/**
 * Background work, as the RUNNING daemon sees it: the last successful pass of
 * each loop, and webhook events that are failing or were given up on. Both
 * live only in the daemon, so it is asked (authenticated) rather than guessed.
 */
export async function checkDaemonDiagnostics(
  cfg: { host: string; port: number; token: string },
  fetchFn: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<DoctorCheck[]> {
  const url = `http://${cfg.host}:${cfg.port}/api/diagnostics`;
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(2000) });
  } catch {
    return [warn("background loops", `could not ask the daemon (GET ${url})`)];
  }
  if (response.status === 404) {
    return [warn("background loops", "the running daemon does not report its background work yet — restart it to pick up this build")];
  }
  if (!response.ok) return [warn("background loops", `GET ${url} returned ${response.status}`)];
  const report = (await response.json().catch(() => null)) as Partial<DaemonDiagnostics> | null;
  if (!report || !Array.isArray(report.loops) || !report.webhooks) {
    return [warn("background loops", `GET ${url} did not return a diagnostics report`)];
  }
  const checks: DoctorCheck[] = [];
  const uptimeMs = typeof report.uptimeSeconds === "number" ? report.uptimeSeconds * 1000 : 0;
  const failing: string[] = [];
  const stalled: string[] = [];
  const healthy: string[] = [];
  for (const loop of report.loops) {
    const success = loop.lastSuccessAt ? now.getTime() - Date.parse(loop.lastSuccessAt) : null;
    if (loop.consecutiveFailures > 0) {
      failing.push(`${loop.name} failed ${loop.consecutiveFailures} pass${loop.consecutiveFailures === 1 ? "" : "es"} in a row: ${trunc(loop.lastError ?? "unknown error", 160)}`);
    } else if ((success ?? uptimeMs) > LOOP_STALE_MS) {
      stalled.push(`${loop.name} (last success ${success === null ? "never" : ageText(success)})`);
    } else healthy.push(`${loop.name} ${success === null ? "not yet" : ageText(success)}`);
  }
  if (failing.length > 0 || stalled.length > 0) {
    const parts = [...failing, ...(stalled.length > 0 ? [`stalled: ${stalled.join(", ")}`] : [])];
    checks.push(warn("background loops", `${parts.join("; ")} — read ${daemonLogHint()}`));
  } else {
    checks.push(ok("background loops", healthy.length > 0 ? `last success: ${healthy.join(", ")}` : "none has run yet"));
  }
  const hooks = report.webhooks;
  if (hooks.failing > 0 || hooks.dead > 0) {
    const counts = [
      hooks.failing > 0 ? `${hooks.failing} failing and still retried` : null,
      hooks.dead > 0 ? `${hooks.dead} given up on` : null,
    ].filter((part): part is string => part !== null);
    checks.push(
      warn(
        "webhooks",
        `undelivered webhook events: ${counts.join(", ")}${hooks.oldestAt ? ` (oldest ${hooks.oldestAt})` : ""}${hooks.lastError ? `; last error: ${trunc(hooks.lastError, 200)}` : ""} — see GET /api/outbox`,
      ),
    );
  } else checks.push(ok("webhooks", "no failing deliveries"));
  const github = githubBudgetCheck(report.github, now);
  if (github) checks.push(github);
  return checks;
}

const PAUSE_WHY = {
  primary: "GitHub's hourly rate limit is used up",
  secondary: "GitHub's secondary rate limit (too many requests too fast)",
  share: "Wisp's own share of the hourly limit is used up",
} as const;

/**
 * Wisp's GitHub spend over the last hour against its share, what GitHub
 * reports is left of the hour (everyone's use), and any pause. Absent from a
 * daemon older than this build: then nothing is said.
 */
export function githubBudgetCheck(report: GitHubBudgetReport | undefined, now: Date = new Date()): DoctorCheck | null {
  if (!report || !Array.isArray(report.resources)) return null;
  const unit = (resource: string) => (resource === "graphql" ? "GraphQL points" : "REST requests");
  const spent = report.resources.map((entry) => `${entry.spentLastHour} of ${entry.cap} ${unit(entry.resource)}`).join(" and ");
  const current = report.resources.filter((entry) =>
    entry.limit !== null && entry.remaining !== null && entry.resetAt !== null && Date.parse(entry.resetAt) > now.getTime());
  const left = current.map((entry) => `${entry.remaining} of ${entry.limit} ${unit(entry.resource)} left until ${clockTime(Date.parse(entry.resetAt!))}`);
  const summary = `Wisp spent ${spent} of its ${Math.round(report.share * 100)}% share in the last hour; ${
    left.length > 0 ? `GitHub reports ${left.join(", ")}` : "GitHub has reported no limits yet"}`;
  const slowed = report.stretch > 1 ? `; Wisp is spacing its checks ×${report.stretch.toFixed(1)}` : "";
  const paused = report.resources.flatMap((entry) => (entry.paused ? [{ ...entry.paused, resource: entry.resource }] : []));
  if (paused.length > 0) {
    // a secondary limit pauses both: say it once
    const said = paused[0]!.why === "secondary"
      ? [{ ...paused[0]!, what: "all GitHub calls" }]
      : paused.map((entry) => ({ ...entry, what: `${entry.resource === "graphql" ? "GraphQL" : "REST"} calls` }));
    const parts = said.map((entry) => `${entry.what} paused until ${clockTime(Date.parse(entry.until))}: ${PAUSE_WHY[entry.why]}`);
    return warn("github budget", `${parts.join("; ")} — ${summary}`);
  }
  const low = current.some((entry) => entry.remaining! < report.floor * entry.limit!);
  return low
    ? warn("github budget", `GitHub's hourly limit is running low (other tools count too) — ${summary}${slowed}`)
    : ok("github budget", `${summary}${slowed}`);
}
