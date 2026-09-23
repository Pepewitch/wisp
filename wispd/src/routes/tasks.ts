import { retentionRoute } from "./retention";
import { taskLogResponse } from "./task-log";
import { assertTaskCapacity, reserveTaskCapacity, TaskCapacityError } from "../task-admission";
import { cleanupRoute } from "./cleanup";
import { cleanupProgress } from "../archive-progress";
import { trackHomeWork } from "../home-lifetime";
import { resolve } from "node:path";
import { buildAttachArgv, isCompactPrompt, ProbeError, probeCommands, type AdapterDef } from "../adapters";
import {
  AttachError,
  decodeAttachments,
  releaseDecodedAttachments,
  type DecodedAttachment,
} from "../attachments";
import { resolveHarnessDefaults, type WispConfig } from "../config";
import { emit } from "../events";
import { pathExists } from "../fsutil";
import { answerQuestionResponse } from "./task-answer";
import type { PullRequestCache } from "../pull-requests";
import { isProjectRemovalInProgress } from "../project-removals";
import { hasRunningTurn, interruptTurn, submitTaskMessage } from "../runner";
import { InterruptConflict } from "../turn-interrupt";
import type { TaskCompactor } from "../compacts";
import type { TaskProbeCache } from "../probes";
import type { TaskSkillCache } from "../skills";
import {
  createTask,
  freeSlot,
  getTask,
  latestTurnOutcomes,
  listTasks,
  newTaskId,
  setTaskContextFields,
  setTaskFields,
  switchTaskAgent,
} from "../store";
import { promptWithSuffix } from "../suffix-prompts";
import { TASK_MODES, taskMode, type Task, type TaskMode } from "../types";
import { isRecord, typeName } from "../validate";
import { diffStat, fullDiff, pushBranch, readWorktreeFile, worktreeHealth } from "../worktree";
import { taskIdsWithAttachedWorkflows } from "../workflows/store";
import { autopilotStatuses, setAutopilot } from "../autopilot/store";
import { autopilotUpdateError } from "./autopilot";
import { archiveTaskRows } from "./archive";
import { launchTask } from "./task-launch";
import { apiTask, apiTaskMessage, err, json, jsonObjectBody } from "./http";
import {
  agentSwitch,
  resolveSendAgent,
  sendTaskBodyError,
  type SendTaskBody,
} from "./send-agent";
import { conversationDetail, conversationResponse, taskUsageResponse } from "./task-conversation";
import { TASK_TITLE_MAX, updateTaskAndEmit } from "../task-update";

/** GET /api/tasks */
export function listTasksRoute(url: URL): Response {
  // each task's LATEST turn, for the list surfaces: the model it actually ran
  // on (P5b), and the exit facts that let a client say "exited 1" instead of
  // "failed" when the work landed but the harness CLI exited badly (Theme B)
  const outcomes = latestTurnOutcomes();
  const attachedWorkflows = taskIdsWithAttachedWorkflows();
  const autopilot = autopilotStatuses();
  return json(
    listTasks(url.searchParams.get("archived") === "1" || url.searchParams.get("cleanup") === "1")
      .filter(t => !t.archived || url.searchParams.get("archived") === "1" || cleanupProgress(t.id) !== null).map((t) => ({
      ...apiTask(t),
      has_workflow: attachedWorkflows.has(t.id),
      autopilot: autopilot.get(t.id) ?? null,
      latest_turn_model: outcomes.get(t.id)?.model ?? null,
      latest_turn_exit_code: outcomes.get(t.id)?.exitCode ?? null,
      latest_turn_has_result: outcomes.get(t.id)?.hasResult ?? false,
    })),
  );
}

interface CreateTaskBody {
  repoPath?: unknown;
  prompt?: unknown;
  harness?: unknown;
  model?: unknown;
  effort?: unknown;
  fast?: unknown;
  mode?: unknown;
  base?: unknown;
  suffixPromptId?: unknown;
  attachments?: unknown;
  autopilot?: unknown;
}

