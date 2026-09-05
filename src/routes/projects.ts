import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { CONFIG_PATH, type RepoConfig, type WispConfig } from "../config";
import { emit } from "../events";
import { directoryExists, pathExists } from "../fsutil";
import { listTasks } from "../store";
import { taskMode } from "../types";
import { typeName } from "../validate";
import { matchCopyFiles, statusSummary, worktreeHealth } from "../worktree";
import { err, json } from "./http";

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
  let raw: Record<string, unknown> = {};
  if (existsSync(CONFIG_PATH)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (error) {
      throw new Error(`config.json: invalid JSON — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`config.json: top level must be an object, got ${Array.isArray(parsed) ? "array" : typeName(parsed)}`);
    }
    raw = parsed as Record<string, unknown>;
  }
  raw.repos = repos;
  const temp = `${CONFIG_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, CONFIG_PATH);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  cfg.repos = repos;
}

/** Cap on a git failure sentence served as a status reason — the pane caps it again. */
const REASON_CAP = 200;

/**
 * GET /api/status
 *
 * Every live task with a worktree gets an entry, always. A task whose worktree
 * git can no longer read carries its BRANCH AND THE REASON and no counts (D1):
 * omitting the row or reporting zeros are the two ways this endpoint used to lie
 * about a broken worktree, and the sidebar believed it.
 */
export function statusRoute(): Promise<Response> {
  return (async () => {
    // per-task probes run CONCURRENTLY — one unreadable worktree must never 500
    // the rest, and must never cost another task its marks
    const live = listTasks().filter((t) => t.worktree_path !== null && t.branch !== null);
    const rows = await Promise.all(
      live.map(async (t): Promise<[string, unknown]> => {
        try {
          const health = await worktreeHealth(t.worktree_path!);
          if (!health.ok) return [t.id, { branch: t.branch, worktreeReason: health.reason }];
          // local: no base (see the diff route) — "ahead" would otherwise
          // count the human's own commits on their own branch
          const base = taskMode(t) === "local" ? null : t.base_commit;
          const summary = await statusSummary(t.worktree_path!, t.branch!, base);
          return [t.id, { branch: t.branch, ...summary, worktreeReason: null }];
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.warn(`[wisp] /api/status: task ${t.id} (${t.worktree_path}): ${message}`);
          return [t.id, { branch: t.branch, worktreeReason: `Git could not read this worktree — ${message}`.slice(0, REASON_CAP) }];
        }
      }),
    );
    return json({ tasks: Object.fromEntries(rows) });
  })();
}

/** GET /api/repos */
export function reposRoute(cfg: WispConfig): Promise<Response> {
  return (async () => {
    // cfg.repos pins + the repo_path of every existing task (archived rows
    // included — archive is not delete, and the form should still offer the
    // repo), deduped by resolved path; exists-probes run concurrently.
    const configured = cfg.repos.map((entry) => ({ path: repoEntryPath(entry), entry }));
    const history = listTasks(true).map((t) => ({ path: t.repo_path, entry: undefined as RepoEntry | undefined }));
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
}

function projectUpdateError(body: ProjectUpdateBody): Response | null {
  if (typeof body.path !== "string" || body.path.length === 0) return err("path is required", 400);
  if (body.name !== undefined && typeof body.name !== "string") {
    return err(`name must be a string, got ${typeName(body.name)}`, 400);
  }
  for (const key of ["setupScript", "archiveScript"] as const) {
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
  return Object.keys(merged).length === 1 ? resolved : merged;
}

/** POST /api/projects */
export function addProjectRoute(req: Request, cfg: WispConfig): Promise<Response> {
  return (async () => {
    const body = (await req.json().catch(() => ({}))) as ProjectUpdateBody;
    const invalid = projectUpdateError(body);
    if (invalid) return invalid;
    // projectUpdateError narrowed the runtime value; bind that fact for the
    // async filesystem checks and merge helpers below.
    const path = body.path as string;
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
    const body = (await req.json().catch(() => ({}))) as { path?: unknown; patterns?: unknown };
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
    const body = (await req.json().catch(() => ({}))) as { path?: unknown };
    if (typeof body.path !== "string" || body.path.length === 0) return err("path is required", 400);
    const resolved = resolve(body.path);
    const next = cfg.repos.filter((entry) => resolve(repoEntryPath(entry)) !== resolved);
    if (next.length === cfg.repos.length) {
      const historical = listTasks(true).some((task) => resolve(task.repo_path) === resolved);
      if (historical) return err(`project '${resolved}' exists only in task history and is not configured`, 404);
      return err(`project not found in config repos: ${resolved}`, 404);
    }
    persistRepos(cfg, next);
    emit({ type: "project", action: "remove", path: resolved });
    return json({ ok: true, path: resolved });
  })();
}
