import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR } from "./config";
import { PROCESS_BOOT_ID } from "./process-boot";
import { processSnapshot } from "./process-snapshot";
import { runBounded } from "./subprocess";
import { assertWorkingDirectoryAllowed } from "./launch-policy";
import { cleanupProgress, updateProgress, type CleanupProgress } from "./archive-progress";
import type { ArchiveCleanupJob } from "./archive-jobs";

/** Do not delete a workspace or repeat a hook while its old group still exists. */
export async function assertCleanupHookEnded(p: CleanupProgress): Promise<void> {
  if (p.hook_pgid === null) return;
  if (p.hook_boot !== null && PROCESS_BOOT_ID !== null && p.hook_boot !== PROCESS_BOOT_ID) return;
  let present: boolean;
  try { present = (await processSnapshot(new Set([p.hook_pgid]))).length > 0; }
  catch { throw new Error("Wisp cannot check whether the cleanup script has stopped. Check processes on the machine running Wisp, then try again. The workspace is preserved."); }
  if (present) throw new Error(`Wisp cannot confirm the previous cleanup script has stopped: process group ${p.hook_pgid} is still present. Inspect it on the machine running Wisp and wait for the script and its children to finish, then try again. The workspace is preserved.`);
}

export async function runCleanupHook(job: ArchiveCleanupJob, script: string | null): Promise<void> {
  if (!script) return;
  assertWorkingDirectoryAllowed(job.worktree_path!, "archive cleanup script");
  const result = await runBounded({
    env: {}, // Bun subprocesses need an explicit copy of runtime profile overrides.
    cmd: cleanupProgress(job.task_id)?.phase === "repo-hook"
      ? ["bash", join(job.worktree_path!, ".wisp", "cleanup.sh")] : ["bash", "-c", script], cwd: job.worktree_path!, timeoutMs: job.timeout_minutes * 60_000,
    maxBytes: 1024 * 1024, maxErrorBytes: 64 * 1024,
    beforeStart: pid => {
      updateProgress(job.task_id, { hook_pgid: pid, hook_boot: PROCESS_BOOT_ID });
      writeFileSync(join(LOG_DIR, `${job.task_id}-archive.log`), `${cleanupProgress(job.task_id)?.phase} started. Output is captured when the command settles.\n`, { mode: 0o600 });
    },
  });
  appendFileSync(join(LOG_DIR, `${job.task_id}-archive.log`), `\n${cleanupProgress(job.task_id)?.phase}: exit ${result.exitCode}\n${result.out}\n${result.err}\n`, { mode: 0o600 });
  await assertCleanupHookEnded(cleanupProgress(job.task_id)!);
  if (result.exitCode !== 0 || result.timedOut || result.truncated || result.cleanupError) {
    const reason = result.cleanupError ?? (result.timedOut ? "timed out" : result.truncated ? "exceeded the output limit" : `exited ${result.exitCode}`);
    throw new Error(`Cleanup script ${reason}. It may have partially completed. Review the script's effects and archive log before confirming completion or rerunning it.`);
  }
}
