import { decodeTaskExport } from "../../shared/task-export";
import { wispCommand } from "./command";

export async function retentionCommand(
  action: "export" | "purge", id: string | undefined, flags: Record<string, unknown>,
  request: (path: string, method?: string, body?: unknown) => Promise<unknown>,
): Promise<void> {
  const command = wispCommand();
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