function createTaskBodyError(body: CreateTaskBody): Response | null {
  if (body.repoPath === undefined || body.prompt === undefined || body.harness === undefined) {
    return err("repoPath, prompt, and harness are required", 400);
  }
  if (typeof body.repoPath !== "string") return err(`repoPath must be a string, got ${typeName(body.repoPath)}`, 400);
  if (body.repoPath === "") return err("repoPath must not be empty", 400);
  if (typeof body.prompt !== "string") return err(`prompt must be a string, got ${typeName(body.prompt)}`, 400);
  if (body.prompt === "") return err("prompt must not be empty", 400);
  if (typeof body.harness !== "string") return err(`harness must be a string, got ${typeName(body.harness)}`, 400);
  if (body.harness === "") return err("harness must not be empty", 400);
  if (body.model !== undefined && typeof body.model !== "string") {
    return err(`model must be a string, got ${typeName(body.model)}`, 400);
  }
  if (body.suffixPromptId !== undefined && typeof body.suffixPromptId !== "string") {
    return err(`suffixPromptId must be a string, got ${typeName(body.suffixPromptId)}`, 400);
  }
  if (body.effort !== undefined && typeof body.effort !== "string") {
    return err(`effort must be a string, got ${typeName(body.effort)}`, 400);
  }
  if (body.effort === "") return err("effort must not be empty", 400);
  if (body.fast !== undefined && typeof body.fast !== "boolean") {
    return err(`fast must be a boolean, got ${typeName(body.fast)}`, 400);
  }
  if (body.base !== undefined && typeof body.base !== "string") {
    return err(`base must be a string, got ${typeName(body.base)}`, 400);
  }
  // .trim(), not `=== ""`: "   " would otherwise pass the boundary and then
  // be silently discarded as "no override" by resolveBase — a base the user
  // asked for and did not get, which is the failure mode being removed.
  if (typeof body.base === "string" && body.base.trim() === "") return err("base must not be empty", 400);
  if (body.autopilot !== undefined) {
    if (!isRecord(body.autopilot)) return err(`autopilot must be an object, got ${typeName(body.autopilot)}`, 400);
    const invalid = autopilotUpdateError(body.autopilot);
    if (invalid) return err(`autopilot: ${invalid}`, 400);
    if (body.autopilot.autoFix === true) return err("autopilot: Auto-fix is not available yet", 400);
    if (body.autopilot.autoMerge === true && body.mode === "local") {
      return err("auto-merge needs a worktree task — a local task runs on the checkout's own branch", 400);
    }
  }
  return null;
}

/** Armed before the first turn starts, so that turn already carries the auto-merge note. */
function armRequestedAutopilot(taskId: string, requested: unknown): void {
  if (isRecord(requested) && requested.autoMerge === true) setAutopilot(taskId, { autoMerge: true });
}

