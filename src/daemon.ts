import { loadAdapters } from "./adapters";
import { checkHarnessDefaults, CONFIG_PATH, loadConfig } from "./config";
import { ModelProbeCache, type ModelProbeCacheOptions } from "./model-probes";
import { TaskCompactor, type TaskCompactorOptions } from "./compacts";
import { startOutboxLoop } from "./outbox";
import { TaskProbeCache, type TaskProbeCacheOptions } from "./probes";
import { PullRequestCache, type PullRequestCacheOptions } from "./pull-requests";
import { TaskSkillCache, type TaskSkillCacheOptions } from "./skills";
import { failStaleCreatingTasks, recoverOrphanedTurns, startStuckLoop } from "./runner";
import { route } from "./routes";
import { authorized, postSession } from "./routes/auth";
import { err, json } from "./routes/http";
import { getTask } from "./store";
import { MAX_SHELLS_PER_TASK, openSession, type TerminalClient } from "./terminal";
import { BUILD_INFO } from "./version";
// The web app's committed single-file bundle (skills/wisp-dev/references/frontend.md: never
// hand-edit ui-dist; regenerate with `bun run build:ui`) — committed so this
// import never breaks `bun test` on a fresh checkout. Everything it needs,
// xterm included, is inlined: the daemon serves ONE file and no assets.
import appHtml from "../web/ui-dist/index.html" with { type: "text" };

// The route handlers live in ./routes now, but tests and the CLI import these
// names from "./daemon" — the entrypoint's public surface is unchanged.
export { authorized, postSession, route };

type TerminalSocketData = { taskId: string; shellId: number };
type TerminalSocket = Bun.ServerWebSocket<TerminalSocketData>;
const terminalBindings = new WeakMap<TerminalSocket, { session: ReturnType<typeof openSession>; client: TerminalClient }>();

function wsError(ws: TerminalSocket, message: string): void {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", message }));
}

