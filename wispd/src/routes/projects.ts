import { basename, isAbsolute, resolve } from "node:path";
import { patchConfig, type RepoConfig, type WispConfig } from "../config";
import { emit, subscribe } from "../events";
import { directoryExists, pathExists } from "../fsutil";
import { beginProjectRemoval } from "../project-removals";
import { listTasks } from "../store";
import { Semaphore } from "../subprocess";
import { taskMode, type Task } from "../types";
import { typeName } from "../validate";
import { matchCopyFiles, statusSummary, worktreeHealth } from "../worktree";
import { archiveTaskRows } from "./archive";
import { err, json, jsonObjectBody } from "./http";

export type RepoEntry = string | RepoConfig;

export function repoEntryPath(entry: RepoEntry): string {
  return typeof entry === "string" ? entry : entry.path;
}

export function repoEntryName(path: string, entry?: RepoEntry): string {
  const configured = entry && typeof entry !== "string" ? entry.name : undefined;
  return configured ?? (basename(path) || path);
}

/** Persist only the API-managed repos key, preserving unknown config keys. */
export function persistRepos(cfg: WispConfig, repos: RepoEntry[]): void {
  patchConfig({ repos });
  cfg.repos = repos;
}

/** Cap on a git failure sentence served as a status reason — the pane caps it again. */
const REASON_CAP = 200;

/**
 * GET /api/status[?fresh=<taskId>]
 *
 * Every live task with a worktree gets an entry, always. A task whose worktree
 * git can no longer read carries its BRANCH AND THE REASON and no counts (D1):
 * omitting the row or reporting zeros are the two ways this endpoint used to lie
 * about a broken worktree, and the sidebar believed it.
 *
 * Each entry is several git processes, and clients ask again on every task and
 * turn event of ANY task: at fifty live worktrees that was 350 spawns and about
 * two seconds per event. So entries are cached per task, and a task's own task
 * or turn event drops only its entry. `fresh` names a task (the one a client
 * is showing) that is probed again regardless; the age bound covers what
 * changes outside Wisp for the rest, such as a commit made in a terminal.
 */
/**
 * Bounds on the fan-out. Each task's entry is several git processes, so an
 * unbounded `Promise.all` over every live task is a process storm on one
 * developer machine (ENG-05).
 */
const STATUS_PROBE_CONCURRENCY = 4;
const statusProbes = new Semaphore(STATUS_PROBE_CONCURRENCY);
/** How long an entry nothing has invalidated is served before git is asked again. */
export const STATUS_CACHE_MAX_AGE_MS = 30_000;

interface CachedStatus {
  /** What the entry describes: a task whose worktree, branch, base or seq moved is probed again. */
  key: string;
  startedAt: number;
  /** Shared while in flight too, so overlapping requests never probe one task twice. */
  entry: Promise<unknown>;
}

const statusCache = new Map<string, CachedStatus>();
let statusInvalidation: (() => void) | null = null;

/** Only the task an event names can have moved; every other entry stays. */
function watchStatusEvents(): void {
  statusInvalidation ??= subscribe((evt) => {
    if (evt.type === "task" || evt.type === "turn") statusCache.delete(evt.taskId);
  });
}

/** For what moves a task's git state without a task event, such as a push from the API. */
export function invalidateStatus(taskId: string): void {
  statusCache.delete(taskId);
}

export function statusRoute(req: Request): Promise<Response> {
  const fresh = new Set(new URL(req.url).searchParams.getAll("fresh"));
  return (async () => json({ tasks: await collectStatus(fresh) }))();
}

async function collectStatus(fresh: ReadonlySet<string>): Promise<Record<string, unknown>> {
  watchStatusEvents();
  // per-task probes run CONCURRENTLY — one unreadable worktree must never 500
  // the rest, and must never cost another task its marks — but only
  // STATUS_PROBE_CONCURRENCY of them at a time
  const live = listTasks().filter((t) => t.worktree_path !== null && t.branch !== null);
  const liveIds = new Set(live.map((t) => t.id));
  for (const id of statusCache.keys()) if (!liveIds.has(id)) statusCache.delete(id);
  const now = Date.now();
  const rows = await Promise.all(
    live.map(async (t): Promise<[string, unknown]> => [t.id, await cachedTaskStatus(t, fresh.has(t.id), now)]),
  );
  return Object.fromEntries(rows);
}

