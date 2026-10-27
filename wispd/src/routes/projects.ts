import { basename, isAbsolute, resolve } from "node:path";
import { patchConfig, type RepoConfig, type WispConfig } from "../config";
import { validateVerifyAgent } from "../config-verify";
import { hasDraft, recipeActivatedAt, recipeSummary } from "../verify/recipe";
import { recipeComplaints } from "../verify/rounds";
import { busyVerifyTask, draftTaskExists } from "../verify/status";
import { emit, subscribe } from "../events";
import { directoryExists, pathExists } from "../fsutil";
import { listProjectEntries } from "../project-entries";
import { beginProjectRemoval } from "../project-removals";
import { listTasks } from "../store";
import { Semaphore } from "../subprocess";
import { taskMode, type Task } from "../types";
import { typeName } from "../validate";
import { matchCopyFiles, statusSummary, worktreeHealth } from "../worktree";
import { archiveTaskRows } from "../domain/archive";
import { requestActor } from "../task-audit";
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

/** Enough of a project's verification for the sidebar: the full status is GET /api/projects/verification. */
async function verificationSummary(repoPath: string): Promise<{ state: "none" | "active"; areas: number; draft: boolean; attention: boolean; busy: boolean }> {
  const recipe = recipeSummary(repoPath);
  const activatedAt = recipe.active ? await recipeActivatedAt(repoPath) : null;
  return {
    state: recipe.active ? "active" : "none",
    areas: recipe.areas,
    draft: hasDraft(repoPath, draftTaskExists),
    attention: recipeComplaints(repoPath, activatedAt).length > 0,
    busy: busyVerifyTask(repoPath) !== null,
  };
}

/**
 * The Projects list: cfg.repos pins + the repo_path of every active task,
 * deduped by resolved path. Archived history stays available through
 * ?archived=1, but does not keep an unregistered project in the list forever.
 */
function projectList(cfg: WispConfig): { path: string; entry: RepoEntry | undefined }[] {
  const configured = cfg.repos.map((entry) => ({ path: repoEntryPath(entry), entry }));
  const history = listTasks().map((t) => ({ path: t.repo_path, entry: undefined as RepoEntry | undefined }));
  const seen = new Set<string>();
  return [...configured, ...history].filter(({ path }) => {
    const resolved = resolve(path);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

/** GET /api/repos */
export function reposRoute(cfg: WispConfig): Promise<Response> {
  return (async () => {
    // exists-probes run concurrently
    const unique = projectList(cfg);
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
          verify: config?.verify ?? null,
          verifySecond: config?.verifySecond ?? null,
          verifyFallback: config?.verifyFallback ?? null,
          verifySecondFallback: config?.verifySecondFallback ?? null,
          verification: await verificationSummary(resolved),
          configured: config !== undefined || (entry !== undefined && typeof entry === "string"),
        };
      }),
    );
    return json({ repos });
  })();
}

/**
 * GET /api/projects/entries?project=<path>&dir=<relative>[&q=<text>] — one
 * folder of a project in the Projects list, for the composer's `@` list; `q`
 * keeps names containing it (case-insensitive) before the row cap. Only those roots
 * may be listed; project-entries.ts owns containment and the ignore rules.
 */
export async function projectEntriesRoute(url: URL, cfg: WispConfig): Promise<Response> {
  const project = url.searchParams.get("project");
  if (!project || !isAbsolute(project)) return err("project must be a project's absolute path", 400);
  const root = projectList(cfg)
    .map(({ path }) => resolve(path))
    .find((path) => path === resolve(project));
  if (root === undefined) return err(`not a Wisp project: ${project}`, 404);
  const listing = await listProjectEntries(root, url.searchParams.get("dir") ?? "", url.searchParams.get("q") ?? "");
  return "error" in listing ? err(listing.error, listing.status) : json(listing);
}

interface ProjectUpdateBody {
  path?: unknown;
  name?: unknown;
  setupScript?: unknown;
  archiveScript?: unknown;
  copyFiles?: unknown;
  baseBranch?: unknown;
  /** who reviews and sets up verification: { harness, model?, effort? }; null or a blank harness clears it */
  verify?: unknown;
  /** the second reviewer: { harness, model?, effort? }, "off", or null to clear (same agent as the first) */
  verifySecond?: unknown;
  /** who reviews in reviewer A's place after an infrastructure failure: { harness, model?, effort? }, or null to clear (none) */
  verifyFallback?: unknown;
  /** the same for reviewer B */
  verifySecondFallback?: unknown;
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
  const second = body.verifySecond === "off" ? null : agentFieldError(body.verifySecond, "verifySecond", `an agent object, "off" or null`);
  const verify = agentFieldError(body.verify, "verify", "an object or null");
  const fallbacks = (["verifyFallback", "verifySecondFallback"] as const).map((key) => agentFieldError(body[key], key, "an object or null"));
  return second ?? verify ?? fallbacks.find((invalid) => invalid !== null) ?? null;
}

/** A verification agent in a project save: omitted or null, or an object of string harness, model and effort. */
function agentFieldError(value: unknown, label: string, expected: string): Response | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return err(`${label} must be ${expected}, got ${typeName(value)}`, 400);
  const agent = value as Record<string, unknown>;
  for (const key of Object.keys(agent)) if (!["harness", "model", "effort"].includes(key)) return err(`${label}: unknown field '${key}'`, 400);
  for (const key of ["harness", "model", "effort"] as const) {
    if (agent[key] !== undefined && typeof agent[key] !== "string") return err(`${label}.${key} must be a string, got ${typeName(agent[key])}`, 400);
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
  Object.assign(merged, mergedReviewers(existing, body));
  return Object.keys(merged).length === 1 ? resolved : merged;
}

