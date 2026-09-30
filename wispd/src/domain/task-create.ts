/**
 * Creating a task: every rule between "these are the fields" and "the row
 * exists and its launch is running". The HTTP route parses the request into a
 * NewTaskInput and maps the refusal back to a status; nothing here knows it
 * was a request, so any caller gets the same admission, audit and launch.
 */
import { resolve } from "node:path";
import type { AutopilotStatus } from "../../../shared/autopilot";
import { wispDefaultModel, type AdapterDef } from "../adapters";
import {
  AttachError,
  decodeAttachments,
  releaseDecodedAttachments,
  type DecodedAttachment,
} from "../attachments";
import { autopilotStatus, setAutopilot } from "../autopilot/store";
import { resolveHarnessDefaults, type WispConfig } from "../config";
import { pathExists } from "../fsutil";
import { backgroundPass } from "../home-lifetime";
import { isProjectRemovalInProgress } from "../project-removals";
import { createTask, freeSlot, listTasks, newTaskId } from "../store";
import { assertTaskCapacity, reserveTaskCapacity, TaskCapacityError } from "../task-admission";
import { autopilotSwitchDetail, recordAudit, type TaskAuditActor } from "../task-audit";
import { TASK_TITLE_MAX } from "../task-update";
import { taskMode, type Task, type TaskMode } from "../types";
import type { ModelProbeCache } from "../model-probes";
import { launchTask } from "./task-launch";

export interface NewTaskInput {
  repoPath: string;
  /** the caller's own words; the title is cut from these */
  prompt: string;
  /** what the first turn is sent, when it is more than `prompt` (a suffix prompt) */
  firstTurnPrompt?: string;
  harness: string;
  /** explicit values win over config harnessDefaults, then Wisp's default, then the harness's own */
  model?: string;
  effort?: string;
  fast: boolean;
  brief: boolean;
  mode: TaskMode;
  /** the ref a worktree task forks from, instead of the project's */
  base?: string;
  /** turn-1 attachments as they arrived, validated here against the harness */
  attachments?: unknown;
  autopilot?: { autoMerge: boolean; autoFix: boolean };
  /** who asked, for the task audit */
  actor: TaskAuditActor;
}

/**
 * Why a task was not created. `attachment` keeps the status its own error
 * chose (an expired upload is not the same failure as a bad one).
 */
export type NewTaskRefusal =
  | { kind: "invalid" | "conflict" | "at-capacity" | "no-free-id"; error: string }
  | { kind: "attachment"; error: string; status: number };

export interface NewTask {
  task: Task;
  /** what took of the requested auto-merge / auto-fix */
  autopilot: AutopilotStatus;
}

const refuse = (kind: Exclude<NewTaskRefusal["kind"], "attachment">, error: string): NewTaskRefusal => ({ kind, error });

/** A choice the chosen harness cannot honour is refused by name, never silently dropped. */
function unsupportedRequest(
  def: AdapterDef,
  harness: string,
  asked: { effort: string | null; fast: boolean; brief: boolean },
): string | null {
  if (asked.effort !== null && !def.effort) return `harness '${harness}' has no effort support`;
  if (asked.fast && !def.fastMode) return `harness '${harness}' has no fast mode`;
  if (asked.brief && def.briefs !== true) return `harness '${harness}' can't write task briefs`;
  return null;
}

/**
 * Two local tasks in one repo means two agents editing the SAME files with
 * no isolation between them — the exact hazard worktrees exist to remove.
 * Refuse by name so the fix is obvious. (Worktree tasks are isolated by
 * construction; the global admission limit still applies.)
 */
function localTaskRefusal(input: NewTaskInput): NewTaskRefusal | null {
  if (input.mode !== "local") return null;
  // A local task adopts the branch the checkout is already on; there is
  // nothing to fork, so a base could only be honoured by moving the user's
  // own working copy. Refuse the combination instead of ignoring half of it.
  if (input.base !== undefined) {
    return refuse("invalid", "base applies to worktree tasks only — a local task runs on the checkout's current branch");
  }
  if (input.autopilot?.autoMerge || input.autopilot?.autoFix) {
    return refuse("invalid", "auto-merge and auto-fix need a worktree task — a local task runs on the checkout's own branch");
  }
  const repo = resolve(input.repoPath);
  const live = listTasks(false).find((t) => taskMode(t) === "local" && resolve(t.repo_path) === repo);
  if (!live) return null;
  return refuse(
    "conflict",
    `task ${live.id} is already running locally in ${repo} — archive it first, or create this one as a worktree task`,
  );
}

/**
 * Armed before the first turn starts, so that turn already carries the
 * auto-merge note. Never fatal: the task row already exists, and failing the
 * create here would strand it in `creating`. The result says what took.
 */
