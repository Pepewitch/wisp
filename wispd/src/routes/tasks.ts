import { retentionRoute } from "./retention";
import { assertTaskCapacity, reserveTaskCapacity, TaskCapacityError } from "../task-admission";
import { cleanupRoute } from "./cleanup";
import { cleanupProgress } from "../archive-progress";
import { homeIsDraining, trackHomeWork } from "../home-lifetime";
import { resolve } from "node:path";
import { buildAttachArgv, ProbeError, probeCommands, type AdapterDef } from "../adapters";
import {
  AttachError,
  decodeAttachments,
  writeTurnAttachments,
  type DecodedAttachment,
} from "../attachments";
import { resolveHarnessDefaults, type WispConfig } from "../config";
import { emit } from "../events";
import { pathExists, readSlice, readTailOf } from "../fsutil";
import type { PullRequestCache } from "../pull-requests";
import { isProjectRemovalInProgress } from "../project-removals";
import { hasRunningTurn, interruptTurn, startTurn, submitTaskMessage, taskEnv } from "../runner";
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
  messagesFor,
  newTaskId,
  setTaskContextFields,
  setTaskFields,
  switchTaskAgent,
  transition,
  turnForTask,
  turnsFor,
} from "../store";
import { promptWithSuffix } from "../suffix-prompts";
import { TASK_MODES, taskMode, type Task, type TaskMode } from "../types";
import { typeName } from "../validate";
import {
  createWorktree,
  diffStat,
  fullDiff,
  localWorktree,
  pushBranch,
  readWorktreeFile,
  runSetup,
  worktreeHealth,
} from "../worktree";
import { archiveTaskRows } from "./archive";
import { apiTask, apiTaskMessage, apiTurn, err, integerQueryParam, json, jsonObjectBody } from "./http";
import { updateTaskAndEmit } from "./task-update";

/** Bytes served per log tail — positioned reads only, never whole files (a prior audit). */
const LOG_TAIL_BYTES = 16_384;
/** Creation already derives at most 80 characters from turn 1; renames keep the same UI-safe ceiling. */
const TASK_TITLE_MAX = 80;

/**
 * Full task-creation flow, run async after the record is persisted (spawn
 * contract rule 1). Turn-1 attachments ride along in memory (validated at
 * request time) and are written to disk only once creation got as far as
 * spawning the turn — a failed worktree/setup leaves no orphan files.
 */
async function launchTask(
  task: Task,
  prompt: string,
  def: AdapterDef,
  adapters: Record<string, AdapterDef>,
  cfg: WispConfig,
  attachments: DecodedAttachment[] = [],
): Promise<void> {
  try {
    const mode = taskMode(task);
    // local: adopt the checkout as-is, creating nothing. worktree: the
    // original path — a fresh worktree on its own branch.
    const wt =
      mode === "local"
        ? await localWorktree(task.repo_path)
        : await createWorktree(task.repo_path, task.id, cfg);
    setTaskFields(task.id, { worktree_path: wt.path, branch: wt.branch, base_commit: wt.base_commit });
    // Still 'creating', but the worktree now EXISTS — re-emit so watchers
    // refetch and pick up worktree_path. Setup can run for minutes, and until
    // this fires the web terminal has no directory to open a shell in.
    transition(task.id, "creating", mode === "worktree" ? "worktree ready, running setup" : "using the checkout");
    // Setup exists to make a FRESH worktree usable. Running it over the user's
    // own checkout is destructive (it is where `pnpm install` and friends
    // live), so a local task never runs it.
    if (mode === "worktree") await runSetup(task.id, task.repo_path, wt.path, taskEnv(getTask(task.id)!), cfg);
    // Archive may have completed while setup yielded. Its read-only flip wins;
    // never start a child in a worktree teardown is already removing.
    const fresh = getTask(task.id);
    if (!fresh || fresh.archived || homeIsDraining()) return;
    const stored = attachments.length > 0 ? writeTurnAttachments(task.id, fresh.turn_count + 1, attachments) : [];
    startTurn(fresh, prompt, def, cfg, stored, undefined, adapters);
  } catch (e) {
    if (getTask(task.id)?.archived) return;
    transition(task.id, "failed", String(e instanceof Error ? e.message : e).slice(0, 300));
  }
}

