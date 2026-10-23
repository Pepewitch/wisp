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
import { drainSubtaskQueues } from "../runner";
import { createTask, freeSlot, listTasks, newTaskId, turnForTask } from "../store";
import { assertTaskCapacity, reserveTaskCapacity, SubtaskCapError, TaskCapacityError } from "../task-admission";
import { autopilotSwitchDetail, recordAudit, type TaskAuditActor } from "../task-audit";
import { TASK_TITLE_MAX, updateTaskAndEmit } from "../task-update";
import { taskMode, type Task, type TaskMode } from "../types";
import type { ModelProbeCache } from "../model-probes";
import { baseFromCaller, projectCheckoutFor } from "./project-checkout";
import {
  defaultSubtaskDeps,
  parentRefusal,
  resolveSubtask,
  subtaskFirstPrompt,
  SubtaskRefused,
  type PinnedBase,
  type ResolvedSubtask,
  type SubtaskDeps,
  type SubtaskRequest,
} from "./subtask-create";
import { launchTask } from "./task-launch";

export interface NewTaskInput {
  /** a subtask's is its parent's: "" (omitted) takes it, and any other is refused */
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
  mode: TaskMode;
  /** the ref a worktree task forks from, instead of the project's; pinned when Wisp already resolved it */
  base?: string | PinnedBase;
  /** the parent this task is a subtask of (subtask-create.ts) */
  subtask?: SubtaskRequest;
  /** turn-1 attachments as they arrived, validated here against the harness */
  attachments?: unknown;
  autopilot?: { autoMerge: boolean; autoFix: boolean; autoReview?: boolean };
  /** a task Wisp starts for verification (verify/); omitted = an ordinary task */
  verifyRole?: "reviewer" | "recipe";
  /**
   * Runs once the row exists and before anything launches: a daemon-started
   * task records what it belongs to here, so its first turn already sees it.
   */
  prepare?: (task: Task) => void;
  /** who asked, for the task audit */
  actor: TaskAuditActor;
}

/**
 * Why a task was not created. `attachment` keeps the status its own error
 * chose (an expired upload is not the same failure as a bad one).
 */