/** Who reviews after a save: each reviewer agent and each fallback is its own patch key, absent when unset. */
function mergedReviewers(existing: RepoConfig | undefined, body: ProjectUpdateBody): Partial<RepoConfig> {
  const out: Partial<RepoConfig> = {};
  const verify = mergedVerifyAgent(existing, body);
  if (verify) out.verify = verify;
  const second = mergedSecondAgent(existing, body);
  if (second) out.verifySecond = second;
  for (const key of ["verifyFallback", "verifySecondFallback"] as const) {
    // omitted keeps it, null or a blank harness clears it
    const fallback = body[key] === undefined ? existing?.[key] : validateVerifyAgent(body[key] ?? undefined, key);
    if (fallback) out[key] = fallback;
  }
  return out;
}

/** The second reviewer after a save: its own key and patch, so a save of `verify` (an older client's) never touches it. */
function mergedSecondAgent(existing: RepoConfig | undefined, body: ProjectUpdateBody): RepoConfig["verifySecond"] {
  if (body.verifySecond === undefined) return existing?.verifySecond;
  return body.verifySecond === "off" ? "off" : validateVerifyAgent(body.verifySecond ?? undefined, "verifySecond");
}

/** The verification agent after a save: omitted keeps it, null or a blank harness clears it. */
function mergedVerifyAgent(existing: RepoConfig | undefined, body: ProjectUpdateBody): RepoConfig["verify"] {
  if (body.verify === undefined) return existing?.verify;
  return validateVerifyAgent(body.verify ?? undefined, "verify");
}

/**
 * A fallback naming a harness this daemon does not have: refused, because it
 * would only be skipped when it is needed (verify/fallback.ts fallbackAgent).
 */
function unknownFallbackError(body: ProjectUpdateBody, adapters: Readonly<Record<string, unknown>>): Response | null {
  for (const key of ["verifyFallback", "verifySecondFallback"] as const) {
    const harness = (body[key] as { harness?: string } | null | undefined)?.harness?.trim()
    if (harness && !Object.hasOwn(adapters, harness)) {
      return err(`${key}.harness '${harness}' is not a harness this daemon has (it has: ${Object.keys(adapters).join(", ")})`, 400);
    }
  }
  return null;
}

/** POST /api/projects */
export function addProjectRoute(req: Request, cfg: WispConfig, adapters: Readonly<Record<string, unknown>>): Promise<Response> {
  return (async () => {
    const parsed = await jsonObjectBody(req);
    if (parsed instanceof Response) return parsed;
    const body = parsed as ProjectUpdateBody;
    const invalid = projectUpdateError(body) ?? unknownFallbackError(body, adapters);
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
        verify: saved?.verify ?? null,
        verifySecond: saved?.verifySecond ?? null,
        verifyFallback: saved?.verifyFallback ?? null,
        verifySecondFallback: saved?.verifySecondFallback ?? null,
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

/** The refusal the sidebar shows when its drag was based on a list that has since changed. */
const STALE_ORDER = "The project list changed since it was loaded. Reload and try again."

/** A refusal names a few paths, never every one a body could carry. */
function firstFew(paths: string[]): string {
  return paths.length > 3 ? `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more` : paths.join(", ");
}

/**
 * PUT /api/repos/order { paths } — put the configured projects in the order
 * `paths` gives. `paths` must name every configured project exactly once
 * (resolved, as GET /api/repos serves them); anything else means the client
 * reordered a list that has since changed, and is refused rather than merged.
 * Each entry object is kept as it is: only its position moves.
 */
export function reorderReposRoute(req: Request, cfg: WispConfig): Promise<Response> {
  return (async () => {
    const parsed = await jsonObjectBody(req);
    if (parsed instanceof Response) return parsed;
    const { paths } = parsed as { paths?: unknown };
    if (!Array.isArray(paths) || paths.some((value) => typeof value !== "string" || value.length === 0)) {
      return err(`paths must be an array of project paths, got ${typeName(paths)}`, 400);
    }
    // resolve() would read a relative path against the daemon's own cwd
    const relative = (paths as string[]).find((path) => !isAbsolute(path));
    if (relative !== undefined) return err(`path must be absolute: ${relative}`, 400);
    // a config may list one project twice (a string and an object entry):
    // GET /api/repos shows it once, so it moves as one, every entry kept
    const byPath = new Map<string, RepoEntry[]>();
    for (const entry of cfg.repos) {
      const resolved = resolve(repoEntryPath(entry));
      byPath.set(resolved, [...(byPath.get(resolved) ?? []), entry]);
    }
    const asked = (paths as string[]).map((path) => resolve(path));
    const unique = new Set(asked);
    if (unique.size !== asked.length) return err(`${STALE_ORDER} (a project is listed twice)`, 409);
    const missing = [...byPath.keys()].filter((path) => !unique.has(path));
    const extra = asked.filter((path) => !byPath.has(path));
    if (extra.length > 0) return err(`${STALE_ORDER} (not a configured project: ${firstFew(extra)})`, 409);
    if (missing.length > 0) return err(`${STALE_ORDER} (missing: ${firstFew(missing)})`, 409);
    persistRepos(cfg, asked.flatMap((path) => byPath.get(path)!));
    emit({ type: "project", action: "reorder", paths: asked });
    return json({ paths: asked });
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
        const result = await archiveTaskRows(activeTasks, false, cfg, {
          stopAutopilot: true,
          actor: requestActor(req),
          reason: "project removed from Wisp",
        });
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