/** GET /api/tasks */
export function listTasksRoute(url: URL): Response {
  // each task's LATEST turn, for the list surfaces: the model it actually ran
  // on (P5b), and the exit facts that let a client say "exited 1" instead of
  // "failed" when the work landed but the harness CLI exited badly (Theme B)
  const outcomes = latestTurnOutcomes();
  return json(
    listTasks(url.searchParams.get("archived") === "1" || url.searchParams.get("cleanup") === "1")
      .filter(t => !t.archived || url.searchParams.get("archived") === "1" || cleanupProgress(t.id) !== null).map((t) => ({
      ...apiTask(t),
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
  mode?: unknown;
  suffixPromptId?: unknown;
  attachments?: unknown;
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
  return null;
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
    // Two local tasks in one repo means two agents editing the SAME files
    // with no isolation between them — the exact hazard worktrees exist to
    // remove. Refuse by name so the fix is obvious. (Worktree tasks are
    // isolated by construction; the global admission limit still applies.)
    if (mode === "local") {
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
      if (e instanceof AttachError) return err(e.message, 400);
      throw e;
    }
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
          mode,
          slot: freeSlot(),
        });
      } catch (e) {
        if (!String(e instanceof Error ? e.message : e).includes("UNIQUE constraint")) throw e;
      }
    }
    if (!task) return err("could not allocate a unique task id after 5 attempts", 500);
    const release = reserveTaskCapacity(task.id, cfg);
    void trackHomeWork(launchTask(task, prompt, def, adapters, cfg, attachments).finally(release));
    return json(apiTask(task), 201);
  })();
}

async function taskLogResponse(
  task: Task,
  url: URL,
): Promise<Response> {
  const turnNumber = integerQueryParam(url, "turn", 1);
  if (turnNumber instanceof Response) return turnNumber;
  const n = turnNumber ?? task.turn_count;
  const parsedOffset = integerQueryParam(url, "offset", 0);
  if (parsedOffset instanceof Response) return parsedOffset;
  const offset = parsedOffset ?? -1;
  const turn = turnForTask(task.id, n);
  if (!turn) return err(`no turn ${n}`, 404);
  const slice =
    offset >= 0
      ? await readSlice(turn.log_file, offset, 262_144)
      : { text: await readTailOf(turn.log_file, LOG_TAIL_BYTES), size: 0 };
  return json({
    turn: n,
    status: turn.status,
    harness: turn.harness,
    size: slice.size,
    out: slice.text,
    err: await readTailOf(turn.log_file.replace(/\.out\.log$/, ".err.log"), LOG_TAIL_BYTES),
  });
}

function idleTaskError(task: Task, runningSuffix = ""): Response | null {
  if (task.archived) return err("task is archived — archived tasks are read-only", 409);
  if (task.state === "creating") return err("task is still being created", 409);
  const running = hasRunningTurn(task.id);
  return running ? err(`turn ${running.n} is still running${runningSuffix}`, 409) : null;
}

interface SendTaskBody {
  message?: unknown;
  suffixPromptId?: unknown;
  attachments?: unknown;
  clientMessageId?: unknown;
  harness?: unknown;
  model?: unknown;
  effort?: unknown;
  startFreshContext?: unknown;
}

function sendTaskBodyError(body: SendTaskBody): Response | null {
  if (typeof body.message !== "string" || body.message.length === 0) return err("message is required", 400);
  if (body.suffixPromptId !== undefined && typeof body.suffixPromptId !== "string") {
    return err(`suffixPromptId must be a string, got ${typeName(body.suffixPromptId)}`, 400);
  }
  if (body.harness !== undefined && (typeof body.harness !== "string" || body.harness === "")) {
    return err("harness must be a non-empty string", 400);
  }
  if (body.model !== undefined && (typeof body.model !== "string" || body.model === "")) {
    return err("model must be a non-empty string", 400);
  }
  if (body.effort !== undefined && body.effort !== null && (typeof body.effort !== "string" || body.effort === "")) {
    return err("effort must be a non-empty string or null", 400);
  }
  if (body.startFreshContext !== undefined && typeof body.startFreshContext !== "boolean") {
    return err("startFreshContext must be a boolean", 400);
  }
  if (
    body.clientMessageId !== undefined &&
    (typeof body.clientMessageId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(body.clientMessageId))
  ) {
    return err("clientMessageId must be 8-80 letters, numbers, '_' or '-'", 400);
  }
  return null;
}

interface ResolvedSendAgent {
  harness: string;
  model: string | null;
  effort: string | null;
  harnessChanged: boolean;
  def: AdapterDef;
}

