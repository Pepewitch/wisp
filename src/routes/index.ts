/**
 * The /api dispatcher. Everything here has already passed the daemon's auth
 * gate; each handler module owns one family of routes and takes the request
 * context (cfg, adapters, models) explicitly, because a daemon is constructed
 * per serve() call and nothing about it may become a module-level singleton.
 *
 * The if-chain's ORDER is behaviour: the log-stream regex must be tested
 * before the generic /api/tasks/:id pattern, and the task block falls through
 * (returns null) so a non-task path reaches the routes below it.
 */
import type { AdapterDef } from "../adapters";
import { TaskCompactor, type TaskCompactorOptions } from "../compacts";
import type { WispConfig } from "../config";
import { ModelProbeCache, type ModelProbeCacheOptions } from "../model-probes";
import { TaskProbeCache, type TaskProbeCacheOptions } from "../probes";
import { PullRequestCache, type PullRequestCacheOptions } from "../pull-requests";
import { TaskSkillCache, type TaskSkillCacheOptions } from "../skills";
import { UpdateManager } from "../update";
import { getTask, listTasks } from "../store";
import { harnessesRoute, outboxRoute } from "./harnesses";
import { err, json } from "./http";
import { addProjectRoute, copyPreviewRoute, removeProjectRoute, reposRoute, statusRoute } from "./projects";
import { eventStream, logStream } from "./stream";
import {
  createSuffixPromptRoute,
  deleteSuffixPromptRoute,
  listSuffixPromptsRoute,
  updateSuffixPromptRoute,
} from "./suffix-prompts";
import { attachmentRoute, taskMessageRoute } from "./task-messages";
import { createTaskRoute, listTasksRoute, taskRoute } from "./tasks";
import { updateRoute } from "./update";

const standaloneModelCaches = new WeakMap<Record<string, AdapterDef>, ModelProbeCache>();
const standaloneProbeCaches = new WeakMap<Record<string, AdapterDef>, TaskProbeCache>();
const standaloneSkillCaches = new WeakMap<Record<string, AdapterDef>, TaskSkillCache>();
const standaloneCompactors = new WeakMap<Record<string, AdapterDef>, TaskCompactor>();
const standalonePullRequestCaches = new WeakMap<WispConfig, PullRequestCache>();
const standaloneUpdateManagers = new WeakMap<WispConfig, UpdateManager>();

function modelCacheFor(adapters: Record<string, AdapterDef>, options?: ModelProbeCacheOptions): ModelProbeCache {
  const existing = standaloneModelCaches.get(adapters);
  if (existing) return existing;
  const cache = new ModelProbeCache(adapters, options);
  standaloneModelCaches.set(adapters, cache);
  return cache;
}

function probeCacheFor(adapters: Record<string, AdapterDef>, options?: TaskProbeCacheOptions): TaskProbeCache {
  const existing = standaloneProbeCaches.get(adapters);
  if (existing) return existing;
  const cache = new TaskProbeCache(options);
  standaloneProbeCaches.set(adapters, cache);
  return cache;
}

function skillCacheFor(adapters: Record<string, AdapterDef>, options?: TaskSkillCacheOptions): TaskSkillCache {
  const existing = standaloneSkillCaches.get(adapters);
  if (existing) return existing;
  const cache = new TaskSkillCache(options);
  standaloneSkillCaches.set(adapters, cache);
  return cache;
}

function compactorFor(adapters: Record<string, AdapterDef>, options?: TaskCompactorOptions): TaskCompactor {
  const existing = standaloneCompactors.get(adapters);
  if (existing) return existing;
  const compactor = new TaskCompactor(options);
  standaloneCompactors.set(adapters, compactor);
  return compactor;
}

function pullRequestCacheFor(cfg: WispConfig, options?: PullRequestCacheOptions): PullRequestCache {
  const existing = standalonePullRequestCaches.get(cfg);
  if (existing) return existing;
  const cache = new PullRequestCache(options);
  standalonePullRequestCaches.set(cfg, cache);
  return cache;
}

function updateManagerFor(cfg: WispConfig): UpdateManager {
  const existing = standaloneUpdateManagers.get(cfg);
  if (existing) return existing;
  const manager = new UpdateManager();
  standaloneUpdateManagers.set(cfg, manager);
  return manager;
}

