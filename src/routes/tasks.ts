import { resolve } from "node:path";
import { buildAttachArgv, ProbeError, probeCommands, type AdapterDef } from "../adapters";
import {
  AttachError,
  decodeAttachments,
  removeTaskAttachments,
  writeTurnAttachments,
  type DecodedAttachment,
} from "../attachments";
import { resolveHarnessDefaults, type WispConfig } from "../config";
import { emit } from "../events";
import { pathExists, readSlice, readTailOf } from "../fsutil";
import type { PullRequestCache } from "../pull-requests";
import { hasRunningTurn, interruptTurn, killTurnForArchive, startTurn, submitTaskMessage, taskEnv } from "../runner";
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
  setTaskFields,
  transition,
  turnForTask,
  turnsFor,
} from "../store";
import { promptWithSuffix } from "../suffix-prompts";
import { killForTask } from "../terminal";
import { TASK_MODES, taskMode, type Task, type TaskMode } from "../types";
import { typeName } from "../validate";
import {
  archivePreflight,
  createWorktree,
  diffStat,
  fullDiff,
  localWorktree,
  pushBranch,
  removeWorktree,
  runSetup,
  slugify,
  worktreeHealth,
} from "../worktree";
import { apiTask, apiTaskMessage, apiTurn, err, integerQueryParam, json } from "./http";

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
        : await createWorktree(task.repo_path, task.id, slugify(task.title), cfg);
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
    if (!fresh || fresh.archived) return;
    const stored = attachments.length > 0 ? writeTurnAttachments(task.id, fresh.turn_count + 1, attachments) : [];
    startTurn(fresh, prompt, def, cfg, stored);
  } catch (e) {
    if (getTask(task.id)?.archived) return;
    transition(task.id, "failed", String(e instanceof Error ? e.message : e).slice(0, 300));
  }
}

/** Cap on a background failure sentence written into state_detail (transition() uses the same). */
const STATE_DETAIL_CAP = 300;

/** Persist metadata and publish the resulting task row after the write commits. */
function updateTaskAndEmit(
  taskId: string,
  fields: Parameters<typeof setTaskFields>[1],
  metadata?: "title",
): Task | null {
  setTaskFields(taskId, fields);
  const updated = getTask(taskId);
  if (!updated) return null;
  emit({
    type: "task",
    taskId,
    state: updated.state,
    stateDetail: updated.state_detail,
    seq: updated.seq,
    ...(metadata === "title" ? { title: updated.title, updatedAt: updated.updated_at } : {}),
  });
  return updated;
}

/**
 * A field update on state_detail plus the emit that makes it visible — the same
 * pair the archive route uses for the flip. NOT a transition: the state did not
 * change, only the sentence describing it, so seq, the outbox and the notify
 * rules stay transition()'s alone.
 */
function noteOnTask(taskId: string, detail: string): void {
  updateTaskAndEmit(taskId, { state_detail: detail.slice(0, STATE_DETAIL_CAP) });
}

/**
 * Archive's destructive half, run after the 200 (Q11 / D4). Everything in here
 * either takes unbounded time (the two teardown hooks, and a worktree removal
 * that is tens of thousands of files on a JS monorepo) or cannot refuse, so
 * none of it belongs on the response path.
 *
 * Ordering still matters: the turn and the shells die before their cwd does.
 *
 * One consequence of answering early is that a teardown can fail after the task
 * already reports archived. It writes the failure into state_detail rather than
 * disappearing — the honest-state rule does not get a pass because the response
 * already went out. (killTurnForArchive's "the caller must not archive then" is
 * the one thing this restructure gives up: a harness that refuses to die now
 * leaves an archived task carrying that sentence, rather than a 409 the user
 * cannot act on. The stuck loop ignores archived tasks, so nothing flaps.)
 */