/** POST /api/tasks */
export function createTaskRoute(req: Request, cfg: WispConfig, adapters: Record<string, AdapterDef>): Promise<Response> {
  return (async () => {
    const parsed = await jsonObjectBody(req);
    if (parsed instanceof Response) return parsed;
    const body = parsed as CreateTaskBody;
    const invalid = createTaskBodyError(body);
    if (invalid) return invalid;
    // createTaskBodyError establishes these required string fields at the
    // request boundary; bind them once so later async callbacks stay narrow.
    const repoPath = body.repoPath as string;
    const rawPrompt = body.prompt as string;
    const harness = body.harness as string;
    const prompt = promptWithSuffix(rawPrompt, body.suffixPromptId as string | undefined);
    if (prompt === null) return err(`unknown suffixPromptId '${body.suffixPromptId}'`, 400);
    let mode: TaskMode = "worktree";
    if (body.mode !== undefined) {
      if (typeof body.mode !== "string" || !(TASK_MODES as readonly string[]).includes(body.mode)) {
        const got = typeof body.mode === "string" ? JSON.stringify(body.mode) : typeName(body.mode);
        return err(`mode must be one of ${TASK_MODES.join(", ")}, got ${got}`, 400);
      }
      mode = body.mode as TaskMode;
    }
    const def = adapters[harness];
    if (!def) return err(`unknown harness '${harness}' (known: ${Object.keys(adapters).join(", ")})`, 400);
    if (!(await pathExists(repoPath))) return err(`repoPath does not exist: ${repoPath}`, 400);
    if (isProjectRemovalInProgress(repoPath)) {
      return err(`project is being removed from Wisp: ${resolve(repoPath)}`, 409);
    }
    // Explicit values win; then config harnessDefaults; then the harness's own defaults.
    const { model, effort } = resolveHarnessDefaults(
      cfg,
      harness,
      body.model as string | undefined,
      body.effort as string | undefined,
    );
    if (effort !== null && !def.effort) {
      return err(`harness '${harness}' has no effort support`, 400);
    }
    const fast = body.fast === true;
    if (fast && !def.fastMode) {
      return err(`harness '${harness}' has no fast mode`, 400);
    }
    // Two local tasks in one repo means two agents editing the SAME files
    // with no isolation between them — the exact hazard worktrees exist to
    // remove. Refuse by name so the fix is obvious. (Worktree tasks are
    // isolated by construction; the global admission limit still applies.)
    if (mode === "local") {
      // A local task adopts the branch the checkout is already on; there is
      // nothing to fork, so a base could only be honoured by moving the
      // user's own working copy. Refuse the combination instead of ignoring
      // half of it.
      if (body.base !== undefined) {
        return err("base applies to worktree tasks only — a local task runs on the checkout's current branch", 400);
      }
      // a local: the string checks above narrowed body.repoPath, but not
      // inside this callback — bind it
      const live = listTasks(false).find((t) => taskMode(t) === "local" && resolve(t.repo_path) === resolve(repoPath));
      if (live) {
        return err(
          `task ${live.id} is already running locally in ${resolve(repoPath)} — archive it first, or create this one as a worktree task`,
          409,
        );
      }
    }
    // S3: turn-1 attachments are validated BEFORE the task row exists — a
    // rejected create never leaves a task behind (named 400s, never silent)
    let attachments: DecodedAttachment[];
    try {
      attachments = decodeAttachments(harness, def, body.attachments);
    } catch (e) {
      if (e instanceof AttachError) return err(e.message, e.status);
      throw e;
    }
    let handedOff = false;
    try {
      // L4: 5-char ids are birthday-bound (~1.7% collision at 1k tasks) — retry
      // on a UNIQUE violation instead of 500ing the create request.
      let task: Task | null = null;
      // A removal can begin while attachment decoding and defaults are resolved.
      // Check again at the last point before the row exists.
      if (isProjectRemovalInProgress(repoPath)) {
        return err(`project is being removed from Wisp: ${resolve(repoPath)}`, 409);
      }
      try { assertTaskCapacity(cfg); } catch (error) { if (error instanceof TaskCapacityError) return err(error.message, 429); throw error; }
      for (let attempt = 0; attempt < 5 && !task; attempt++) {
        try {
          task = createTask({
            id: newTaskId(),
            title: rawPrompt.slice(0, TASK_TITLE_MAX),
            repo_path: repoPath,
            harness,
            model,
            effort,
            fast,
            mode,
            slot: freeSlot(),
          });
        } catch (e) {
          if (!String(e instanceof Error ? e.message : e).includes("UNIQUE constraint")) throw e;
        }
      }
      if (!task) return err("could not allocate a unique task id after 5 attempts", 500);
      armRequestedAutopilot(task.id, body.autopilot);
      const release = reserveTaskCapacity(task.id, cfg);
      handedOff = true;
      void trackHomeWork(
        launchTask(task, prompt, def, adapters, cfg, attachments, body.base as string | undefined).finally(release),
      );
      return json(apiTask(task), 201);
    } finally {
      if (!handedOff) releaseDecodedAttachments(attachments);
    }
  })();
}

function idleTaskError(task: Task, runningSuffix = ""): Response | null {
  if (task.archived) return err("task is archived — archived tasks are read-only", 409);
  if (task.state === "creating") return err("task is still being created", 409);
  const running = hasRunningTurn(task.id);
  return running ? err(`turn ${running.n} is still running${runningSuffix}`, 409) : null;
}