export type NewTaskRefusal =
  | { kind: "invalid" | "conflict" | "at-capacity" | "subtask-cap" | "no-free-id"; error: string }
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
  asked: { effort: string | null; fast: boolean },
): string | null {
  if (asked.effort !== null && !def.effort) return `harness '${harness}' has no effort support`;
  if (asked.fast && !def.fastMode) return `harness '${harness}' has no fast mode`;
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
  if (input.autopilot?.autoMerge || input.autopilot?.autoFix || input.autopilot?.autoReview) {
    return refuse("invalid", "auto-merge, auto-fix and auto-review need a worktree task — a local task runs on the checkout's own branch");
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
  if (!requested || (!requested.autoMerge && !requested.autoFix && !requested.autoReview)) return;
  try {
    const armed = setAutopilot(taskId, { autoMerge: requested.autoMerge, autoFix: requested.autoFix, autoReview: requested.autoReview === true });
    const detail = autopilotSwitchDetail(null, armed);
    if (detail) recordAudit(taskId, "autopilot", actor, detail);
  } catch (error) {
    console.warn(`[wisp] task ${taskId}: could not arm auto-merge: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** L4: 5-char ids are birthday-bound (~1.7% collision at 1k tasks), so retry on a UNIQUE violation. */
function insertTaskRow(input: NewTaskInput, model: string | null, effort: string | null, sub: ResolvedSubtask | null, cfg: WispConfig): Task | null {
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
        verify_role: input.verifyRole ?? null,
        ...(sub ? {
          subtask: { parent_task_id: sub.parent.id, subtask_kind: sub.kind, report_to_parent: sub.report, base_from: sub.baseFrom },
          // the parent can be archived, nested or filled up while the request was checked
          guard: () => {
            const refused = parentRefusal(sub.parent.id, sub.reviewer, cfg);
            if (refused) throw new SubtaskRefused(refused);
          },
        } : {}),
        slot: freeSlot(),
      });
    } catch (e) {
      if (e instanceof SubtaskRefused || !String(e instanceof Error ? e.message : e).includes("UNIQUE constraint")) throw e;
    }
  }
  return null;
}

/**
 * The repository and base a task is created with: a subtask's parent's, or
 * for a worktree task named by a path inside another worktree (a task's own,
 * when `wisp new` runs in a turn), that project's checkout (#412). A local
 * task runs in the directory it was given, so it keeps it.
 */
async function placement(input: NewTaskInput, cfg: WispConfig, sub: ResolvedSubtask | null): Promise<NewTaskInput | NewTaskRefusal> {
  if (sub) return { ...input, repoPath: sub.parent.repo_path, base: sub.base };
  if (!(await pathExists(input.repoPath))) return refuse("invalid", `repoPath does not exist: ${input.repoPath}`);
  if (input.mode !== "worktree" || typeof input.base === "object") return input;
  const configured = (cfg.repos ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path));
  const checkout = await projectCheckoutFor(input.repoPath, configured, listTasks().map((t) => t.repo_path));
  const base = await baseFromCaller(input.repoPath, checkout, input.base);
  if ("error" in base) return refuse("invalid", base.error);
  return { ...input, repoPath: checkout, base: base.base };
}

/** Admission for the new task: the global limit, and its parent's running cap unless it is Wisp's reviewer. */
function capacityRefusal(cfg: WispConfig, sub: ResolvedSubtask | null): NewTaskRefusal | null {
  try {
    assertTaskCapacity(cfg, undefined, { parentId: sub && !sub.reviewer ? sub.parent.id : null });
    return null;
  } catch (error) {
    if (error instanceof SubtaskCapError) return refuse("subtask-cap", error.message);
    if (error instanceof TaskCapacityError) return refuse("at-capacity", error.message);
    throw error;
  }
}

/** What a first turn is sent: a subtask's also quotes its parent (Wisp's reviewers get their own prompt as is). */
function firstTurnPrompt(input: NewTaskInput, sub: ResolvedSubtask | null): string {
  const prompt = input.firstTurnPrompt ?? input.prompt;
  if (!sub || sub.reviewer) return prompt;
  return subtaskFirstPrompt(prompt, sub.parent, turnForTask(sub.parent.id, 1)?.prompt ?? null);
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
  deps: SubtaskDeps = defaultSubtaskDeps,
): Promise<NewTask | NewTaskRefusal> {
  const { harness } = input;
  const def = adapters[harness];
  if (!def) return refuse("invalid", `unknown harness '${harness}' (known: ${Object.keys(adapters).join(", ")})`);
  const sub = await resolveSubtask(input, cfg, deps);
  if (sub && "error" in sub) return sub;
  const placed = await placement(input, cfg, sub);
  if ("error" in placed) return placed;
  input = placed;
  const { repoPath } = input;
  if (isProjectRemovalInProgress(repoPath)) return refuse("conflict", `project is being removed from Wisp: ${resolve(repoPath)}`);
  // Explicit values win; then config harnessDefaults; then Wisp's default
  // where this install offers it; then the harness's own defaults (null).
  // A probed harness with no snapshot yet (first boot, or a cache dropped by
  // an adapter change) gets the CLI's own default until the probe lands.
  const resolved = resolveHarnessDefaults(cfg, harness, input.model, input.effort);
  const model = resolved.model ?? wispDefaultModel(def, models?.snapshot(harness).models?.list ?? null);
  const effort = resolved.effort;
  const unsupported = unsupportedRequest(def, harness, { effort, fast: input.fast });
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
    const full = capacityRefusal(cfg, sub);
    if (full) return full;
    let task: Task | null;
    try {
      task = insertTaskRow(input, model, effort, sub, cfg);
    } catch (error) {
      if (error instanceof SubtaskRefused) return error.refusal;
      throw error;
    }
    if (!task) return refuse("no-free-id", "could not allocate a unique task id after 5 attempts");
    // the parent's own row did not change, but its list of children did
    if (sub) updateTaskAndEmit(sub.parent.id, {});
    recordAudit(task.id, "create", input.actor, `${harness}${model ? ` ${model}` : ""}, ${input.mode}`);
    armRequestedAutopilot(task.id, input.autopilot, input.actor);
    input.prepare?.(task);
    const release = reserveTaskCapacity(task.id, cfg);
    handedOff = true;
    const prompt = firstTurnPrompt(input, sub);
    const created = task;
    void backgroundPass(
      `launch of task ${task.id}`,
      () => launchTask(created, prompt, def, adapters, cfg, attachments, input.base).finally(() => {
        release();
        // a creation slot freed, or setup failed: a sibling waiting on the parent's cap may start
        drainSubtaskQueues(created.parent_task_id, adapters, cfg);
      }),
    );
    return { task, autopilot: autopilotStatus(task.id) };
  } finally {
    if (!handedOff) releaseDecodedAttachments(attachments);
  }
}
