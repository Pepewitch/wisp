/**
 * The CLI's subtask parts: `wisp new --subtask/--parent`, `wisp archive
 * --subtasks`, the nested `wisp ls`, and `wisp show`'s family lines. Every
 * rule is the daemon's; the CLI only refuses what it would otherwise send to
 * a daemon that cannot honour it.
 */
import type { ApiSubtask, ApiTaskListItem, TaskDetail } from "../../shared/api/task";
import { api, CliApiError, daemonRequest, exitApi } from "./cli-api";
import type { Flags } from "./cli-args";
import { print, printError } from "./cli-print";
import { wispCommand } from "./command";
import { AGENT_TURN_ENV } from "./turn-input";
import { SUBTASK_KINDS } from "./types";

const COMMAND = wispCommand();

export interface SubtaskFields {
  parentTaskId: string;
  subtaskKind?: string;
  report: boolean;
}

/**
 * The subtask a `wisp new` asks for, or null for a root task. `--subtask`
 * makes the task this runs in the parent and turns reporting on; `--parent`
 * names one, with reporting only on `--report`. Exits on a contradiction.
 */
export function subtaskFlags(flags: Flags, env: Record<string, string | undefined> = process.env): SubtaskFields | null {
  const fail = (message: string): never => {
    printError(message);
    process.exit(1);
  };
  const parent = flags.parent;
  const named = flags.subtask === true || parent !== undefined;
  if (!named) {
    if (flags.report !== undefined || flags.kind !== undefined) fail("--report and --kind need --subtask or --parent <id>");
    return null;
  }
  if (flags.subtask === true && parent !== undefined) fail("use --subtask (this task is the parent) or --parent <id>, not both");
  if (parent !== undefined && typeof parent !== "string") fail("--parent requires a task id");
  if (flags.kind !== undefined && !(SUBTASK_KINDS as readonly unknown[]).includes(flags.kind)) fail(`--kind must be one of ${SUBTASK_KINDS.join(", ")}`);
  const own = env.WISP_TASK_ID?.trim();
  if (flags.subtask === true && !own) fail("--subtask works inside a Wisp task, where WISP_TASK_ID names it; elsewhere use --parent <id>");
  const parentTaskId = flags.subtask === true ? own! : (parent as string);
  // a courtesy, not a rule: an agent making subtasks for someone else's task is usually a mistake
  if (env[AGENT_TURN_ENV] === "1" && own && parentTaskId !== own) printError(`warning: --parent ${parentTaskId} is not this task (${own})`);
  return {
    parentTaskId,
    ...(typeof flags.kind === "string" ? { subtaskKind: flags.kind } : {}),
    report: flags.subtask === true || flags.report === true,
  };
}

/** Refuse before sending (or uploading anything) when the daemon cannot make subtasks: never a silent root task. */
export async function requireSubtasks(): Promise<void> {
  let features: Record<string, unknown> = {};
  try {
    features = ((await daemonRequest("/api/harnesses")) as { features?: Record<string, unknown> }).features ?? {};
  } catch (error) {
    exitApi(error);
  }
  if (features.subtasks !== true) {
    printError("this daemon does not make subtasks: it is older than this CLI, or the feature is off");
    process.exit(1);
  }
}

/** `wisp ls`: one line per task, as before, each child under its parent. */
export function nestedTasks(tasks: ApiTaskListItem[]): { task: ApiTaskListItem; depth: number }[] {
  const listed = new Set(tasks.map((task) => task.id));
  const children = new Map<string, ApiTaskListItem[]>();
  for (const task of tasks) {
    if (task.parent_task_id && listed.has(task.parent_task_id)) children.set(task.parent_task_id, [...(children.get(task.parent_task_id) ?? []), task]);
  }
  const out: { task: ApiTaskListItem; depth: number }[] = [];
  const visit = (task: ApiTaskListItem, depth: number): void => {
    out.push({ task, depth });
    for (const child of children.get(task.id) ?? []) visit(child, depth + 1);
  };
  for (const task of tasks) if (!task.parent_task_id || !listed.has(task.parent_task_id)) visit(task, 0);
  return out;
}

/** `wisp show`'s family lines; silent for a root task without children and on a daemon from before subtasks. */
export async function printFamily(task: TaskDetail): Promise<void> {
  if (!("parent_task_id" in task)) return;
  if (task.subtask_kind) {
    const parent = task.parent_task_id ?? "deleted";
    print(`parent: ${parent}   subtask: ${task.subtask_kind}${task.base_from ? `, base from ${task.base_from}` : ""}${task.report_to_parent ? ", reports to its parent" : ""}`);
  }
  let children: ApiSubtask[];
  try {
    children = (await daemonRequest(`/api/tasks/${task.id}/subtasks`)) as ApiSubtask[];
  } catch {
    return;
  }
  if (children.length === 0) return;
  print("subtasks:");
  for (const child of children) {
    const what = child.reviewer ? "reviewer" : child.kind ?? "subtask";
    print(`  ${child.id}  ${child.archived ? "archived" : child.state}  ${what}  ${child.title.slice(0, 50)}`);
  }
}

/** `wisp archive <id> [--force] [--subtasks archive|force]` */
export async function archiveCommand(id: string | undefined, flags: Flags): Promise<void> {
  if (!id) {
    printError(`usage: ${COMMAND} archive <id> [--force] [--subtasks archive|force]`);
    process.exit(1);
  }
  const subtasks = flags.subtasks;
  if (subtasks !== undefined && subtasks !== "archive" && subtasks !== "force") {
    printError("--subtasks takes archive or force");
    process.exit(1);
  }
  if (subtasks !== undefined) {
    await requireSubtasks();
    const live = ((await api(`/api/tasks/${id}/subtasks`)) as ApiSubtask[]).filter((child) => !child.archived && !child.reviewer);
    if (live.length > 0) print(`${subtasks === "force" ? "force-archiving" : "archiving"} with it: ${live.map((child) => `${child.id} (${child.kind ?? "subtask"})`).join(", ")}`);
  }
  let data: { branch: string | null; note: string | null; subtasks?: string[] };
  try {
    data = await daemonRequest(`/api/tasks/${id}/archive`, "POST", JSON.stringify({
      force: flags.force === true || flags.f === true,
      ...(subtasks !== undefined ? { subtasks } : {}),
    }));
  } catch (error) {
    const refused = error instanceof CliApiError ? error.data?.refusedSubtasks : undefined;
    if (!Array.isArray(refused)) exitApi(error);
    printError(`error: ${(error as Error).message}`);
    for (const child of refused as { id: string; title: string; error: string }[]) printError(`  ${child.id}  ${child.title.slice(0, 40)} — ${child.error}`);
    if (subtasks === undefined) printError(`archive them with it: ${COMMAND} archive ${id} --subtasks archive (or force)`);
    process.exit(1);
  }
  const more = data.subtasks?.length ? ` with ${data.subtasks.length} subtask${data.subtasks.length === 1 ? "" : "s"}` : "";
  print(`archived${more} (branch ${data.branch} kept); cleanup continues in the background. Check: ${COMMAND} cleanup ${id}`);
  // the teardown finishes in the background, so anything it decided NOT to
  // delete has to be said here — the user needs to know where their files are
  if (data.note) print(data.note);
}
