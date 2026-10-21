/** Portable conversation export; deliberately independent of either client's task model. */
export interface TaskExport {
  format: "wisp-task-export-v1";
  exportedAt: string;
  task: { id: string; title: string };
  turns: unknown[];
  messages: unknown[];
  files: { path: string; dataBase64: string }[];
  missing: string[];
}
export function decodeTaskExport(value: unknown): TaskExport {
  if (!value || typeof value !== "object") throw new Error("Invalid task export response");
  const v = value as Partial<TaskExport>;
  if (v.format !== "wisp-task-export-v1" || typeof v.exportedAt !== "string" ||
      !v.task || typeof v.task.id !== "string" || typeof v.task.title !== "string" ||
      !Array.isArray(v.turns) || !Array.isArray(v.messages) || !Array.isArray(v.files) || !Array.isArray(v.missing) ||
      !v.missing.every(path => typeof path === "string") ||
      !v.files.every(file => file && typeof file.path === "string" && typeof file.dataBase64 === "string")) {
    throw new Error("Wisp returned an incompatible task export. Update the client and daemon, then retry.");
  }
  return v as TaskExport;
}
