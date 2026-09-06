/**
 * The terminal tab's WebSocket client (S3.5) — a thin, testable wrapper over
 * the daemon's `/api/tasks/:id/terminal?shell=N` socket, plus the small
 * localStorage record of which tabs a task had open. The contract is the
 * daemon handlers in src/daemon.ts:
 *
 *   client → server:  {type:"in", data}                terminal input
 *                     {type:"resize", cols,rows}        after a fit
 *   server → client:  {type:"hello", pty, cwd, replay}  once, right after upgrade
 *                     {type:"out", data}                shell output
 *                     {type:"exit", code}               the shell exited
 *                     {type:"error", message}           a named server error
 *
 * `shell=N` names the tab. Shells live on the DAEMON, keyed by (task, shell),
 * and outlive the socket — so the same N always reattaches to the same
 * process, and `replay` is how a fresh xterm catches up with it.
 *
 * Authentication and target selection belong to the immutable daemon
 * transport. The token NEVER goes in the URL.
 *
 * The generation guard is the classic page's: a stale socket (from a previous
 * task, tab switch, or reconnect) must never write into a new session. Every
 * event checks `current()` before touching the session, and `dispose()`
 * invalidates the generation so late frames from a closing socket are dropped.
 *
 * xterm stays OUT of this module — it deals only in parsed frames, so the
 * wrapper is unit-testable in jsdom with a mock transport.
 */

import { readConnectionStorage, writeConnectionStorage } from "./connection-storage";
import type { DaemonTransport } from "./transport";

export interface TerminalHello {
  pty: boolean;
  cwd: string;
  /**
   * Everything the shell has already printed, capped by the daemon. The shell
   * outlives its socket, so a reattaching tab must RESET its xterm and write
   * this — otherwise it shows a blank screen in front of a running session,
   * and appending instead of resetting would double every line.
   */
  replay: string;
}

/** The parsed server → client frames (the union the daemon actually sends). */
export type TerminalServerFrame =
  | { type: "hello"; pty: boolean; cwd: string; replay?: string }
  | { type: "out"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

export interface TerminalClientHandlers {
  onHello(hello: TerminalHello): void;
  onOutput(data: string): void;
  onExit(code: number): void;
  /** A server-sent {type:"error"} frame, or a client-side protocol violation. */
  onError(message: string): void;
  /** The socket closed; `beforeHello` distinguishes an auth/reject from a live drop. */
  onClose(code: number, beforeHello: boolean): void;
}

/** The minimal socket surface the wrapper needs — a subset of the DOM WebSocket. */
export interface TerminalSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number }) => void) | null;
}

/** The daemon path for one shell tab; the transport chooses its origin. */
export function terminalSocketPath(taskId: string, shellId: number): string {
  return `/api/tasks/${taskId}/terminal?shell=${shellId}`;
}

// WebSocket readyState constants, mirrored so tests need no DOM constants.
const WS_OPEN = 1;
const WS_CLOSING = 2;

/**
 * One terminal connection attempt. Owns its socket and generation; exposes the
 * two client→server sends guarded so they no-op on a stale/closed socket.
 */
export class TerminalConnection {
  private socket: TerminalSocketLike | null = null;
  private helloSeen = false;
  private disposed = false;

  private readonly taskId: string;
  private readonly shellId: number;
  private readonly handlers: TerminalClientHandlers;
  private readonly transport: Pick<DaemonTransport, "openWebSocket">;
  /** The owning component's staleness check — a stale connection ignores every event. */
  private readonly current: () => boolean;

  constructor(
    taskId: string,
    shellId: number,
    handlers: TerminalClientHandlers,
    transport: Pick<DaemonTransport, "openWebSocket">,
    current: () => boolean = () => true,
  ) {
    this.taskId = taskId;
    this.shellId = shellId;
    this.handlers = handlers;
    this.transport = transport;
    this.current = current;
  }

  /** True while this connection is still the live one for its component. */
  private active(): boolean {
    return !this.disposed && this.current();
  }