function cachedTaskStatus(t: Task, fresh: boolean, now: number): Promise<unknown> {
  // local: no base (see the diff route) — "ahead" would otherwise count the
  // human's own commits on their own branch
  const base = taskMode(t) === "local" ? null : t.base_commit;
  const key = JSON.stringify([t.worktree_path, t.branch, base, t.seq]);
  const cached = statusCache.get(t.id);
  // an entry from the future (the clock moved back) counts as stale
  const age = cached ? now - cached.startedAt : -1;
  if (!fresh && cached?.key === key && age >= 0 && age < STATUS_CACHE_MAX_AGE_MS) return cached.entry;
  const probe: CachedStatus = { key, startedAt: now, entry: Promise.resolve(null) };
  // A failure answers this request only, and the next one asks git again: a
  // health check that timed out under load must not show the row broken for
  // the whole age bound.
  const forget = (): void => {
    if (statusCache.get(t.id) === probe) statusCache.delete(t.id);
  };
  probe.entry = statusProbes.run(async () => {
    try {
      const health = await worktreeHealth(t.worktree_path!);
      if (!health.ok) {
        forget();
        return { branch: t.branch, worktreeReason: health.reason };
      }
      const summary = await statusSummary(t.worktree_path!, t.branch!, base);
      return { branch: t.branch, ...summary, worktreeReason: null };
    } catch (e) {
      forget();
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[wisp] /api/status: task ${t.id} (${t.worktree_path}): ${message}`);
      return { branch: t.branch, worktreeReason: `Git could not read this worktree — ${message}`.slice(0, REASON_CAP) };
    }
  });
  statusCache.set(t.id, probe);
  return probe.entry;
}

/** GET /api/repos */
export function reposRoute(cfg: WispConfig): Promise<Response> {
  return (async () => {
    // cfg.repos pins + the repo_path of every active task, deduped by resolved
    // path; exists-probes run concurrently. Archived history stays available
    // through ?archived=1, but does not keep an unregistered project in the
    // Projects list forever.
    const activeTasks = listTasks();
    const configured = cfg.repos.map((entry) => ({ path: repoEntryPath(entry), entry }));
    const history = activeTasks.map((t) => ({ path: t.repo_path, entry: undefined as RepoEntry | undefined }));
    const seen = new Set<string>();
    const unique = [...configured, ...history].filter(({ path }) => {
      const resolved = resolve(path);
      if (seen.has(resolved)) return false;
      seen.add(resolved);
      return true;
    });
    const repos = await Promise.all(
      unique.map(async ({ path, entry }) => {
        const resolved = resolve(path);
        const config = entry && typeof entry !== "string" ? entry : undefined;
        return {
          path: resolved,
          name: repoEntryName(resolved, entry),
          exists: await pathExists(resolved),
          // the project-settings modal reads these; a task-history repo has
          // no config entry, so they are simply absent for one
          setupScript: config?.setupScript ?? "",
          archiveScript: config?.archiveScript ?? "",
          copyFiles: config?.copyFiles ?? [],
          // "" is the meaningful default, not a missing value: it renders as
          // the placeholder naming what Wisp resolves on its own.
          baseBranch: config?.baseBranch ?? "",
          configured: config !== undefined || (entry !== undefined && typeof entry === "string"),
        };
      }),
    );
    return json({ repos });
  })();
}

interface ProjectUpdateBody {
  path?: unknown;
  name?: unknown;
  setupScript?: unknown;
  archiveScript?: unknown;
  copyFiles?: unknown;
  baseBranch?: unknown;
}

function projectUpdateError(body: ProjectUpdateBody): Response | null {
  if (typeof body.path !== "string" || body.path.length === 0) return err("path is required", 400);
  if (body.name !== undefined && typeof body.name !== "string") {
    return err(`name must be a string, got ${typeName(body.name)}`, 400);
  }
  for (const key of ["setupScript", "archiveScript", "baseBranch"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "string") {
      return err(`${key} must be a string, got ${typeName(body[key])}`, 400);
    }
  }
  if (
    body.copyFiles !== undefined &&
    (!Array.isArray(body.copyFiles) || body.copyFiles.some((value) => typeof value !== "string"))
  ) {
    return err(`copyFiles must be an array of strings, got ${typeName(body.copyFiles)}`, 400);
  }
  return null;
}

function mergeProjectEntry(resolved: string, before: RepoEntry | undefined, body: ProjectUpdateBody): RepoEntry {
  const existing = before === undefined || typeof before === "string" ? undefined : before;
  const merged: RepoConfig = { path: resolved };
  const name = (body.name as string | undefined) ?? existing?.name;
  if (name !== undefined && name !== "") merged.name = name;
  const setup = (body.setupScript as string | undefined) ?? existing?.setupScript;
  if (setup !== undefined && setup.trim() !== "") merged.setupScript = setup;
  const archive = (body.archiveScript as string | undefined) ?? existing?.archiveScript;
  if (archive !== undefined && archive.trim() !== "") merged.archiveScript = archive;
  const copy = (body.copyFiles as string[] | undefined) ?? existing?.copyFiles;
  const patterns = copy?.map((value) => value.trim()).filter((value) => value !== "");
  if (patterns && patterns.length > 0) merged.copyFiles = patterns;
  // Same patch semantics as the rest: "" drops the key, which is exactly what
  // the settings modal's Reset sends — back to Wisp resolving origin/HEAD.
  const base = (body.baseBranch as string | undefined) ?? existing?.baseBranch;
  if (base !== undefined && base.trim() !== "") merged.baseBranch = base.trim();
  return Object.keys(merged).length === 1 ? resolved : merged;
}

/** POST /api/projects */
export function addProjectRoute(req: Request, cfg: WispConfig): Promise<Response> {
  return (async () => {
    const parsed = await jsonObjectBody(req);
    if (parsed instanceof Response) return parsed;
    const body = parsed as ProjectUpdateBody;
    const invalid = projectUpdateError(body);
    if (invalid) return invalid;
    // projectUpdateError narrowed the runtime value; bind that fact for the
    // async filesystem checks and merge helpers below.
    const path = body.path as string;
    if (!isAbsolute(path)) return err(`path must be absolute: ${path}`, 400);
    if (!(await directoryExists(path))) return err(`path is not an existing directory: ${path}`, 400);

    const resolved = resolve(path);
    const index = cfg.repos.findIndex((entry) => resolve(repoEntryPath(entry)) === resolved);
    const before = index >= 0 ? cfg.repos[index]! : undefined;
    const next = [...cfg.repos];
    // Every field is PATCH semantics: omitted preserves what is stored, and
    // an explicit "" / [] clears it. A settings modal that saves only the
    // field you edited must not blank the other two.
    const merged = mergeProjectEntry(resolved, before, body);
    if (index >= 0) next[index] = merged;
    else next.push(merged);
    persistRepos(cfg, next);
    emit({ type: "project", action: "add", path: resolved });
    const entry = next.find((candidate) => resolve(repoEntryPath(candidate)) === resolved)!;
    const saved = typeof entry === "string" ? undefined : entry;
    return json(
      {
        path: resolved,
        name: repoEntryName(resolved, entry),
        exists: true,
        setupScript: saved?.setupScript ?? "",
        archiveScript: saved?.archiveScript ?? "",
        copyFiles: saved?.copyFiles ?? [],
        baseBranch: saved?.baseBranch ?? "",
      },
      before === undefined ? 201 : 200,
    );
  })();
}

/**
 * What `copyFiles` would actually take, resolved against the real repo — the
 * settings modal shows this under the pattern box so a glob is verified
 * BEFORE a task depends on it. POST rather than GET because the patterns are
 * a list straight from a textarea, not a tidy query string.
 */
export function copyPreviewRoute(req: Request): Promise<Response> {
  return (async () => {
    const parsed = await jsonObjectBody(req);
    if (parsed instanceof Response) return parsed;
    const body = parsed as { path?: unknown; patterns?: unknown };
    if (typeof body.path !== "string" || body.path.length === 0) return err("path is required", 400);
    if (!Array.isArray(body.patterns) || body.patterns.some((v) => typeof v !== "string")) {
      return err(`patterns must be an array of strings, got ${typeName(body.patterns)}`, 400);
    }
    const resolved = resolve(body.path);
    if (!(await directoryExists(resolved))) return err(`path is not an existing directory: ${resolved}`, 400);
    const { files, truncated } = await matchCopyFiles(resolved, body.patterns as string[]);
    return json({ path: resolved, files, truncated });
  })();
}

/** DELETE /api/projects */
export function removeProjectRoute(req: Request, cfg: WispConfig): Promise<Response> {
  return (async () => {
    const parsed = await jsonObjectBody(req);
    if (parsed instanceof Response) return parsed;
    const body = parsed as { path?: unknown; archiveTasks?: unknown };
    if (typeof body.path !== "string" || body.path.length === 0) return err("path is required", 400);
    if (body.archiveTasks !== undefined && typeof body.archiveTasks !== "boolean") {
      return err(`archiveTasks must be a boolean, got ${typeName(body.archiveTasks)}`, 400);
    }
    const resolved = resolve(body.path);
    const without = (): RepoEntry[] => cfg.repos.filter((entry) => resolve(repoEntryPath(entry)) !== resolved);
    if (without().length === cfg.repos.length) {
      const historical = listTasks(true).some((task) => resolve(task.repo_path) === resolved);
      if (historical) return err(`project '${resolved}' exists only in task history and is not configured`, 404);
      return err(`project not found in config repos: ${resolved}`, 404);
    }
    const finishRemoval = beginProjectRemoval(resolved);
    try {
      let archivedTaskCount = 0;
      if (body.archiveTasks) {
        const activeTasks = listTasks().filter((task) => resolve(task.repo_path) === resolved);
        // "Archive all its tasks" was the owner's consent to switching autopilot off too
        const result = await archiveTaskRows(activeTasks, false, cfg, { stopAutopilot: true });
        if ("error" in result) {
          return err(`could not archive task '${result.task.title}': ${result.error}`, result.status);
        }
        archivedTaskCount = result.archived.length;
      }
      // Filter the list as it is NOW, not as it was before the archive above
      // awaited git for every task: a project added, edited or removed in the
      // meantime is in cfg.repos, and a stale snapshot would undo it.
      persistRepos(cfg, without());
      emit({ type: "project", action: "remove", path: resolved });
      return json({ ok: true, path: resolved, archivedTaskCount });
    } finally {
      finishRemoval();
    }
  })();
}