async function sendTaskResponse(
  task: Task,
  req: Request,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
  compacts?: TaskCompactor,
): Promise<Response> {
  const parsed = await jsonObjectBody(req);
  if (parsed instanceof Response) return parsed;
  const body = parsed as SendTaskBody;
  const current = getTask(task.id);
  if (!current) return err(`no such task: ${task.id}`, 404);
  task = current;
  const invalid = sendTaskBodyError(body);
  if (invalid) return invalid;
  if (task.archived) return err("task is archived — archived tasks are read-only", 409);
  if (task.state === "creating") return err("task is still being created", 409);
  if (!task.worktree_path) return err("task has no worktree (failed before setup?)", 409);
  const running = hasRunningTurn(task.id);
  if (
    compacts?.isCompacting(task.id) ||
    (running && isCompactPrompt(adapters[running.harness], running.prompt))
  ) {
    // Compaction rewrites the context a steer would target. Action compactors
    // have no turn row, while native prompt compactors do; guard both shapes
    // before a message is persisted so it is refused, never silently queued.
    return err("compaction is still running — wait for it to finish", 409);
  }
  const resolved = resolveSendAgent(task, body, cfg, adapters);
  if (resolved instanceof Response) return resolved;
  const { harness, def } = resolved;
  const message = promptWithSuffix(body.message as string, body.suffixPromptId as string | undefined);
  if (message === null) return err(`unknown suffixPromptId '${body.suffixPromptId}'`, 400);
  const operation = isCompactPrompt(def, message) ? "compact" as const : undefined;
  if (operation) {
    // A native compact command owns the whole harness turn. In particular it
    // must never enter Claude's live-input path as if it were a correction to
    // the work already in flight. Action-based compactors use this same
    // refusal sentence in POST /compact; a race after this check is kept for
    // the next turn by submitTaskMessage's delivery policy below.
    const unavailable = idleTaskError(task, " — compaction waits for it");
    if (unavailable) return unavailable;
  }
  let decoded: DecodedAttachment[] = [];
  try {
    decoded = decodeAttachments(harness, def, body.attachments);
    // The switch and the queue row commit in ONE transaction inside
    // submitTaskMessage: a crash can expose neither a switched task without
    // its first message nor a message attributed to an agent the task never
    // adopted.
    const agent = agentSwitch(task, resolved);
    const result = await submitTaskMessage(
      task,
      message,
      def,
      cfg,
      decoded,
      body.clientMessageId as string | undefined,
      adapters,
      agent,
      operation ? "next-turn-only" : "allow-steer",
    );
    return json({
      ...apiTask(getTask(task.id)!),
      disposition: result.disposition,
      message: apiTaskMessage(result.message),
      ...(operation ? { operation } : {}),
    });
  } catch (error) {
    if (error instanceof TaskCapacityError) return err(error.message, 429);
    if (error instanceof AttachError) return err(error.message, error.status);
    if (error instanceof InterruptConflict) return err(error.message, 409);
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("was already used for different content") || detail.endsWith("was cancelled")) {
      return err(detail, 409);
    }
    if (
      detail === "task is archived — archived tasks are read-only" ||
      detail === "task is still being created"
    ) {
      return err(detail, 409);
    }
    throw error;
  } finally {
    // Consumed uploads already left the registry. Errors and stable-id retries
    // retire whichever fresh one-shot references remain.
    releaseDecodedAttachments(decoded);
  }
}

function basicTaskAction(
  task: Task,
  action: string | undefined,
  method: string,
  req: Request,
  url: URL,
  adapters: Record<string, AdapterDef>,
): Response | Promise<Response> | null {
  if (action === "answer" && method === "POST") {
    return answerQuestionResponse(task, req);
  }
  if (action === "conversation" && method === "GET") {
    return conversationResponse(task, url, adapters);
  }
  if (action === "usage" && method === "GET") {
    return taskUsageResponse(task, adapters);
  }
  if (action === "interrupt" && method === "POST") {
    return (async () => {
      if (task.archived) return err("task is archived — archived tasks are read-only", 409);
      try {
        await interruptTurn(task.id);
      } catch (error) {
        return err(String(error instanceof Error ? error.message : error), 409);
      }
      return json({ ok: true });
    })();
  }
  if (action === "fresh-session" && method === "POST") {
    const unavailable = idleTaskError(task);
    if (unavailable) return unavailable;
    const updated = switchTaskAgent(
      task.id,
      { harness: task.harness, model: task.model, effort: task.effort, fast: task.fast === 1 },
      true,
    );
    emit({ type: "task", taskId: task.id, state: task.state, stateDetail: task.state_detail, seq: task.seq });
    return json(apiTask(updated));
  }
  if (action === "push" && method === "POST") {
    return (async () => {
      if (task.archived) return err("task is archived — archived tasks are read-only", 409);
      if (!task.worktree_path || !task.branch) return err("task has no worktree/branch", 409);
      const out = await pushBranch(task.worktree_path, task.branch);
      return json({ ok: true, output: out });
    })();
  }
  if (action === "attach" && method === "GET") {
    const def = adapters[task.harness];
    if (!def || !task.session_id) return json({ argv: null, message: "no session yet" });
    const argv = buildAttachArgv(def, task.session_id);
    return json({
      argv,
      cwd: task.worktree_path,
      message: argv ? null : `harness '${task.harness}' has no known interactive attach command yet`,
    });
  }
  return null;
}

