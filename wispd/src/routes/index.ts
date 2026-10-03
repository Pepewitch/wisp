/**
 * The /api dispatcher. Everything here has already passed the daemon's auth
 * gate; each handler module owns one family of routes and takes what it needs
 * from the daemon's RouteContext explicitly, because a daemon is constructed
 * per serve() call and nothing about it may become a module-level singleton.
 *
 * The if-chain's ORDER is behaviour: the nested log regexes must be tested
 * before the generic /api/tasks/:id pattern, and the task block falls through
 * (returns null) so a non-task path reaches the routes below it.
 */
import type { AdapterDef } from "../adapters";
import type { TaskCompactor } from "../compacts";
import type { WispConfig } from "../config";
import type { RouteContext } from "../daemon-context";
import type { ModelProbeCache } from "../model-probes";
import type { TaskProbeCache } from "../probes";
import type { HarnessLimitsCache } from "../harness-limits";
import type { PullRequestCache } from "../pull-requests";
import type { TaskSkillCache } from "../skills";
import { getTask, listTasks } from "../store";
import { harnessesRoute, outboxRoute } from "./harnesses";
import { diagnosticsRoute } from "./diagnostics";
import { err, json } from "./http";
import { addProjectRoute, copyPreviewRoute, removeProjectRoute, reposRoute, statusRoute } from "./projects";
import { eventStream, logStream } from "./stream";
import {
  createSuffixPromptRoute,
  deleteSuffixPromptRoute,
  listSuffixPromptsRoute,
  updateSuffixPromptRoute,
} from "./suffix-prompts";
import { outputRoute } from "./outputs";
import { attachmentRoute, taskMessageRoute, taskMessageSendNowRoute } from "./task-messages";
import { createTaskRoute, listTasksRoute, taskRoute } from "./tasks";
import { updateRoute } from "./update";
import { capabilitiesRoute } from "./capabilities";
import { terminalOriginRoute } from "./auth";
import { TERMINALS_PATH, terminalsRoute } from "./terminals";
import { searchRoute } from "./search";
import { diagnosticLog } from "./diagnostic";
import { bulkPurgeRoute } from "./bulk-purge";
import { workflowRoute } from "./workflows";
import { AUTOPILOT_PATH, autopilotRoute } from "./autopilot";
import { BRIEF_PATH, briefRoute } from "./task-brief";
import { settingsRoute } from "./settings";
import { harnessLimitsRoute } from "./harness-limits";
import {
  attachmentUploadRoute,
  discardAttachmentUploadRoute,
} from "./attachment-uploads";

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
  models: ModelProbeCache,
): Response | Promise<Response> | null {
  if (path === "/api/events" && method === "GET") return eventStream();
  const diagnosticLogMatch = path.match(/^\/api\/tasks\/([a-z0-9]+)\/log\/diagnostic$/);
  if (diagnosticLogMatch && method === "GET") {
    const task = getTask(diagnosticLogMatch[1]!);
    if (!task) return err(`no such task: ${diagnosticLogMatch[1]}`, 404);
    return diagnosticLog(task, url, cfg);
  }
  const logStreamMatch = path.match(/^\/api\/tasks\/([a-z0-9]+)\/log\/stream$/);
  if (logStreamMatch && method === "GET") {
    const task = getTask(logStreamMatch[1]!);
    if (!task) return err(`no such task: ${logStreamMatch[1]}`, 404);
    return logStream(task, url, adapters);
  }
  const outputResponse = outputRoute(req, url, path, method);
  if (outputResponse !== null) return outputResponse;
  const attachmentResponse = attachmentRoute(path, method);
  if (attachmentResponse !== null) return attachmentResponse;
  const messageResponse = taskMessageRoute(req, path, method);
  if (messageResponse !== null) return messageResponse;
  const sendNowResponse = taskMessageSendNowRoute(req, path, method, cfg, adapters, compacts);
  if (sendNowResponse !== null) return sendNowResponse;
  if (path === "/api/tasks" && method === "GET") return listTasksRoute(url);
  if (path === "/api/tasks" && method === "POST") return createTaskRoute(req, cfg, adapters, models);
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
  if (path === "/api/status" && method === "GET") return statusRoute(req);
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

/** GET /api/harnesses and GET /api/harness-limits: what each harness can do, and how much of its plan is left. */
function harnessRoutes(
  url: URL,
  path: string,
  method: string,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
  models: ModelProbeCache,
  limits: HarnessLimitsCache,
): Response | Promise<Response> | null {
  if (method !== "GET") return null;
  if (path === "/api/harnesses") return harnessesRoute(url, cfg, adapters, models);
  if (path === "/api/harness-limits") return harnessLimitsRoute(url, cfg, adapters, limits);
  return null;
}

/** The task sub-resources whose paths have more than one segment after the id. */
function taskFamilyRoute(
  req: Request,
  url: URL,
  path: string,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
): Response | Promise<Response> | null {
  if (path === "/api/workflow-types" || /^\/api\/(?:workflows\/|tasks\/[a-z0-9]+\/workflows$)/.test(path)) return workflowRoute(req, path);
  if (AUTOPILOT_PATH.test(path)) return autopilotRoute(req, path);
  if (BRIEF_PATH.test(path)) return briefRoute(req, path, cfg, adapters);
  if (TERMINALS_PATH.test(path)) return terminalsRoute(req, url, path, cfg);
  return null;
}

export function route(req: Request, url: URL, path: string, ctx: RouteContext): Response | Promise<Response> {
  const m = req.method;
  const { cfg, adapters } = ctx;
  const family = taskFamilyRoute(req, url, path, cfg, adapters);
  if (family !== null) return family;
  const { models, probes, skills, compacts, pullRequests, updates, limits } = ctx.caches;

  if (path === "/api/capabilities" && m === "GET") return capabilitiesRoute(cfg);
  const settingsResponse = settingsRoute(req, path, m, cfg, undefined, { cache: limits, adapters });
  if (settingsResponse !== null) return settingsResponse;
  // The terminal socket's own gate, asked as a plain request: a page whose
  // upgrade died cannot read the 403 that explained it, so it asks here.
  if (path === "/api/terminal-origin" && m === "POST") return terminalOriginRoute(req, url);
  if (path === "/api/purge") return bulkPurgeRoute(req, url, [probes, skills]);
  if (path === "/api/attachments" && m === "POST") return attachmentUploadRoute(req, url);
  const uploadMatch = path.match(/^\/api\/attachments\/([A-Za-z0-9-]+)$/);
  if (uploadMatch && m === "DELETE") return discardAttachmentUploadRoute(uploadMatch[1]!);

  const updateResponse = updateRoute(req, path, m, updates);
  if (updateResponse !== null) return updateResponse;

  const taskResponse = taskRoutes(req, url, path, m, cfg, adapters, probes, skills, compacts, pullRequests, models);
  if (taskResponse !== null) return taskResponse;

  const projectResponse = projectRoutes(req, path, m, cfg);
  if (projectResponse !== null) return projectResponse;

  const suffixPromptResponse = suffixPromptRoutes(req, path, m);
  if (suffixPromptResponse !== null) return suffixPromptResponse;

  const searchResponse = searchRoute(req, url, m);
  if (searchResponse !== null) return searchResponse;

  const harnessResponse = harnessRoutes(url, path, m, cfg, adapters, models, limits);
  if (harnessResponse !== null) return harnessResponse;

  if (path === "/api/outbox" && m === "GET") return outboxRoute();
  if (path === "/api/diagnostics" && m === "GET") return diagnosticsRoute();

  return err("not found", 404);
}