function resolveSendAgent(
  task: Task,
  body: SendTaskBody,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
): ResolvedSendAgent | Response {
  const harness = (body.harness as string | undefined) ?? task.harness;
  const model = body.model === undefined ? task.model : (body.model as string);
  const harnessChanged = harness !== task.harness;
  if (harnessChanged && body.model === undefined) return err("model is required when changing harness", 400);
  if (harnessChanged && body.startFreshContext !== true) {
    return err("changing harness requires startFreshContext: true", 409);
  }
  const def = adapters[harness];
  if (!def) return err(`unknown harness: ${harness}`, body.harness === undefined ? 500 : 400);
  const effort =
    body.effort !== undefined
      ? (body.effort as string | null)
      : harnessChanged
        ? resolveHarnessDefaults(cfg, harness, model ?? undefined, undefined).effort
        : task.effort;
  return { harness, model, effort, harnessChanged, def };
}

async function sendTaskResponse(
  task: Task,
  req: Request,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
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
  const resolved = resolveSendAgent(task, body, cfg, adapters);
  if (resolved instanceof Response) return resolved;
  const { harness, model, effort, harnessChanged, def } = resolved;
  const message = promptWithSuffix(body.message as string, body.suffixPromptId as string | undefined);
  if (message === null) return err(`unknown suffixPromptId '${body.suffixPromptId}'`, 400);
  try {
    const decoded = decodeAttachments(harness, def, body.attachments);
    // The switch and the queue row commit in ONE transaction inside
    // submitTaskMessage: a crash can expose neither a switched task without
    // its first message nor a message attributed to an agent the task never
    // adopted.
    const agent =
      harness !== task.harness || model !== task.model || effort !== task.effort
        ? { harness, model, effort, freshContext: harnessChanged }
        : undefined;
    const result = await submitTaskMessage(
      task,
      message,
      def,
      cfg,
      decoded,
      body.clientMessageId as string | undefined,
      adapters,
      agent,
    );
    return json({
      ...apiTask(getTask(task.id)!),
      disposition: result.disposition,
      message: apiTaskMessage(result.message),
    });
  } catch (error) {
    if (error instanceof TaskCapacityError) return err(error.message, 429);
    if (error instanceof AttachError) return err(error.message, 400);
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
  }
}

function basicTaskAction(
  task: Task,
  action: string | undefined,
  method: string,
  adapters: Record<string, AdapterDef>,
): Response | Promise<Response> | null {
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
    const updated = switchTaskAgent(task.id, task.harness, task.model, task.effort, true);
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
      if (title === task.title) return json(apiTask(task));
      // Renaming is metadata, not a state transition: keep seq/outbox stable,
      // but wake every UI with enough data to patch without broad refetches.
      const updated = updateTaskAndEmit(task.id, { title }, "title")!;
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
      // the same latest-turn facts the list carries, so a client derives the
      // display word ("exited 1") identically from either route (Theme B)
      const turns = turnsFor(task.id);
      const latest = turns.at(-1);
      return json({
        ...apiTask(task),
        latest_turn_model: latest?.model ?? null,
        latest_turn_exit_code: latest?.exit_code ?? null,
        latest_turn_has_result: latest ? latest.result !== null : false,
        turns: turns.map((t) => apiTurn(t, adapters[t.harness])),
        messages: messagesFor(task.id).map(apiTaskMessage),
        diffstat: stat,
        worktreeReason: health?.reason ?? null,
      });
    })();
  }

  if (action === "log" && m === "GET") {
    return taskLogResponse(task, url);
  }

  if (action === "send" && m === "POST") {
    return sendTaskResponse(task, req, cfg, adapters);
  }

  if (action === "pull-request" && m === "GET") return pullRequestResponse(task, pullRequests);

  const basicActionResponse = basicTaskAction(task, action, m, adapters);
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
            ? `harness '${task.harness}' compacts as an ordinary turn — send ${def.compactPrompt} as a prompt`
            : `harness '${task.harness}' declares no compaction`,
          400,
        );
      }
      if (!task.session_id) return err("no session yet — compaction needs a session to compact; run a turn first", 409);
      try {
        const result = await compacts.compact(task, def);
        if (result.newSessionId) {
          // SP1: droid compaction MINTS the session that holds the summary —
          // a field update on an existing column, the freeze holds
          setTaskContextFields(task.id, task.context_n, { session_id: result.newSessionId });
        }
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

  if (action === "export" || action === "purge" || action === "storage") return retentionRoute(req, task, action);

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
