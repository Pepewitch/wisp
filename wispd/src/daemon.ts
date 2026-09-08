import { loadAdapters } from "./adapters";
import { checkHarnessDefaults, CONFIG_PATH, loadConfig, type WispConfig } from "./config";
import { ModelProbeCache, type ModelProbeCacheOptions } from "./model-probes";
import { TaskCompactor, type TaskCompactorOptions } from "./compacts";
import { startOutboxLoop } from "./outbox";
import { TaskProbeCache, type TaskProbeCacheOptions } from "./probes";
import { PullRequestCache, type PullRequestCacheOptions } from "./pull-requests";
import { maintainDiagnosticArchives } from "./recording/diagnostic";
import { TaskSkillCache, type TaskSkillCacheOptions } from "./skills";
import { failStaleCreatingTasks, recoverOrphanedTurns, startStuckLoop } from "./runner";
import { resumeArchiveCleanups, startArchiveCleanupLoop } from "./routes/archive";
import { route } from "./routes";
import { acquireHomeOwnership, HomeBusyError } from "./home-lock";
import { authorized, originVerdict, postSession, tokenAuthorizes } from "./routes/auth";
import { err, json } from "./routes/http";
import { pageSecurityHeaders, pageSecurityPolicy } from "./routes/security-headers";
import { getTask } from "./store";
import type { PtySize } from "./pty";
import { DEFAULT_PTY_SIZE, MAX_SHELLS_PER_TASK, openSession, type TerminalClient } from "./terminal";
import { BUILD_INFO } from "./version";
import { UpdateManager } from "./update";
// The generated single-file app is loaded only when the daemon starts. That
// keeps source-only CLI commands usable before a checkout has built ui-dist;
// supported serve/test/build entry points generate it first. Bun embeds this
// literal import in compiled release binaries, so production needs no sibling
// asset directory. Everything the page needs, xterm included, is inlined.
async function bundledAppHtml(): Promise<string> {
  const bundle = await import("../../web/ui-dist/index.html", { with: { type: "text" } });
  return bundle.default as unknown as string;
}

// The route handlers live in ./routes now, but tests and the CLI import these
// names from "./daemon" — the entrypoint's public surface is unchanged.
export { authorized, postSession, route };

type TerminalSocketData = {
  taskId: string;
  shellId: number;
  size: PtySize | null;
  /**
   * False for a browser socket: a WebSocket handshake cannot carry an
   * Authorization header, so the browser proves itself in the first frame
   * instead. Nothing is attached and no shell is spawned until this is true.
   */
  authenticated: boolean;
};
type TerminalSocket = Bun.ServerWebSocket<TerminalSocketData>;

/**
 * The pane's geometry from the upgrade query, or null when the client did not
 * measure itself (an older UI). Returns the error message on bad input, since
 * a garbled size must be a 400 rather than a silently defaulted shell.
 */
export function parseTerminalSize(params: URLSearchParams): PtySize | null | string {
  const raw = { cols: params.get("cols"), rows: params.get("rows") };
  if (raw.cols === null && raw.rows === null) return null;
  const cols = Number(raw.cols);
  const rows = Number(raw.rows);
  for (const [name, value] of [
    ["cols", cols],
    ["rows", rows],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      return `terminal ${name} must be an integer from 1 to 1000, got ${JSON.stringify(name === "cols" ? raw.cols : raw.rows)}`;
    }
  }
  return { cols, rows };
}

/** 32 MiB: comfortably above the attachment caps, far below "allocate whatever arrives". */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

const terminalBindings = new WeakMap<TerminalSocket, { session: ReturnType<typeof openSession>; client: TerminalClient }>();
/** Deadline timers for sockets still waiting to authenticate, so an unauthenticated one cannot linger. */
const terminalAuthDeadlines = new WeakMap<TerminalSocket, ReturnType<typeof setTimeout>>();
/** How long a browser socket has to send its `auth` frame before the daemon closes it. */
const TERMINAL_AUTH_TIMEOUT_MS = 10_000;