function taskRoutes(
  req: Request,
  url: URL,
  path: string,
  method: string,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
  probes: TaskProbeCache,
  skills: TaskSkillCache,
  compacts: TaskCompactor,
  pullRequests: PullRequestCache,
): Response | Promise<Response> | null {
  if (path === "/api/events" && method === "GET") return eventStream();
  const logStreamMatch = path.match(/^\/api\/tasks\/([a-z0-9]+)\/log\/stream$/);
  if (logStreamMatch && method === "GET") {
    const task = getTask(logStreamMatch[1]!);
    if (!task) return err(`no such task: ${logStreamMatch[1]}`, 404);
    return logStream(task, url, adapters);
  }
  const attachmentResponse = attachmentRoute(path, method);
  if (attachmentResponse !== null) return attachmentResponse;
  const messageResponse = taskMessageRoute(req, path, method);
  if (messageResponse !== null) return messageResponse;
  if (path === "/api/tasks" && method === "GET") return listTasksRoute(url);
  if (path === "/api/tasks" && method === "POST") return createTaskRoute(req, cfg, adapters);
  if (path === "/api/pull-requests" && method === "GET") {
    return pullRequests.overview(listTasks()).then((overview) => json(overview));
  }
  return taskRoute(req, url, path, method, cfg, adapters, probes, skills, compacts, pullRequests);
}

function projectRoutes(
  req: Request,
  path: string,
  method: string,
  cfg: WispConfig,
): Response | Promise<Response> | null {
  if (path === "/api/status" && method === "GET") return statusRoute();
  if (path === "/api/repos" && method === "GET") return reposRoute(cfg);
  if (path === "/api/projects" && method === "POST") return addProjectRoute(req, cfg);
  if (path === "/api/projects/copy-preview" && method === "POST") return copyPreviewRoute(req);
  if (path === "/api/projects" && method === "DELETE") return removeProjectRoute(req, cfg);
  return null;
}

function suffixPromptRoutes(req: Request, path: string, method: string): Response | Promise<Response> | null {
  if (path === "/api/suffix-prompts" && method === "GET") return listSuffixPromptsRoute();
  if (path === "/api/suffix-prompts" && method === "POST") return createSuffixPromptRoute(req);
  const match = path.match(/^\/api\/suffix-prompts\/([^/]+)$/);
  if (match && method === "PATCH") return updateSuffixPromptRoute(req, match[1]!);
  if (match && method === "DELETE") return deleteSuffixPromptRoute(match[1]!);
  return null;
}

export function route(
  req: Request,
  url: URL,
  path: string,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
  modelCache?: ModelProbeCache,
  probeCache?: TaskProbeCache,
  skillCache?: TaskSkillCache,
  compactor?: TaskCompactor,
  pullRequestCache?: PullRequestCache,
  updateManager?: UpdateManager,
): Response | Promise<Response> {
  const m = req.method;
  const models = modelCache ?? modelCacheFor(adapters);
  const probes = probeCache ?? probeCacheFor(adapters);
  const skills = skillCache ?? skillCacheFor(adapters);
  const compacts = compactor ?? compactorFor(adapters);
  const pullRequests = pullRequestCache ?? pullRequestCacheFor(cfg);
  const updates = updateManager ?? updateManagerFor(cfg);

  const updateResponse = updateRoute(req, path, m, updates);
  if (updateResponse !== null) return updateResponse;

  const taskResponse = taskRoutes(req, url, path, m, cfg, adapters, probes, skills, compacts, pullRequests);
  if (taskResponse !== null) return taskResponse;

  const projectResponse = projectRoutes(req, path, m, cfg);
  if (projectResponse !== null) return projectResponse;

  const suffixPromptResponse = suffixPromptRoutes(req, path, m);
  if (suffixPromptResponse !== null) return suffixPromptResponse;

  if (path === "/api/harnesses" && m === "GET") return harnessesRoute(url, cfg, adapters, models);

  if (path === "/api/outbox" && m === "GET") return outboxRoute();

  return err("not found", 404);
}
