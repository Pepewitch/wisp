import { wispCommand } from "./command";
import type { CleanupSummary } from "./archive-progress";

export async function cleanupCommand(
  id: string | undefined, flags: Record<string, unknown>,
  request: (path: string, method?: string, body?: unknown) => Promise<unknown>,
): Promise<void> {
  const command = wispCommand();
  if (!id || !/^[a-z0-9]+$/.test(id)) throw new Error(`usage: ${command} cleanup <task> [--log | --retry | --confirm-complete | --rerun] [--verified-stopped]`);
  const actions = [flags.retry && "retry", flags["confirm-complete"] && "confirm", flags.rerun && "rerun"].filter(Boolean);
  if (actions.length > 1) throw new Error("Choose one cleanup action at a time.");
  const path = `/api/tasks/${id}/cleanup`;
  const current = await request(path) as CleanupSummary & { log: string };
  if (actions.length) {
    await request(path, "POST", { action: actions[0], revision: current.revision, confirmStopped: flags["verified-stopped"] === true });
    console.log(`Cleanup decision accepted. Run '${command} cleanup ${id}' to check progress.`);
    return;
  }
  console.log(`${current.state}: ${current.step}`);
  if (current.error) console.log(current.error);
  if (current.retryAt) console.log(`Automatic retry: ${current.retryAt}`);
  if (current.uncertain) {
    console.log(`The script may have already run. Verify its effects, then use '${command} cleanup ${id} --confirm-complete' or explicitly rerun it with '--rerun'.`);
    if (current.confirmStopped) console.log("Verify both cleanup scripts and their children have stopped; add --verified-stopped to acknowledge that check.");
  } else if (current.state !== "complete" && current.state !== "running") console.log(`After fixing the cause: ${command} cleanup ${id} --retry`);
  if (flags.log) console.log(current.log);
}