function wsError(ws: TerminalSocket, message: string): void {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", message }));
}

/**
 * A socket that upgraded without a credential. It gets one frame's worth of
 * patience: send `auth_required`, start a deadline, and attach nothing. The
 * page that opened it must know the token to get any further, which an
 * attacker's page on another origin does not.
 */
function openTerminal(ws: TerminalSocket): void {
  if (ws.data.authenticated) {
    void attachTerminal(ws);
    return;
  }
  ws.send(JSON.stringify({ type: "auth_required" }));
  terminalAuthDeadlines.set(
    ws,
    setTimeout(() => {
      terminalAuthDeadlines.delete(ws);
      if (ws.readyState !== 1) return;
      wsError(ws, "terminal authorization timed out");
      ws.close(1008, "terminal authorization timed out");
    }, TERMINAL_AUTH_TIMEOUT_MS),
  );
}

function clearTerminalAuthDeadline(ws: TerminalSocket): void {
  const deadline = terminalAuthDeadlines.get(ws);
  if (deadline === undefined) return;
  clearTimeout(deadline);
  terminalAuthDeadlines.delete(ws);
}

async function attachTerminal(ws: TerminalSocket): Promise<void> {
  try {
    const task = getTask(ws.data.taskId);
    if (!task) throw new Error(`no such task: ${ws.data.taskId}`);
    if (task.archived) throw new Error(`task ${task.id} is archived — worktree removed`);
    if (!task.worktree_path) throw new Error(`task ${task.id} has no worktree_path`);
    const session = openSession(task.id, ws.data.shellId, task.worktree_path, ws.data.size ?? DEFAULT_PTY_SIZE);
    const client: TerminalClient = {
      isOpen: () => ws.readyState === 1,
      sendOutput: (data) => ws.send(JSON.stringify({ type: "out", data })),
      sendError: (message) => wsError(ws, message),
      sendExit: (code) => ws.send(JSON.stringify({ type: "exit", code })),
    };
    session.attach(client); // replaces any prior browser attachment; the shell itself survives
    terminalBindings.set(ws, { session, client });
    // `replay` is a SNAPSHOT of the shell's screen as the daemon models it,
    // not the bytes that produced it. The client resets its xterm and writes
    // this, so a reattached tab shows the session it left — and, because it is
    // a picture rather than a re-run of history, it renders identically at
    // whatever width this pane happens to be.
    const replay = await session.scrollback();
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "hello", pty: session.pty, cwd: session.cwd, replay }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    wsError(ws, message);
    ws.close(1011, message.slice(0, 120));
  }
}

