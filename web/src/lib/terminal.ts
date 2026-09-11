/**
 * The terminal tab's WebSocket client (S3.5) — a thin, testable wrapper over
 * the daemon's `/api/tasks/:id/terminal?shell=N&cols=C&rows=R` socket, plus the small
 * localStorage record of which tabs a task had open. The contract is the
 * daemon handlers in src/daemon.ts:
 *
 *   client → server:  {type:"auth", token}               answers auth_required
 *                     {type:"in", data}                 terminal input
 *                     {type:"resize", cols,rows}        after a fit
 *   server → client:  {type:"auth_required"}            prove yourself first
 *                     {type:"hello", pty, cwd, replay}  once, after attaching
 *                     {type:"out", data}                shell output
 *                     {type:"exit", code}               the shell exited
 *                     {type:"error", message}           a named server error
 *
 * `shell=N` names the tab. Shells live on the DAEMON, keyed by (task, shell),
 * and outlive the socket — so the same N always reattaches to the same
 * process, and `replay` is how a fresh xterm catches up with it. `cols`/`rows`
 * ride along on the upgrade because the shell may not exist yet: it is born at
 * the size of the pane that asked for it.
 *
 * Authentication and target selection belong to the immutable daemon
 * transport. The token NEVER goes in the URL — and, since SEC-01, never in an
 * ambient cookie either. A browser cannot put a header on a WebSocket
 * handshake, so the daemon upgrades a same-origin socket with no authority at
 * all, asks for the credential with `auth_required`, and attaches nothing
 * until the reply proves the token. Transports whose hop authenticates
 * upstream (the desktop native proxy) never see that frame: they are already
 * authenticated at the upgrade and get `hello` directly.
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
import type { DaemonRequestOptions, DaemonTransport } from "./transport";

export interface TerminalHello {
  pty: boolean;
  cwd: string;
  /**
   * A snapshot of the shell's screen, as the daemon models it. The shell
   * outlives its socket, so a reattaching tab must RESET its xterm and write
   * this — otherwise it shows a blank screen in front of a running session,
   * and appending instead of resetting would double every line.
   *
   * It describes a screen rather than replaying the bytes that produced one,
   * which is what makes it safe to render at THIS pane's width: cursor moves
   * recorded at some other width would land on the wrong rows here.
   */
  replay: string;
}

/** The parsed server → client frames (the union the daemon actually sends). */
export type TerminalServerFrame =
  | { type: "auth_required" }
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

/**
 * The daemon path for one shell tab; the transport chooses its origin.
 *
 * The pane's measured size travels WITH the upgrade, because the daemon may
 * have to create the shell before it can answer: a shell born at a default
 * width draws its first prompt for a terminal that does not exist, and a
 * prompt theme that fills the line then leaves that first draw stranded on
 * screen. Omitted when the pane has not been measured yet — the daemon falls
 * back to 80x24, exactly as it does for a client too old to send this.
 */
export function terminalSocketPath(taskId: string, shellId: number, size?: TerminalSize | null): string {
  const query = new URLSearchParams({ shell: String(shellId) });
  if (size && size.cols > 0 && size.rows > 0) {
    query.set("cols", String(size.cols));
    query.set("rows", String(size.rows));
  }
  return `/api/tasks/${taskId}/terminal?${query.toString()}`;
}

/** A terminal's geometry in character cells, as the fit addon measures it. */
export interface TerminalSize {
  cols: number;
  rows: number;
}

/** The daemon's origin report — see wispd/src/routes/auth.ts. */
export interface TerminalOriginReport {
  verdict: "absent" | "allowed" | "foreign";
  origin: string | null;
  expected: string;
  allowed: string[];
  reason: string | null;
}

/**
 * Ask the daemon whether it is refusing THIS page's origin, and return the
 * sentence it answers with.
 *
 * A terminal upgrade the daemon refuses at the HTTP layer never becomes a
 * frame: the 403 explains itself in a response body that a browser does not
 * expose to page JavaScript, so the pane sees only a socket that did not open.
 * That is the failure operators land in after putting Wisp behind a proxy
 * that rewrites Host, and the whole rest of the UI keeps working, because
 * everything else authenticates by bearer token and never looks at `Origin`.
 *
 * The probe is a POST for one specific reason: a browser omits `Origin` on a
 * same-origin GET but always sends it on a POST, so the daemon evaluates the
 * exact header the handshake carried. Returns null for anything that is not a
 * clear origin refusal — an unreachable daemon, an older one without the
 * route, or a page whose origin is fine — so the caller keeps its own
 * explanation for those.
 *
 * Only asked of a transport that authenticates the socket IN BAND, which is
 * the one whose handshake a browser sends `Origin` on. The desktop proxy
 * strips it and carries its own credential, so its terminal sockets are never
 * origin-refused and the question has no answer there.
 */
export async function terminalOriginRefusal(transport: {
  /**
   * `DaemonTransport["request"]`, but not generic — the answer is validated
   * here rather than asserted, so a caller (and a test) needs nothing more
   * than something that returns the daemon's JSON.
   */
  request(path: string, options?: DaemonRequestOptions): Promise<unknown>;
  socketToken?(): string | null;
}): Promise<string | null> {
  if (!transport.socketToken) return null;
  let body: unknown;
  try {
    body = await transport.request("/api/terminal-origin", { method: "POST" });
  } catch {
    return null;
  }
  const report = body as Partial<TerminalOriginReport> | null;
  return report?.verdict === "foreign" && typeof report.reason === "string" ? report.reason : null;
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
  private readonly size: TerminalSize | null;
  private readonly handlers: TerminalClientHandlers;
  private readonly transport: Pick<DaemonTransport, "openWebSocket" | "socketToken">;
  /** The owning component's staleness check — a stale connection ignores every event. */
  private readonly current: () => boolean;

  constructor(
    taskId: string,
    shellId: number,
    handlers: TerminalClientHandlers,
    transport: Pick<DaemonTransport, "openWebSocket" | "socketToken">,
    current: () => boolean = () => true,
    size: TerminalSize | null = null,
  ) {
    this.taskId = taskId;
    this.shellId = shellId;
    this.size = size;
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
      terminalSocketPath(this.taskId, this.shellId, this.size),
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
        case "auth_required": {
          // The daemon will not attach this socket until it is proved. A
          // transport with no in-band credential cannot answer, and saying so
          // is better than waiting out the daemon's handshake deadline.
          const token = this.transport.socketToken?.() ?? null;
          if (token === null) {
            this.handlers.onError("terminal: this daemon asked for a token this connection cannot provide");
            break;
          }
          socket.send(JSON.stringify({ type: "auth", token }));
          break;
        }
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