async function teardownArchive(
  task: Task,
  force: boolean,
  wasRunning: boolean,
  removable: boolean,
  cfg: WispConfig,
): Promise<void> {
  const failures: string[] = [];
  const attempt = async (what: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (e) {
      failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  if (wasRunning && force) {
    // kill + finalize the turn BEFORE removing its cwd (a prior audit) —
    // otherwise the turn row stays 'running' forever
    await attempt("could not stop the running turn", () => killTurnForArchive(task.id));
  }
  // Interactive shells are independent of one-shot turns; both archive paths
  // kill them before their cwd goes away.
  await attempt("could not stop the task's shells", () => killForTask(task.id));
  if (removable) {
    await attempt("worktree teardown failed", () =>
      removeWorktree(task.repo_path, task.worktree_path!, task.branch!, force, cfg, task.id),
    );
  }
  // Attachments live OUTSIDE the worktree, so nothing above takes them, and
  // they would be the one category of bytes an archive left growing (Q4: both
  // paths, plain and force — including a local task, which has no worktree to
  // remove at all). The turn manifests stay, so the conversation keeps saying
  // what was attached and the bytes route can answer 410 instead of 404.
  await attempt("could not remove the task's attachments", () => removeTaskAttachments(task.id));
  if (failures.length > 0) {
    console.error(`[wisp] task ${task.id}: archive teardown failed — ${failures.join("; ")}`);
    noteOnTask(task.id, `Archived, but the teardown failed — ${failures.join("; ")}`);
  }
}

/** GET /api/tasks */
export function listTasksRoute(url: URL): Response {
  // each task's LATEST turn, for the list surfaces: the model it actually ran
  // on (P5b), and the exit facts that let a client say "exited 1" instead of
  // "failed" when the work landed but the harness CLI exited badly (Theme B)
  const outcomes = latestTurnOutcomes();
  return json(
    listTasks(url.searchParams.get("archived") === "1").map((t) => ({
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
    const body = (await req.json().catch(() => ({}))) as CreateTaskBody;
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
    // isolated by construction and stay unlimited.)
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
    void launchTask(task, prompt, def, cfg, attachments);
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
    harness: task.harness,
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

async function sendTaskResponse(
  task: Task,
  req: Request,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
): Promise<Response> {
  const body = (await req.json()) as {
    message?: string;
    suffixPromptId?: unknown;
    attachments?: unknown;
    clientMessageId?: unknown;
  };
  const current = getTask(task.id);
  if (!current) return err(`no such task: ${task.id}`, 404);
  task = current;
  if (typeof body.message !== "string" || body.message.length === 0) return err("message is required", 400);
  if (body.suffixPromptId !== undefined && typeof body.suffixPromptId !== "string") {
    return err(`suffixPromptId must be a string, got ${typeName(body.suffixPromptId)}`, 400);
  }
  if (task.archived) return err("task is archived — archived tasks are read-only", 409);
  if (task.state === "creating") return err("task is still being created", 409);
  if (!task.worktree_path) return err("task has no worktree (failed before setup?)", 409);
  if (
    body.clientMessageId !== undefined &&
    (typeof body.clientMessageId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(body.clientMessageId))
  ) {
    return err("clientMessageId must be 8-80 letters, numbers, '_' or '-'", 400);
  }
  const def = adapters[task.harness];
  if (!def) return err(`unknown harness: ${task.harness}`, 500);
  const message = promptWithSuffix(body.message, body.suffixPromptId as string | undefined);
  if (message === null) return err(`unknown suffixPromptId '${body.suffixPromptId}'`, 400);
  try {
    const decoded = decodeAttachments(task.harness, def, body.attachments);
    const result = await submitTaskMessage(
      task,
      message,
      def,
      cfg,
      decoded,
      body.clientMessageId as string | undefined,
    );
    return json({
      ...apiTask(getTask(task.id)!),
      disposition: result.disposition,
      message: apiTaskMessage(result.message),
    });
  } catch (error) {
    if (error instanceof AttachError) return err(error.message, 400);
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
    const updated = updateTaskAndEmit(task.id, { session_id: null })!;
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
      const body = (await req.json().catch(() => ({}))) as { title?: unknown };
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
        turns: turns.map((t) => apiTurn(t, adapters[task.harness])),
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
      const body = (await req.json().catch(() => ({}))) as { command?: unknown };
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
          updateTaskAndEmit(task.id, { session_id: result.newSessionId });
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

  if (action === "archive" && m === "POST") {
    return (async () => {
      const body = (await req.json().catch(() => ({}))) as { force?: boolean };
      const force = body.force ?? false;
      const archiveTask = getTask(task.id) ?? task;
      // ---- the refusal line (Q11): everything that can say no, before the
      // response and before anything is destroyed. All of it is a fast read.
      const running = hasRunningTurn(archiveTask.id);
      if (running && !force) {
        return err(`turn ${running.n} is still running — interrupt it first, or force-archive to kill it`, 409);
      }
      // A local task's "worktree" IS the user's checkout. Removing it would
      // delete their working copy, and the archive hook is a worktree teardown
      // (rm -rf node_modules and friends) — so archiving a local task is purely
      // a bookkeeping flip. This is the load-bearing half of local mode.
      const removable =
        taskMode(archiveTask) === "worktree" &&
        archiveTask.worktree_path !== null &&
        archiveTask.branch !== null;
      let preflight: Awaited<ReturnType<typeof archivePreflight>> | null = null;
      if (removable) {
        preflight = await archivePreflight(
          archiveTask.worktree_path!,
          archiveTask.branch!,
          archiveTask.base_commit,
          force,
        );
        if (preflight.refusal !== null) return err(preflight.refusal, 409);
      }
      // Preflight yields to git. A send may have started a turn while it was
      // running, so re-check at the last safe point before the synchronous
      // archive flip.
      const latestRunning = hasRunningTurn(archiveTask.id);
      if (latestRunning && !force) {
        return err(
          `turn ${latestRunning.n} is still running — interrupt it first, or force-archive to kill it`,
          409,
        );
      }
      // ---- the flip, the emit, the 200. From here the task IS archived, and
      // the honest-state rule already covers the gap: an archived task's panes
      // say the worktree is gone, which is true now and stays true once the
      // bytes follow.
      updateTaskAndEmit(archiveTask.id, {
        archived: 1,
        // the user has to be told where their files went; state_detail is where
        // the row, the hover card and the header all already read from
        ...(preflight?.leftBehind ? { state_detail: preflight.leftBehind } : {}),
      });
      // ---- the teardown, after the response. Deliberately not awaited.
      void teardownArchive(archiveTask, force, latestRunning !== null, removable, cfg);
      return json({ ok: true, branch: archiveTask.branch, note: preflight?.leftBehind ?? null });
    })();
  }

  if (action === "diff" && m === "GET") {
    return (async () => {
      // archived rows keep their worktree_path but the directory is gone —
      // answer honestly instead of spawn-crashing git on a removed cwd
      if (task.archived) return err("task is archived — worktree removed", 409);
      if (!task.worktree_path) return err("task has no worktree (failed before setup?)", 409);
      // A worktree git has forgotten is a STATE, not a request failure: 200
      // with an empty diff and the reason, the same shape the UI already uses
      // for an archived task. Erroring here is what rendered git's usage text
      // in the diff pane (D1).
      const health = await worktreeHealth(task.worktree_path);
      if (!health.ok) {
        return json({ diff: "", truncated: false, untracked: [], base: null, worktreeReason: health.reason });
      }
      // A local task's base_commit is HEAD-at-creation, but its checkout is
      // ALSO where the human works: they commit and the branch moves on, and
      // diffing against that stale base keeps reporting their own landed
      // commits as pending "changes". A worktree task's base IS its branch
      // point, so there it stays the right answer.
      const diff = await fullDiff(task.worktree_path, taskMode(task) === "local" ? null : task.base_commit);
      return json({ ...diff, worktreeReason: null });
    })();
  }

  return null;
}