async function attachTerminal(ws: TerminalSocket): Promise<void> {
  try {
    const task = getTask(ws.data.taskId);
    if (!task) throw new Error(`no such task: ${ws.data.taskId}`);
    if (!task.worktree_path) throw new Error(`task ${task.id} has no worktree_path`);
    const session = openSession(task.id, ws.data.shellId, task.worktree_path);
    const client: TerminalClient = {
      isOpen: () => ws.readyState === 1,
      sendOutput: (data) => ws.send(JSON.stringify({ type: "out", data })),
      sendError: (message) => wsError(ws, message),
      sendExit: (code) => ws.send(JSON.stringify({ type: "exit", code })),
    };
    session.attach(client); // replaces any prior browser attachment; the shell itself survives
    terminalBindings.set(ws, { session, client });
    // `replay` is what the shell has already printed. The client RESETS its
    // xterm and writes this, so a reattached tab shows the session it left
    // rather than a blank screen in front of a still-running shell.
    ws.send(JSON.stringify({ type: "hello", pty: session.pty, cwd: session.cwd, replay: session.scrollback() }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    wsError(ws, message);
    ws.close(1011, message.slice(0, 120));
  }
}

function terminalMessage(ws: TerminalSocket, message: string | Buffer<ArrayBuffer>): void {
  const binding = terminalBindings.get(ws);
  if (!binding) {
    wsError(ws, `terminal task ${ws.data.taskId}: client is not attached`);
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(String(message));
  } catch (error) {
    wsError(ws, `terminal protocol: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    wsError(ws, "terminal protocol: message must be a JSON object");
    return;
  }
  const value = body as Record<string, unknown>;
  if (value.type === "in") {
    let data: string | Uint8Array;
    if (typeof value.data === "string") {
      data = value.data;
    } else if (
      Array.isArray(value.data) &&
      value.data.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)
    ) {
      data = new Uint8Array(value.data as number[]);
    } else {
      wsError(ws, 'terminal protocol: "in" data must be a string or an array of byte values');
      return;
    }
    void binding.session.write(binding.client, data).catch((error) => {
      if (binding.session.accepts(binding.client)) wsError(ws, error instanceof Error ? error.message : String(error));
    });
    return;
  }
  if (value.type === "resize") {
    const cols = value.cols;
    const rows = value.rows;
    if (
      typeof cols !== "number" ||
      typeof rows !== "number" ||
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > 1000 ||
      rows > 1000
    ) {
      wsError(ws, "terminal protocol: resize cols and rows must be integers from 1 to 1000");
      return;
    }
    void binding.session.resize(binding.client, cols, rows).catch((error) => {
      if (binding.session.accepts(binding.client)) wsError(ws, error instanceof Error ? error.message : String(error));
    });
    return;
  }
  wsError(ws, `terminal protocol: unknown message type '${String(value.type)}'`);
}

export interface ServeOptions {
  /** Test-only listener override. Persisted user configuration remains unchanged. */
  port?: number;
  modelProbeSpawn?: ModelProbeCacheOptions["spawn"];
  modelProbeTimeoutMs?: number;
  /** A3 test injection: fake the harness CLIs the probe strategies would spawn */
  probeSpawnOnce?: TaskProbeCacheOptions["spawnOnce"];
  probeOpenRpc?: TaskProbeCacheOptions["openRpc"];
  probeTimeoutMs?: number;
  /** A4 test injection: the same for the skill-discovery strategies */
  skillSpawnOnce?: TaskSkillCacheOptions["spawnOnce"];
  skillOpenRpc?: TaskSkillCacheOptions["openRpc"];
  skillTimeoutMs?: number;
  /** A5 test injection: the same for the compaction strategies */
  compactSpawnOnce?: TaskCompactorOptions["spawnOnce"];
  compactOpenRpc?: TaskCompactorOptions["openRpc"];
  compactTimeoutMs?: number;
  /** Read-only forge lookup injection; production uses the authenticated `gh` CLI. */
  pullRequestRun?: PullRequestCacheOptions["run"];
  pullRequestTimeoutMs?: number;
  pullRequestCacheTtlMs?: number;
}

async function occupiedListener(host: string, port: number): Promise<string> {
  const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host;
  try {
    const response = await fetch(`http://${probeHost}:${port}/api/health`, {
      signal: AbortSignal.timeout(750),
    });
    const body = (await response.json()) as { ok?: unknown; version?: unknown; commit?: unknown };
    if (response.ok && body.ok === true && typeof body.version === "string" && typeof body.commit === "string") {
      return `another Wisp daemon (${body.version}, commit ${body.commit})`;
    }
  } catch {
    // A listener that is not Wisp may reject HTTP, TLS, or the health route.
  }
  return "a non-Wisp service";
}

export async function portConflictMessage(host: string, port: number): Promise<string> {
  const owner = await occupiedListener(host, port);
  return [
    `${host}:${port} is already in use by ${owner}.`,
    "Wisp did not stop that process or change the persisted port.",
    `Inspect the listener, then stop the unintended process or edit the numeric port in ${CONFIG_PATH} and restart Wisp.`,
  ].join(" ");
}

function bindFailure(host: string, port: number): unknown | undefined {
  try {
    const listener = Bun.listen({ hostname: host, port, socket: { data() {} } });
    listener.stop(true);
    return undefined;
  } catch (error) {
    return error;
  }
}

export async function serve(options: ServeOptions = {}): Promise<Bun.Server<TerminalSocketData>> {
  const cfg = loadConfig();
  const hostname = process.env.WISP_HOST ?? cfg.host;
  const port = options.port ?? cfg.port;
  // Do this before recovery or loops mutate shared state. A second daemon
  // aimed at the same home must fail before touching live task lifecycle.
  const preflightFailure = port === 0 ? undefined : bindFailure(hostname, port);
  if (preflightFailure) {
    if ((preflightFailure as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(await portConflictMessage(hostname, port), { cause: preflightFailure });
    }
    throw preflightFailure;
  }
  const adapters = loadAdapters();
  const modelCache = new ModelProbeCache(adapters, {
    spawn: options.modelProbeSpawn,
    timeoutMs: options.modelProbeTimeoutMs,
  });
  const probeCache = new TaskProbeCache({
    spawnOnce: options.probeSpawnOnce,
    openRpc: options.probeOpenRpc,
    timeoutMs: options.probeTimeoutMs,
  });
  const skillCache = new TaskSkillCache({
    spawnOnce: options.skillSpawnOnce,
    openRpc: options.skillOpenRpc,
    timeoutMs: options.skillTimeoutMs,
  });
  const compactor = new TaskCompactor({
    spawnOnce: options.compactSpawnOnce,
    openRpc: options.compactOpenRpc,
    timeoutMs: options.compactTimeoutMs,
  });
  const pullRequests = new PullRequestCache({
    run: options.pullRequestRun,
    timeoutMs: options.pullRequestTimeoutMs,
    ttlMs: options.pullRequestCacheTtlMs,
  });
  // P5b loud fallback: only here does the merged adapter set exist to check
  // harnessDefaults against — warn at every boot, never crash
  checkHarnessDefaults(cfg, adapters);
  // awaited before the port opens: a request must never observe a half-finished sweep
  await recoverOrphanedTurns(adapters, cfg);
  failStaleCreatingTasks(); // a 'creating' row at boot belongs to a dead daemon (a prior audit)
  startOutboxLoop(cfg);
  startStuckLoop(cfg);

  let server: Bun.Server<TerminalSocketData>;
  try {
    server = Bun.serve({
      port,
      hostname,
      idleTimeout: 30,
      websocket: {
        data: {} as TerminalSocketData,
        open(ws) {
          void attachTerminal(ws);
        },
        message(ws, message) {
          terminalMessage(ws, message);
        },
        close(ws) {
          const binding = terminalBindings.get(ws);
          if (!binding) return;
          binding.session.detach(binding.client);
          terminalBindings.delete(ws);
        },
      },
      fetch(req: Request, server: Bun.Server<TerminalSocketData>): Response | Promise<Response> | undefined {
        const url = new URL(req.url);
        const path = url.pathname;
        if (path === "/" || path === "/index.html") {
          // typed as HTMLBundle by @types/bun, but `with { type: "text" }` yields a string at runtime
          return new Response(appHtml as unknown as string, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        if (path === "/api/health") return json({ ok: true, ...BUILD_INFO });
        // the ONLY unauthenticated /api route — it mints the cookie the browser streams authenticate with
        if (path === "/api/session" && req.method === "POST") return postSession(req, cfg);
        if (!path.startsWith("/api/")) return err("not found", 404);
        if (!authorized(req, cfg)) return err("unauthorized", 401);
        const terminalMatch = path.match(/^\/api\/tasks\/([a-z0-9]+)\/terminal$/);
        if (terminalMatch && req.method === "GET") {
          const taskId = terminalMatch[1]!;
          const task = getTask(taskId);
          if (!task) return err(`no such task: ${taskId}`, 404);
          if (task.archived) return err(`task ${taskId} is archived — worktree removed`, 409);
          if (!task.worktree_path) return err(`task ${taskId} has no worktree_path`, 409);
          // ?shell=N addresses one of the pane's tabs; absent means the first,
          // which is what every pre-tabs client sent
          const shellParam = url.searchParams.get("shell");
          const shellId = shellParam === null ? 0 : Number(shellParam);
          if (!Number.isInteger(shellId) || shellId < 0 || shellId >= MAX_SHELLS_PER_TASK) {
            return err(`shell must be an integer from 0 to ${MAX_SHELLS_PER_TASK - 1}, got ${JSON.stringify(shellParam)}`, 400);
          }
          if (!server.upgrade(req, { data: { taskId, shellId } })) return err("websocket upgrade failed", 500);
          return undefined;
        }
        return Promise.resolve()
          .then(() =>
            route(req, url, path, cfg, adapters, modelCache, probeCache, skillCache, compactor, pullRequests),
          )
          .catch((e) => err(String(e instanceof Error ? e.message : e), 500));
      },
    });
  } catch (error) {
    if (port !== 0 && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(await portConflictMessage(hostname, port), { cause: error });
    }
    throw error;
  }
  // Model discovery is deliberately after Bun.serve: listening never waits on
  // a harness CLI, and /api/harnesses serves the cache while this runs.
  void modelCache.refresh();
  console.log(
    `wispd listening on http://${hostname}:${server.port} (token in ${process.env.WISP_HOME ?? "~/.wisp"}/config.json)`,
  );
  return server;
}