function terminalMessage(ws: TerminalSocket, message: string | Buffer<ArrayBuffer>, cfg: WispConfig): void {
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
  // The handshake, before there is anything to be attached to. A wrong token
  // closes the socket rather than answering again: this frame is the only
  // thing an unauthenticated socket may send, so retrying on it would turn a
  // terminal upgrade into an oracle.
  if (!ws.data.authenticated) {
    if (value.type !== "auth") {
      wsError(ws, "terminal protocol: this socket must authenticate first");
      ws.close(1008, "unauthorized");
      return;
    }
    if (!tokenAuthorizes(value.token, cfg)) {
      wsError(ws, "unauthorized");
      ws.close(1008, "unauthorized");
      return;
    }
    ws.data.authenticated = true;
    clearTerminalAuthDeadline(ws);
    void attachTerminal(ws);
    return;
  }
  if (value.type === "auth") return; // already authenticated at the upgrade; nothing to prove
  const binding = terminalBindings.get(ws);
  if (!binding) {
    wsError(ws, `terminal task ${ws.data.taskId}: client is not attached`);
    return;
  }
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
  /** Update-route injection. Production uses the GitHub release and platform installers. */
  updateManager?: UpdateManager;
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

/**
 * The sentence a losing daemon exits with. The health probe is what makes it
 * useful: it names the daemon that actually answered rather than asserting
 * something about a pid, and says plainly that nothing was changed — the whole
 * point of taking ownership before recovery runs.
 */
async function homeConflictMessage(host: string, port: number, reason: string): Promise<string> {
  const owner = await occupiedListener(host, port);
  return [
    `${process.env.WISP_HOME ?? "~/.wisp"} is already being served by ${owner}.`,
    "This process changed no tasks, claims, schema, or outbox rows and is exiting.",
    "Stop the running daemon before starting another, or point this one at a different WISP_HOME.",
    `(${reason})`,
  ].join(" ");
}

export async function serve(options: ServeOptions = {}): Promise<Bun.Server<TerminalSocketData>> {
  const appHtml = await bundledAppHtml();
  const cfg = loadConfig();
  const hostname = process.env.WISP_HOST ?? cfg.host;
  const port = options.port ?? cfg.port;
  // OWNERSHIP FIRST — before the port preflight, before recovery, before any
  // loop. An address being free says nothing about who owns this home: the
  // persisted port can change, WISP_HOST can point elsewhere, and the old
  // check's probe listener was released before recovery ran anyway. A second
  // daemon must lose here, having touched nothing (ENG-02).
  let ownership;
  try {
    ownership = acquireHomeOwnership();
  } catch (error) {
    if (error instanceof HomeBusyError) {
      throw new Error(await homeConflictMessage(hostname, cfg.port, error.message), { cause: error });
    }
    throw error;
  }
  // Every failure from here on releases ownership: a daemon that could not
  // start must not leave the home unopenable.
  try {
    return await serveOwned(options, cfg, hostname, port, appHtml, ownership);
  } catch (error) {
    ownership.release();
    throw error;
  }
}

async function serveOwned(
  options: ServeOptions,
  cfg: WispConfig,
  hostname: string,
  port: number,
  appHtml: string,
  ownership: { release(): void },
): Promise<Bun.Server<TerminalSocketData>> {
  // Hashing 2 MB of bundle is startup work, not per-request work; the policy
  // itself is assembled per response because it names this daemon's origin.
  const securityPolicy = pageSecurityPolicy(appHtml);
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
  const updates = options.updateManager ?? new UpdateManager();
  // P5b loud fallback: only here does the merged adapter set exist to check
  // harnessDefaults against — warn at every boot, never crash
  checkHarnessDefaults(cfg, adapters);
  maintainDiagnosticArchives(cfg);
  // awaited before the port opens: a request must never observe a half-finished sweep
  await recoverOrphanedTurns(adapters, cfg);
  failStaleCreatingTasks(); // a 'creating' row at boot belongs to a dead daemon (a prior audit)
  // An archive whose daemon died mid-teardown left a worktree and attachment
  // bytes behind. The job row that owns that cleanup is resumed here, before
  // the port opens, for the same reason orphaned turns are (ENG-04).
  await resumeArchiveCleanups();

  let server: Bun.Server<TerminalSocketData>;
  try {
    server = Bun.serve({
      port,
      hostname,
      idleTimeout: 30,
      // A deliberate ceiling rather than Bun's 128 MB default. The largest
      // legitimate body is a create/send request carrying base64 attachments,
      // which their own per-file and per-turn caps already bound well below
      // this; anything larger is a mistake or an attempt to make the daemon
      // allocate (ENG-09).
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      websocket: {
        data: {} as TerminalSocketData,
        open(ws) {
          openTerminal(ws);
        },
        message(ws, message) {
          terminalMessage(ws, message, cfg);
        },
        close(ws) {
          clearTerminalAuthDeadline(ws);
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
          return new Response(appHtml as unknown as string, {
            headers: {
              "content-type": "text/html; charset=utf-8",
              ...pageSecurityHeaders(securityPolicy, url.origin),
            },
          });
        }
        if (path === "/api/health") return json({ ok: true, ...BUILD_INFO });
        // the ONLY unauthenticated /api route — it mints the cookie the browser streams authenticate with
        if (path === "/api/session" && req.method === "POST") return postSession(req, cfg);
        if (!path.startsWith("/api/")) return err("not found", 404);
        const terminalMatch = path.match(/^\/api\/tasks\/([a-z0-9]+)\/terminal$/);
        if (terminalMatch && req.method === "GET") {
          const taskId = terminalMatch[1]!;
          // A terminal upgrade is command execution, so it is the one route
          // that must not settle for "the request looked fine". Two gates:
          //
          //   Origin — a browser cannot forge it, so a page on another origin
          //   (another port on this same host included) is refused outright,
          //   before any lookup. `absent` means no browser sent it: the CLI,
          //   or the desktop app's native proxy, and those must carry a bearer
          //   token.
          //
          //   Credential — a browser handshake cannot carry a header, so a
          //   same-origin socket may upgrade unauthenticated and prove itself
          //   in its first frame instead. It attaches to nothing and spawns
          //   nothing until it does.
          const credentialed = authorized(req, cfg);
          const origin = originVerdict(req, url);
          if (origin === "foreign") {
            return err(`terminal upgrades must come from this daemon's own origin, not ${JSON.stringify(req.headers.get("origin"))}`, 403);
          }
          if (!credentialed && origin === "absent") return err("unauthorized", 401);
          // Whether a task exists is only answered to a caller that already
          // proved itself; an unauthenticated socket hears it after the
          // handshake, over the socket, from attachTerminal.
          if (credentialed) {
            const task = getTask(taskId);
            if (!task) return err(`no such task: ${taskId}`, 404);
            if (task.archived) return err(`task ${taskId} is archived — worktree removed`, 409);
            if (!task.worktree_path) return err(`task ${taskId} has no worktree_path`, 409);
          }
          // ?shell=N addresses one of the pane's tabs; absent means the first,
          // which is what every pre-tabs client sent
          const shellParam = url.searchParams.get("shell");
          const shellId = shellParam === null ? 0 : Number(shellParam);
          if (!Number.isInteger(shellId) || shellId < 0 || shellId >= MAX_SHELLS_PER_TASK) {
            return err(`shell must be an integer from 0 to ${MAX_SHELLS_PER_TASK - 1}, got ${JSON.stringify(shellParam)}`, 400);
          }
          // ?cols/?rows is the pane's measured geometry. It arrives with the
          // upgrade so a NEW shell is born at the size that will display it:
          // the first prompt is drawn once, correctly, instead of being drawn
          // at a default width and then redrawn when the client reports in.
          const size = parseTerminalSize(url.searchParams);
          if (typeof size === "string") return err(size, 400);
          if (!server.upgrade(req, { data: { taskId, shellId, size, authenticated: credentialed } })) {
            return err("websocket upgrade failed", 500);
          }
          return undefined;
        }
        if (!authorized(req, cfg)) return err("unauthorized", 401);
        return Promise.resolve()
          .then(() =>
            route(req, url, path, cfg, adapters, modelCache, probeCache, skillCache, compactor, pullRequests, updates),
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
  const outboxTimer = startOutboxLoop(cfg);
  const stuckTimer = startStuckLoop(cfg);
  const cleanupTimer = startArchiveCleanupLoop();
  const stopServer = server.stop.bind(server);
  server.stop = async (closeActiveConnections?: boolean): Promise<void> => {
    clearInterval(outboxTimer);
    clearInterval(stuckTimer);
    clearInterval(cleanupTimer);
    // Ownership ends when this daemon decides to stop, not when its last
    // socket drains: the loops are already cancelled, so nothing here will
    // touch persisted state again, and a shutdown that stalls on a connection
    // must not leave the home unopenable.
    ownership.release();
    await stopServer(closeActiveConnections);
  };
  // Model discovery is deliberately after Bun.serve: listening never waits on
  // a harness CLI, and /api/harnesses serves the cache while this runs.
  void modelCache.refresh();
  console.log(
    `wispd listening on http://${hostname}:${server.port} (token in ${process.env.WISP_HOME ?? "~/.wisp"}/config.json)`,
  );
  return server;
}
