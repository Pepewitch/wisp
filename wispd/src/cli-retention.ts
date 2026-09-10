import { decodeTaskExport } from "../../shared/task-export";
import { wispCommand } from "./command";
import type { PurgePlan, PurgeResult } from "./bulk-purge";
import { archivedBefore, storageBytes } from "./storage-scan";

async function bulkPurgeCommand(flags: Record<string, unknown>, request: (path: string, method?: string, body?: unknown) => Promise<unknown>): Promise<void> {
  const before = flags["archived-before"];
  archivedBefore(before);
  const count = flags["confirm-count"];
  if (count !== undefined && (typeof count !== "string" || !/^(0|[1-9]\d*)$/.test(count) || !Number.isSafeInteger(Number(count)))) {
    throw new Error("--confirm-count must be a nonnegative integer matching the dry run");
  }
  const plan = await request(`/api/purge?archivedBefore=${encodeURIComponent(String(before))}`) as PurgePlan;
  console.log(`Archived tasks last updated before ${plan.cutoff}:`);
  for (const task of plan.tasks) console.log(`  ${task.id}  ${task.bytes === null ? "unknown bytes" : `${task.bytes} bytes (${storageBytes(task.bytes)})`}  ${JSON.stringify(task.title)}${task.error ? `  refused: ${task.error}` : ""}`);
  console.log(`${plan.tasks.length} tasks; ${plan.bytes} known file bytes (${storageBytes(plan.bytes)}). Worktrees and SQLite pages excluded.`);
  if (count === undefined) {
    console.log(`Dry run: nothing deleted. Export anything to keep, then repeat with --confirm-count ${plan.tasks.length}.`);
    return;
  }
  if (Number(count) !== plan.tasks.length) throw new Error(`Stale --confirm-count: expected ${plan.tasks.length}; nothing deleted. Run the dry run again.`);
  const result = await request("/api/purge", "DELETE", { cutoff: plan.cutoff, confirmCount: Number(count), fingerprint: plan.fingerprint }) as PurgeResult;
  console.log(`Purged ${result.purged.length} tasks; reclaimed ${result.reclaimedBytes} file bytes (${storageBytes(result.reclaimedBytes)}).`);
  for (const failure of result.failed) console.error(`Failed ${failure.id}: ${failure.error}`);
  if (result.failed.length) throw new Error(`${result.failed.length} tasks could not be purged. Fix the named failures and run the dry run again.`);
}

export async function retentionCommand(
  action: "export" | "purge", id: string | undefined, flags: Record<string, unknown>,
  request: (path: string, method?: string, body?: unknown) => Promise<unknown>,
): Promise<void> {
  const command = wispCommand();
  if (flags["archived-before"] !== undefined || flags["confirm-count"] !== undefined) {
    if (action !== "purge" || id || flags.confirm !== undefined) throw new Error("Bulk purge cannot be combined with a task ID, --confirm, or export.");
    return bulkPurgeCommand(flags, request);
  }
  if (!id || !/^[a-z0-9]+$/.test(id)) throw new Error(`usage: ${command} ${action} <task>`);
  if (action === "export") {
    const data = decodeTaskExport(await request(`/api/tasks/${id}/export`));
    if (data.task.id !== id) throw new Error("The export does not match this task. Refresh and retry.");
    console.log(JSON.stringify(data, null, 2));
    if (data.missing.length) console.error(`${data.missing.length} unavailable files are listed in the export.`);
    return;
  }
  if (flags.confirm !== id) throw new Error(`Export anything you want to keep first, then use: ${command} purge ${id} --confirm ${id}`);
  await request(`/api/tasks/${id}/purge`, "DELETE", { confirmTaskId: id });
  console.log("Wisp task data permanently deleted; repository and Git branches kept.");
}