function armRequestedAutopilot(taskId: string, requested: NewTaskInput["autopilot"], actor: TaskAuditActor): void {
  if (!requested || (!requested.autoMerge && !requested.autoFix)) return;
  try {
    const armed = setAutopilot(taskId, { autoMerge: requested.autoMerge, autoFix: requested.autoFix });
    const detail = autopilotSwitchDetail(null, armed);
    if (detail) recordAudit(taskId, "autopilot", actor, detail);
  } catch (error) {
    console.warn(`[wisp] task ${taskId}: could not arm auto-merge: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** L4: 5-char ids are birthday-bound (~1.7% collision at 1k tasks), so retry on a UNIQUE violation. */
function insertTaskRow(input: NewTaskInput, model: string | null, effort: string | null): Task | null {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return createTask({
        id: newTaskId(),
        title: input.prompt.slice(0, TASK_TITLE_MAX),
        repo_path: input.repoPath,
        harness: input.harness,
        model,
        effort,
        fast: input.fast,
        mode: input.mode,
        brief: input.brief,
        slot: freeSlot(),
      });
    } catch (e) {
      if (!String(e instanceof Error ? e.message : e).includes("UNIQUE constraint")) throw e;
    }
  }
  return null;
}

/**
 * Persist the task, record who created it, arm any requested autopilot, and
 * hand the worktree, setup and first turn to launchTask in the background
 * (spawn contract rule 1: the row exists before anything is spawned).
 *
 * Every refusal happens before the row exists, so a refused create leaves no
 * task and no staged attachment behind.
 */
export async function createAndLaunchTask(
  input: NewTaskInput,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
  /** The daemon's probe cache; null only where there is none (Wisp's default then never applies to a probed harness). */
  models: ModelProbeCache | null,
): Promise<NewTask | NewTaskRefusal> {
  const { repoPath, harness } = input;
  const def = adapters[harness];
  if (!def) return refuse("invalid", `unknown harness '${harness}' (known: ${Object.keys(adapters).join(", ")})`);
  if (!(await pathExists(repoPath))) return refuse("invalid", `repoPath does not exist: ${repoPath}`);
  if (isProjectRemovalInProgress(repoPath)) return refuse("conflict", `project is being removed from Wisp: ${resolve(repoPath)}`);
  // Explicit values win; then config harnessDefaults; then Wisp's default
  // where this install offers it; then the harness's own defaults (null).
  // A probed harness with no snapshot yet (first boot, or a cache dropped by
  // an adapter change) gets the CLI's own default until the probe lands.
  const resolved = resolveHarnessDefaults(cfg, harness, input.model, input.effort);
  const model = resolved.model ?? wispDefaultModel(def, models?.snapshot(harness).models?.list ?? null);
  const effort = resolved.effort;
  const unsupported = unsupportedRequest(def, harness, { effort, fast: input.fast, brief: input.brief });
  if (unsupported) return refuse("invalid", unsupported);
  const local = localTaskRefusal(input);
  if (local) return local;
  // S3: turn-1 attachments are validated BEFORE the task row exists — a
  // rejected create never leaves a task behind (named refusals, never silent)
  let attachments: DecodedAttachment[];
  try {
    attachments = decodeAttachments(harness, def, input.attachments);
  } catch (e) {
    if (e instanceof AttachError) return { kind: "attachment", error: e.message, status: e.status };
    throw e;
  }
  let handedOff = false;
  try {
    // A removal can begin while attachment decoding and defaults are resolved.
    // Check again at the last point before the row exists.
    if (isProjectRemovalInProgress(repoPath)) return refuse("conflict", `project is being removed from Wisp: ${resolve(repoPath)}`);
    try {
      assertTaskCapacity(cfg);
    } catch (error) {
      if (error instanceof TaskCapacityError) return refuse("at-capacity", error.message);
      throw error;
    }
    const task = insertTaskRow(input, model, effort);
    if (!task) return refuse("no-free-id", "could not allocate a unique task id after 5 attempts");
    recordAudit(task.id, "create", input.actor, `${harness}${model ? ` ${model}` : ""}, ${input.mode}`);
    armRequestedAutopilot(task.id, input.autopilot, input.actor);
    const release = reserveTaskCapacity(task.id, cfg);
    handedOff = true;
    const prompt = input.firstTurnPrompt ?? input.prompt;
    void backgroundPass(
      `launch of task ${task.id}`,
      () => launchTask(task, prompt, def, adapters, cfg, attachments, input.base).finally(release),
    );
    return { task, autopilot: autopilotStatus(task.id) };
  } finally {
    if (!handedOff) releaseDecodedAttachments(attachments);
  }
}