function pullRequestResponse(task: Task, pullRequests?: PullRequestCache): Response | Promise<Response> {
  if (!pullRequests) return err("pull-request discovery is not available on this daemon", 500);
  return pullRequests.status(task).then((status) => json(status));
}

/**
 * /api/tasks/:id and its action sub-routes. `null` means the path is not a
 * task route at all, so the dispatcher carries on down its chain — exactly
 * what the single if-chain did by falling through.
 */
export function taskRoute(
  req: Request,
  url: URL,
  path: string,
  m: string,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
  probes?: TaskProbeCache,
  skills?: TaskSkillCache,
  compacts?: TaskCompactor,
  pullRequests?: PullRequestCache,
): Response | Promise<Response> | null {
  // the action slot takes hyphens too (fresh-session, S3)
  const taskMatch = path.match(/^\/api\/tasks\/([a-z0-9]+)(?:\/([a-z-]+))?$/);
  if (!taskMatch) return null;
  const [, id, action] = taskMatch;
  const task = getTask(id!);
  if (!task) return err(`no such task: ${id}`, 404);

  if (!action && m === "PATCH") {
    return (async () => {
      const parsed = await jsonObjectBody(req);
      if (parsed instanceof Response) return parsed;
      const body = parsed as { title?: unknown };
      if (body.title === undefined) return err("title is required", 400);
      if (typeof body.title !== "string") {
        return err(`title must be a string, got ${typeName(body.title)}`, 400);
      }
      const title = body.title.trim();
      if (title === "") return err("title must not be empty", 400);
      if (title.length > TASK_TITLE_MAX) {
        return err(`title must be at most ${TASK_TITLE_MAX} characters`, 400);
      }
      if (title === task.title) {
        // Re-submitting the current name is still the user CHOOSING it: lock
        // the PR-title sync even though nothing visible about the row changes.
        if (!task.custom_title) {
          setTaskFields(task.id, { custom_title: 1 });
          return json(apiTask(getTask(id)!));
        }
        return json(apiTask(task));
      }
      // Renaming is metadata, not a state transition: keep seq/outbox stable,
      // but wake every UI with enough data to patch without broad refetches.
      const updated = updateTaskAndEmit(task.id, { title, custom_title: 1 }, "title")!;
      return json(apiTask(updated));
    })();
  }

  if (!action && m === "GET") {
    return (async () => {
      // An archived task is ALREADY modelled as "the worktree is gone", so it
      // is not asked — a health sentence there would tell the user to archive a
      // task they archived.
      const health = task.archived || !task.worktree_path ? null : await worktreeHealth(task.worktree_path);
      const stat = health?.ok ? await diffStat(task.worktree_path!) : null;
      return json({
        ...conversationDetail(task, adapters),
        diffstat: stat,
        worktreeReason: health?.reason ?? null,
      });
    })();
  }

  if (action === "log" && m === "GET") {
    return taskLogResponse(task, url);
  }

  if (action === "send" && m === "POST") {
    return sendTaskResponse(task, req, cfg, adapters, compacts);
  }

  if (action === "pull-request" && m === "GET") return pullRequestResponse(task, pullRequests);

  const basicActionResponse = basicTaskAction(task, action, m, req, url, adapters);
  if (basicActionResponse !== null) return basicActionResponse;

  // A3: an out-of-turn harness READ. No turn row, no transition, no outbox
  // event — routing a read through /send would lie about the task's state.
  if (action === "probe" && m === "POST") {
    return (async () => {
      const parsed = await jsonObjectBody(req);
      if (parsed instanceof Response) return parsed;
      const body = parsed as { command?: unknown };
      if (typeof body.command !== "string" || body.command.length === 0) return err("command is required", 400);
      // a probe opens the harness's session OUTSIDE the turn loop; running one
      // while a turn holds that session is the one combination neither the
      // harness nor wisp's logs can keep honest
      const unavailable = idleTaskError(task, " — a read waits for it");
      if (unavailable) return unavailable;
      const def = adapters[task.harness];
      if (!def) return err(`unknown harness: ${task.harness}`, 500);
      if (!probes) return err("probes are not available on this daemon", 500);
      const available = probeCommands(def);
      if (available.length === 0) {
        return err(`harness '${task.harness}' declares no out-of-turn reads`, 400);
      }
      if (!available.includes(body.command as "context" | "usage")) {
        return err(
          `harness '${task.harness}' has no out-of-turn '${body.command}' read (it has: ${available.join(", ")})`,
          400,
        );
      }
      try {
        const answer = await probes.probe(task, def, body.command as "context" | "usage");
        return json({ command: body.command, probedAt: answer.probedAt, cached: answer.cached, report: answer.report });
      } catch (e) {
        if (e instanceof ProbeError) return err(e.message, e.status);
        throw e;
      }
    })();
  }

  // A4: the harness's OWN skill list for the palette's Tier 3 — enumerated,
  // never hardcoded. Same posture as the probe route: a read, out of band,
  // with the same refusal ladder. A harness with no discovery strategy
  // answers an honest empty list with the reason, never a 500.
  if (action === "skills" && m === "GET") {
    return (async () => {
      const unavailable = idleTaskError(task, " — a read waits for it");
      if (unavailable) return unavailable;
      const def = adapters[task.harness];
      if (!def) return err(`unknown harness: ${task.harness}`, 500);
      if (!skills) return err("skill discovery is not available on this daemon", 500);
      if (!def.skillDiscovery) {
        return json({
          skills: [],
          commands: [],
          commandError: null,
          errors: [],
          partialNote: `harness '${task.harness}' declares no skill discovery`,
          invoke: null,
          probedAt: new Date().toISOString(),
          cached: false,
        });
      }
      try {
        const answer = await skills.skills(task, def);
        return json({ ...answer.result, probedAt: answer.probedAt, cached: answer.cached });
      } catch (e) {
        if (e instanceof ProbeError) return err(e.message, e.status);
        throw e;
      }
    })();
  }

  // A5: an out-of-turn harness ACTION — compaction. No turn row (droid mints
  // a new session id instead; codex records the turn in ITS own thread and
  // says so), no transition, no cache: a second click compacts again. Same
  // refusal ladder as the probe route, plus Q7's fallback contract: a failure
  // answers with the named reason and the palette offers /fresh.
  if (action === "compact" && m === "POST") {
    return (async () => {
      const unavailable = idleTaskError(task, " — compaction waits for it");
      if (unavailable) return unavailable;
      const def = adapters[task.harness];
      if (!def) return err(`unknown harness: ${task.harness}`, 500);
      if (!compacts) return err("compaction is not available on this daemon", 500);
      if (!def.compact) {
        // claude lands here: its compact IS a turn prompt, and the route
        // says so rather than pretending the action exists (the palette
        // prefills def.compactPrompt and never calls this route for it)
        return err(
          def.compactPrompt
            ? `harness '${task.harness}' compacts as a dedicated turn — send ${def.compactPrompt} as a prompt`
            : `harness '${task.harness}' declares no compaction`,
          400,
        );
      }
      if (!task.session_id) return err("no session yet — compaction needs a session to compact; run a turn first", 409);
      try {
        const result = await compacts.compact(task, def);
        // The compaction happened outside any turn, so no stream reported the
        // model call that followed it and wisp does not know the new size. The
        // reading it replaces is now a number about a conversation that no
        // longer exists, so it is cleared rather than left standing: "not
        // observed" is true, and the next turn re-establishes it.
        setTaskContextFields(task.id, task.context_n, {
          // SP1: droid compaction MINTS the session that holds the summary —
          // a field update on an existing column, the freeze holds
          ...(result.newSessionId ? { session_id: result.newSessionId } : {}),
          context_tokens: null,
        });
        // This action records no turn row, so a cached /context from before it
        // would survive the compaction and report the tokens it just dropped.
        probes?.invalidateTask(task.id);
        return json({
          ok: true,
          removedCount: result.removedCount,
          sessionReplaced: result.newSessionId !== null,
          note: result.note,
        });
      } catch (e) {
        if (e instanceof ProbeError) return err(e.message, e.status);
        throw e;
      }
    })();
  }

  if (action === "export" || action === "purge" || action === "storage") {
    const taskCaches = [probes, skills].filter(
      (cache): cache is TaskProbeCache | TaskSkillCache => cache !== undefined,
    );
    return retentionRoute(req, task, action, taskCaches);
  }

  if (action === "cleanup") return cleanupRoute(req, task.id);

  if (action === "archive" && m === "POST") {
    return (async () => {
      const parsed = await jsonObjectBody(req);
      if (parsed instanceof Response) return parsed;
      const force = parsed.force ?? false;
      if (typeof force !== "boolean") return err(`force must be a boolean, got ${typeName(force)}`, 400);
      const archiveTask = getTask(task.id) ?? task;
      const result = await archiveTaskRows([archiveTask], force, cfg);
      if ("error" in result) return err(result.error, result.status);
      const archived = result.archived[0]!;
      return json({ ok: true, branch: archived.branch, note: archived.note });
    })();
  }

  if (action === "diff" && m === "GET") return diffRoute(task);

  if (action === "file" && m === "GET") return worktreeFileRoute(task, url);

  return null;
}

