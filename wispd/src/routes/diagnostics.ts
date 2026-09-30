import { currentDaemonRun, runTimes } from "../daemon-run";
import { githubBudget, type GitHubBudgetReport } from "../github-budget";
import { loopHealth, type LoopHealth } from "../home-lifetime";
import { outboxSummary, type OutboxSummary } from "../store";
import { json } from "./http";

/** What `wisp doctor` asks the running daemon, since only it knows these. */
export interface DaemonDiagnostics {
  pid: number;
  startedAt: string | null;
  uptimeSeconds: number | null;
  /** Each background loop's latest outcome in this process. */
  loops: LoopHealth[];
  webhooks: OutboxSummary;
  /** Wisp's GitHub spend over the last hour, what GitHub reports is left, and any pause. */
  github: GitHubBudgetReport;
}

/** GET /api/diagnostics: authenticated like every other /api route. */
export function diagnosticsRoute(now: Date = new Date()): Response {
  const run = currentDaemonRun();
  const report: DaemonDiagnostics = {
    pid: process.pid,
    ...(run ? runTimes(run, now) : { startedAt: null, uptimeSeconds: null }),
    loops: loopHealth(),
    webhooks: outboxSummary(),
    github: githubBudget.report(),
  };
  return json(report, 200, { "cache-control": "private, no-store" });
}