  connect(): void {
    const socket = this.transport.openWebSocket(
      terminalSocketPath(this.taskId, this.shellId),
    ) as unknown as TerminalSocketLike;
    this.socket = socket;

    socket.onopen = () => {
      // Nothing to render here — the component shows "connecting…" until hello.
    };
    socket.onmessage = (event) => {
      if (!this.active()) return;
      let frame: TerminalServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as TerminalServerFrame;
      } catch {
        this.handlers.onError("terminal protocol error: server sent invalid JSON");
        return;
      }
      if (!frame || typeof frame !== "object") {
        this.handlers.onError("terminal protocol error: server sent a malformed frame");
        return;
      }
      switch (frame.type) {
        case "hello":
          this.helloSeen = true;
          this.handlers.onHello({ pty: frame.pty, cwd: frame.cwd, replay: String(frame.replay ?? "") });
          break;
        case "out":
          this.handlers.onOutput(String(frame.data ?? ""));
          break;
        case "exit":
          this.handlers.onExit(frame.code);
          break;
        case "error":
          this.handlers.onError(String(frame.message ?? "terminal server error"));
          break;
        default:
          this.handlers.onError("terminal protocol error: unknown frame type");
      }
    };
    socket.onerror = () => {
      // onclose follows with the code; the error event carries no detail.
    };
    socket.onclose = (event) => {
      if (!this.active()) return;
      this.handlers.onClose(event.code, !this.helloSeen);
    };
  }

  /** Send terminal input; no-op when stale or not yet open. */
  sendInput(data: string): void {
    if (!this.active() || !this.socket || this.socket.readyState !== WS_OPEN) return;
    this.socket.send(JSON.stringify({ type: "in", data }));
  }

  /** Send a fit-driven resize; no-op when stale or not yet open. */
  sendResize(cols: number, rows: number): void {
    if (!this.active() || !this.socket || this.socket.readyState !== WS_OPEN) return;
    this.socket.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  /**
   * Invalidate the generation and close the socket. Handlers are nulled first so
   * the close event from our own close() is never delivered — a stale socket must
   * not report into a session that has already moved on.
   */
  dispose(): void {
    this.disposed = true;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState < WS_CLOSING) socket.close();
  }
}

/**
 * Which tabs a task had open, remembered across task switches and browser
 * reloads. The SHELLS themselves live on the daemon and survive both already;
 * without this the pane would still forget they existed and leave them running
 * invisibly until the idle GC reaped them.
 *
 * Deliberately not a source of truth: a remembered tab whose shell is gone
 * simply gets a fresh shell on the same id. Storage is a convenience, so every
 * read tolerates absent, unparseable, or wrong-shaped values by returning the
 * default rather than throwing into a render.
 */
export const SHELL_TABS_KEY = "wisp_shell_tabs_v1";
/** Tasks remembered before the oldest entries are dropped — this is a cache, not history. */
export const SHELL_TABS_MAX_TASKS = 50;

export interface ShellTabs {
  /** shell ids, in tab order; always non-empty */
  ids: number[];
  /** the id of the active tab; always one of `ids` */
  active: number;
}

export const DEFAULT_SHELL_TABS: ShellTabs = { ids: [0], active: 0 };

type TabStore = Record<string, ShellTabs>;

const SHELL_TABS_SETTING = "shell_tabs_v1";

function readStore(connectionId: string, storage: Storage): TabStore {
  const raw = readConnectionStorage(connectionId, SHELL_TABS_SETTING, SHELL_TABS_KEY, storage);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: TabStore = {};
  for (const [taskId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const tabs = normalizeTabs(value);
    if (tabs) out[taskId] = tabs;
  }
  return out;
}

/** Accept only a well-shaped, non-empty tab record; anything else is treated as absent. */
function normalizeTabs(value: unknown): ShellTabs | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { ids?: unknown; active?: unknown };
  if (!Array.isArray(record.ids)) return null;
  const ids = [...new Set(record.ids.filter((id): id is number => Number.isInteger(id) && id >= 0))];
  if (ids.length === 0) return null;
  const active = typeof record.active === "number" && ids.includes(record.active) ? record.active : ids[0]!;
  return { ids, active };
}

export function loadShellTabs(connectionId: string, taskId: string, storage: Storage = localStorage): ShellTabs {
  return readStore(connectionId, storage)[taskId] ?? DEFAULT_SHELL_TABS;
}

export function saveShellTabs(
  connectionId: string,
  taskId: string,
  tabs: ShellTabs,
  storage: Storage = localStorage,
): void {
  const normalized = normalizeTabs(tabs);
  if (!normalized) return;
  const store = readStore(connectionId, storage);
  // re-inserting moves the task to the END, so the cap drops the least
  // recently touched task rather than an arbitrary one
  delete store[taskId];
  store[taskId] = normalized;
  const keys = Object.keys(store);
  for (const stale of keys.slice(0, Math.max(0, keys.length - SHELL_TABS_MAX_TASKS))) delete store[stale];
  try {
    writeConnectionStorage(connectionId, SHELL_TABS_SETTING, SHELL_TABS_KEY, JSON.stringify(store), storage);
  } catch {
    // a full or disabled storage costs the memory of the tab list, nothing more
  }
}