/** The Changes pane's whole diff, and the states that are not a failure. */
async function diffRoute(task: Task): Promise<Response> {
  // archived rows keep their worktree_path but the directory is gone —
  // answer honestly instead of spawn-crashing git on a removed cwd
  if (task.archived) return err("task is archived — worktree removed", 409);
  if (!task.worktree_path) return err("task has no worktree (failed before setup?)", 409);
  // A worktree git has forgotten is a STATE, not a request failure: 200 with
  // an empty diff and the reason, the same shape the UI already uses for an
  // archived task. Erroring here is what rendered git's usage text in the
  // diff pane (D1).
  const health = await worktreeHealth(task.worktree_path);
  if (!health.ok) {
    return json({ diff: "", truncated: false, untracked: [], base: null, worktreeReason: health.reason });
  }
  // A local task's base_commit is HEAD-at-creation, but its checkout is ALSO
  // where the human works: they commit and the branch moves on, and diffing
  // against that stale base keeps reporting their own landed commits as
  // pending "changes". A worktree task's base IS its branch point, so there
  // it stays the right answer.
  const diff = await fullDiff(task.worktree_path, taskMode(task) === "local" ? null : task.base_commit);
  return json({ ...diff, worktreeReason: null });
}

/**
 * One file out of the task's worktree, so the UI can read a plan an agent
 * wrote without leaving the task. The daemon serves it rather than the desktop
 * app reading local disk: the worktree belongs to whichever daemon owns the
 * task, which is the only arrangement that also works for a remote connection
 * — and it gives the browser the same feature.
 *
 * `path` may be worktree-relative or absolute; what it may not be is anywhere
 * outside the worktree, and the refusal never says which of "not there" or
 * "not yours" it was. Distinguishing them would answer questions about the
 * daemon's whole disk.
 */
async function worktreeFileRoute(task: Task, url: URL): Promise<Response> {
  const path = url.searchParams.get("path");
  if (path === null || path.trim() === "") return err("path is required", 400);
  if (task.archived) return err("task is archived — worktree removed", 409);
  if (!task.worktree_path) return err("task has no worktree (failed before setup?)", 409);
  const file = await readWorktreeFile(task.worktree_path, path);
  if (!file) return err("no such file in this task's worktree", 404);
  return json(file);
}
